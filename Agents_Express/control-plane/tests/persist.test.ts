// Offline tests for the durable store.
//
// The store was a plain object on globalThis, mutated directly from ~40 places,
// and every restart wiped it. That cost real work twice in one session.
//
// Persistence is a deep change-tracking Proxy plus a debounced atomic write,
// chosen so that NO existing mutation site had to change — an explicit
// `persist()` at each one would be 40 chances to forget, and the failure is
// silent until a restart loses exactly the records nobody saved.
//
// The Proxy is the risky part, so most of this file is about it behaving like a
// plain object. The specific hazards:
//
//   - identity: two reads of the same element must be `===`, or `indexOf`,
//     `splice(arr.indexOf(x), 1)` and every identity comparison break
//   - array mutators must mark dirty, including `pop()` on an empty array
//   - `Array.isArray`, spread, JSON round-trip and iteration must still work
//   - a no-op write (`x.a = x.a`) must not trigger a flush
//
// And the durability hazards: an atomic write, a corrupt snapshot that must
// not stop the platform booting, and a schema mismatch that must NOT be
// half-migrated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCHEMA_VERSION,
  capLog,
  createPersister,
  loadSnapshot,
  trackChanges,
  writeSnapshot,
} from "../src/lib/persist.ts";

function tmpFile(name = "store.json"): string {
  return join(mkdtempSync(join(tmpdir(), "cp-persist-")), name);
}

// --------------------------------------------------------------------------- //
// The Proxy must behave like a plain object
// --------------------------------------------------------------------------- //
test("reading the same element twice gives the SAME object", () => {
  // Without a per-target proxy cache these would be two different Proxies and
  // `===` would be false, quietly breaking indexOf and every identity check.
  const state = { agents: [{ id: "a1", status: "draft" }] };
  const tracked = trackChanges(state, () => {});
  assert.equal(tracked.agents[0], tracked.agents[0]);
  assert.equal(tracked.agents.indexOf(tracked.agents[0]), 0);
  assert.ok(tracked.agents.includes(tracked.agents[0]));
});

test("splice(indexOf(x), 1) removes the right element", () => {
  const state = { records: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] };
  let dirty = 0;
  const tracked = trackChanges(state, () => { dirty += 1; });
  const victim = tracked.records[1];
  tracked.records.splice(tracked.records.indexOf(victim), 1);
  assert.deepEqual(state.records.map((r) => r.id), ["r1", "r3"]);
  assert.ok(dirty > 0, "and the removal marked the store dirty");
});

test("arrays still look and behave like arrays", () => {
  const state = { xs: [1, 2, 3] };
  const tracked = trackChanges(state, () => {});
  assert.ok(Array.isArray(tracked.xs));
  assert.equal(tracked.xs.length, 3);
  assert.deepEqual([...tracked.xs], [1, 2, 3]);
  assert.deepEqual(tracked.xs.map((n) => n * 2), [2, 4, 6]);
  assert.deepEqual(tracked.xs.filter((n) => n > 1), [2, 3]);
  assert.equal(tracked.xs.find((n) => n === 2), 2);
  let seen = 0;
  for (const _ of tracked.xs) seen += 1;
  assert.equal(seen, 3);
});

test("JSON round-trips through the proxy unchanged", () => {
  const state = { a: [{ id: "x", nested: { deep: [1, 2] } }] };
  const tracked = trackChanges(state, () => {});
  assert.deepEqual(JSON.parse(JSON.stringify(tracked)), state);
});

test("a nested in-place field edit marks dirty", () => {
  // This is the pattern persistence had to catch and an explicit save would
  // have missed: `transitionPeer` does exactly this.
  const state = { peers: [{ peerId: "p1", status: "Draft", rev: 1 }] };
  let dirty = 0;
  const tracked = trackChanges(state, () => { dirty += 1; });
  const peer = tracked.peers.find((p) => p.peerId === "p1")!;
  peer.status = "Approved";
  peer.rev += 1;
  assert.equal(dirty, 2);
  assert.equal(state.peers[0].status, "Approved", "and the RAW state changed");
  assert.equal(state.peers[0].rev, 2);
});

test("every mutating array method marks dirty", () => {
  for (const op of ["push", "unshift", "splice", "sort", "reverse"] as const) {
    const state = { xs: [3, 1, 2] };
    let dirty = 0;
    const tracked = trackChanges(state, () => { dirty += 1; });
    if (op === "push") tracked.xs.push(4);
    else if (op === "unshift") tracked.xs.unshift(0);
    else if (op === "splice") tracked.xs.splice(0, 1);
    else if (op === "sort") tracked.xs.sort();
    else tracked.xs.reverse();
    assert.ok(dirty > 0, `${op} must mark dirty`);
  }
});

test("pop on an EMPTY array still marks dirty", () => {
  // It writes no index, so the `set` trap never fires — the method wrapper is
  // what catches it. Removing that wrapper would leave this case silent.
  const state = { xs: [] as number[] };
  let dirty = 0;
  const tracked = trackChanges(state, () => { dirty += 1; });
  tracked.xs.pop();
  assert.equal(dirty, 1);
});

test("a no-op write does not mark dirty", () => {
  const state = { a: { n: 1 } };
  let dirty = 0;
  const tracked = trackChanges(state, () => { dirty += 1; });
  tracked.a.n = 1;
  assert.equal(dirty, 0, "writing the same value is not a change");
  tracked.a.n = 2;
  assert.equal(dirty, 1);
});

test("deleting a property marks dirty", () => {
  const state: { a?: number; b: number } = { a: 1, b: 2 };
  let dirty = 0;
  const tracked = trackChanges(state, () => { dirty += 1; });
  delete tracked.a;
  assert.equal(dirty, 1);
  assert.equal("a" in state, false);
});

test("a Date survives the proxy as a Date", () => {
  // Proxying exotic objects breaks internal-slot access, so they are skipped.
  const when = new Date("2026-10-23T00:00:00Z");
  const tracked = trackChanges({ when }, () => {});
  assert.ok(tracked.when instanceof Date);
  assert.equal(tracked.when.toISOString(), "2026-10-23T00:00:00.000Z");
});

// --------------------------------------------------------------------------- //
// Snapshot I/O
// --------------------------------------------------------------------------- //
test("a written snapshot reloads identically", () => {
  const path = tmpFile();
  const state = { agents: [{ id: "a1" }], audit: [] as unknown[] };
  writeSnapshot(state, path);
  const loaded = loadSnapshot<typeof state>(path);
  assert.deepEqual(loaded.state, state);
  assert.match(loaded.reason, /restored from/);
});

test("the write is atomic — no .tmp file is left behind", () => {
  const path = tmpFile();
  writeSnapshot({ x: 1 }, path);
  const files = readdirSync(join(path, ".."));
  assert.deepEqual(files, ["store.json"],
    `a leftover temp file means the rename did not happen: ${files.join(", ")}`);
});

test("a missing snapshot is reported, not thrown", () => {
  const loaded = loadSnapshot(tmpFile("absent.json"));
  assert.equal(loaded.state, null);
  assert.match(loaded.reason, /no snapshot/);
});

test("a corrupt snapshot does not stop the platform booting", () => {
  const path = tmpFile();
  writeFileSync(path, "{ this is not json", "utf8");
  const loaded = loadSnapshot(path);
  assert.equal(loaded.state, null, "seed instead of throwing");
  assert.match(loaded.reason, /not valid JSON/);
  assert.ok(existsSync(path), "and the bad file is kept for inspection");
});

test("a schema mismatch seeds rather than half-migrating", () => {
  const path = tmpFile();
  writeFileSync(path, JSON.stringify({
    schemaVersion: SCHEMA_VERSION + 99, savedAt: "", state: { agents: [] },
  }), "utf8");
  const loaded = loadSnapshot(path);
  assert.equal(loaded.state, null);
  assert.match(loaded.reason, /schema is v/);
  assert.match(loaded.reason, /half-migrating/);
});

test("a snapshot with no state object is refused", () => {
  const path = tmpFile();
  writeFileSync(path, JSON.stringify({ schemaVersion: SCHEMA_VERSION }), "utf8");
  assert.equal(loadSnapshot(path).state, null);
});

// --------------------------------------------------------------------------- //
// The persister
// --------------------------------------------------------------------------- //
test("mutations coalesce into one write", () => {
  const path = tmpFile();
  const state = { xs: [] as number[] };
  const p = createPersister({ getState: () => state, path, debounceMs: 1000 });
  const tracked = trackChanges(state, p.markDirty);
  for (let i = 0; i < 50; i++) tracked.xs.push(i);
  assert.equal(p.stats().writes, 0, "nothing written yet — still debouncing");
  assert.equal(p.stats().dirty, true);
  p.flush();
  assert.equal(p.stats().writes, 1, "fifty mutations, one write");
  assert.deepEqual(loadSnapshot<typeof state>(path).state!.xs.length, 50);
});

test("flush is a no-op when nothing changed", () => {
  const path = tmpFile();
  const p = createPersister({ getState: () => ({ a: 1 }), path, debounceMs: 10 });
  p.flush();
  assert.equal(p.stats().writes, 0, "an idle platform must not rewrite the file");
});

test("the state is read at FLUSH time, not at mark time", () => {
  // Otherwise a mutation arriving between markDirty and the write is lost.
  const path = tmpFile();
  const state = { xs: [1] };
  const p = createPersister({ getState: () => state, path, debounceMs: 1000 });
  const tracked = trackChanges(state, p.markDirty);
  tracked.xs.push(2);
  tracked.xs.push(3);
  p.flush();
  assert.deepEqual(loadSnapshot<typeof state>(path).state!.xs, [1, 2, 3]);
});

test("a failed write keeps the state dirty so it retries", () => {
  // Durability can be lost temporarily; correctness of the in-memory store
  // cannot, so a write failure must not throw into the request.
  const events: string[] = [];
  const p = createPersister({
    getState: () => ({ a: 1 }),
    // A directory that cannot be created: a path under a regular file.
    path: (() => {
      const f = tmpFile("blocker");
      writeFileSync(f, "x", "utf8");
      return join(f, "nested", "store.json");
    })(),
    debounceMs: 1000,
    onEvent: (m) => events.push(m),
  });
  p.markDirty();
  p.flush();
  const s = p.stats();
  assert.equal(s.writes, 0);
  assert.equal(s.failures, 1);
  assert.equal(s.dirty, true, "still dirty, so a later flush retries");
  assert.match(events[0] ?? "", /FAILED/);
});

// --------------------------------------------------------------------------- //
// Audit capping
// --------------------------------------------------------------------------- //
test("capLog drops the oldest entries and reports how many", () => {
  const items = Array.from({ length: 10 }, (_, i) => i); // newest-first
  assert.equal(capLog(items, 10), 0, "at the cap, nothing is dropped");
  assert.equal(capLog(items, 4), 6);
  assert.deepEqual(items, [0, 1, 2, 3], "the newest are kept");
});

test("capLog is a no-op below the cap", () => {
  const items = [1, 2, 3];
  assert.equal(capLog(items, 100), 0);
  assert.deepEqual(items, [1, 2, 3]);
});

// --------------------------------------------------------------------------- //
// Against the real store
// --------------------------------------------------------------------------- //
test("the real store is durable and reports its snapshot state", async () => {
  const { store, storeDurability, flushStore } = await import("../src/lib/store.ts");
  const d = storeDurability();
  assert.equal(d.schemaVersion, SCHEMA_VERSION);
  assert.ok(d.path.endsWith(".json"), `snapshot path looks wrong: ${d.path}`);
  assert.ok(typeof d.bootNote === "string" && d.bootNote.length > 0,
    "booting must say whether it restored or seeded");

  // A mutation through the real store must mark it dirty.
  const before = storeDurability().writes;
  store.audit.unshift({
    id: "evt-persist-test", category: "policy", action: "test",
    actor: "test", detail: "persistence probe", at: new Date().toISOString(),
  } as never);
  flushStore();
  assert.ok(storeDurability().writes > before,
    "a mutation through `store` must reach the snapshot");
  assert.ok(existsSync(storeDurability().path), "and the file must exist");
  const raw = JSON.parse(readFileSync(storeDurability().path, "utf8"));
  assert.equal(raw.schemaVersion, SCHEMA_VERSION);
  assert.ok(
    raw.state.audit.some((e: { id: string }) => e.id === "evt-persist-test"),
    "the probe entry must be in the file"
  );
});

test("the snapshot holds no credential VALUES, only env var names", async () => {
  const { storeDurability, flushStore } = await import("../src/lib/store.ts");
  flushStore();
  const raw = readFileSync(storeDurability().path, "utf8");
  // Writing the store to disk is a new exposure surface, so this asserts the
  // property the registry design relies on: records carry `tokenEnvVar`
  // NAMES, never values.
  for (const secret of ["AKIA", "ASIA", "dapi", "sk-", "BEGIN PRIVATE KEY"]) {
    assert.ok(!raw.includes(secret),
      `snapshot appears to contain a credential-shaped string: ${secret}`);
  }
});
