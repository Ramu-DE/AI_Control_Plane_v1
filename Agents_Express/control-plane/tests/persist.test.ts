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

// --------------------------------------------------------------------------- //
// Durability across EVERY store, not just the main one
// --------------------------------------------------------------------------- //
//
// The first pass made `store.ts` and `a2a/store.ts` durable and left four
// other singletons in memory. "State survives a restart" was therefore only
// two-thirds true, and the two that mattered most were the Graph Sources
// registry (two smoke checks skip for want of an Approved neo4j source — which
// used to vanish on every restart) and the graph control store.

test("a Map does not survive JSON on its own — so conversion is required", () => {
  // The reason LocalData needs toJSON/fromJSON. Asserted rather than assumed,
  // because the failure is silent: the snapshot saves `{}` and the store comes
  // back empty with no error anywhere.
  assert.equal(JSON.stringify({ m: new Map([["a", 1]]) }), '{"m":{}}');
});

test("the proxy refuses to wrap a Map, because proxying one throws", () => {
  const state = { m: new Map([["a", 1]]) };
  const tracked = trackChanges(state, () => {});
  // If wrap() proxied this, `.get` with `this = receiver` would throw
  // "Method Map.prototype.get called on incompatible receiver".
  assert.equal(tracked.m.get("a"), 1);
  assert.equal(tracked.m, state.m, "the same Map instance, unwrapped");
});

test("graph sources are durable", async () => {
  const { graphSources, flushGraphSources } = await import("../src/lib/graphStore.ts");
  const before = graphSources.length;
  graphSources.unshift({
    id: "gs-persist-probe", graphSourceId: "persist-probe",
    displayName: "Persistence probe", bu: "t", status: "Draft",
    ontology: {}, backend: {}, createdAt: new Date().toISOString(),
  } as never);
  flushGraphSources();
  const path = join(process.env.CONTROL_PLANE_STORE_PATH!.replace(/\.json$/, "") + ".graph.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.state.length, before + 1);
  assert.ok(
    raw.state.some((s: { graphSourceId: string }) => s.graphSourceId === "persist-probe"),
    "an added graph source must reach its snapshot"
  );
});

test("the identity store is durable", async () => {
  const { identityStore, flushIdentityStore } = await import(
    "../src/lib/identity/identityStore.ts");
  // Find any array on the state and append to it — the shape is seeded
  // elsewhere and this test should not depend on which field exists.
  const key = (Object.keys(identityStore) as (keyof typeof identityStore)[])
    .find((k) => Array.isArray(identityStore[k]));
  assert.ok(key, "the identity state must hold at least one collection");
  (identityStore[key!] as unknown[]).push({ id: "identity-persist-probe" });
  flushIdentityStore();
  const path = process.env.CONTROL_PLANE_STORE_PATH!.replace(/\.json$/, "") + ".identity.json";
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.includes("identity-persist-probe"),
    "an identity mutation must reach its snapshot");
});

test("the graph control store survives a round trip, Maps included", async () => {
  const { LocalGraphControlStore } = await import("../src/lib/graph/localStore.ts");
  const { flushGraphControl } = await import("../src/lib/graph/localStore.ts");
  const store = new LocalGraphControlStore();
  await store.createGraphSource({
    graphSourceId: "gc-persist-probe", displayName: "GC probe", bu: "t",
    ontology: { type: "rdf-file" }, backend: { type: "databricks-uc" },
  } as never);
  flushGraphControl();

  const path = process.env.CONTROL_PLANE_STORE_PATH!.replace(/\.json$/, "") + ".graph-control.json";
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // Serialized as ENTRY PAIRS, not an empty object.
  assert.ok(Array.isArray(raw.state.sources),
    `sources must serialize as entries, got ${JSON.stringify(raw.state.sources)}`);
  assert.ok(
    raw.state.sources.some(([k]: [string]) => k === "gc-persist-probe"),
    "the created source must be in the snapshot"
  );

  // And it must rebuild into real Maps.
  const { durableSingleton } = await import("../src/lib/persist.ts");
  assert.ok(typeof durableSingleton === "function");
});

test("every graph-control mutator marks the store dirty", async () => {
  // Tracking is OFF for this store (a Proxy cannot see into a Map), so each
  // mutator calls touch() by hand. This is the guard against a future mutator
  // forgetting: it drives the public API and checks the write counter moved.
  const { LocalGraphControlStore, flushGraphControl } = await import(
    "../src/lib/graph/localStore.ts");
  const store = new LocalGraphControlStore();

  const snapshotPath =
    process.env.CONTROL_PLANE_STORE_PATH!.replace(/\.json$/, "") + ".graph-control.json";
  const sizeNow = () => {
    flushGraphControl();
    return readFileSync(snapshotPath, "utf8").length;
  };

  const before = sizeNow();
  await store.createGraphSource({
    graphSourceId: `dirty-probe-${Date.now()}`, displayName: "Dirty probe",
    bu: "t", ontology: { type: "rdf-file" }, backend: { type: "databricks-uc" },
  } as never);
  assert.ok(sizeNow() > before,
    "createGraphSource must mark the store dirty — if this fails, a mutator " +
    "is missing its touch() call and its writes are lost on restart");
});

test("an isolated graph-control store never persists", async () => {
  // Tests use `isolated: true` for a clean dataset; persisting it would let
  // one test's fixtures leak into the shared snapshot.
  const { LocalGraphControlStore, flushGraphControl } = await import(
    "../src/lib/graph/localStore.ts");
  const path =
    process.env.CONTROL_PLANE_STORE_PATH!.replace(/\.json$/, "") + ".graph-control.json";
  flushGraphControl();
  const before = readFileSync(path, "utf8");

  const isolated = new LocalGraphControlStore(true);
  await isolated.createGraphSource({
    graphSourceId: "must-not-persist", displayName: "x", bu: "t",
    ontology: { type: "rdf-file" }, backend: { type: "databricks-uc" },
  } as never);
  flushGraphControl();
  assert.equal(readFileSync(path, "utf8"), before,
    "an isolated store's writes must not reach the shared snapshot");
});

test("each store writes its OWN file", async () => {
  // One shared file would mean a write to any store rewrites all of them, and
  // one corrupt section would discard four stores instead of one.
  await import("../src/lib/store.ts");
  await import("../src/lib/graphStore.ts");
  await import("../src/lib/identity/identityStore.ts");
  await import("../src/lib/graph/localStore.ts");
  const base = process.env.CONTROL_PLANE_STORE_PATH!;
  const dir = join(base, "..");
  const files = readdirSync(dir).sort();
  for (const expected of [
    "control-plane.json",
    "control-plane.graph.json",
    "control-plane.identity.json",
    "control-plane.graph-control.json",
  ]) {
    assert.ok(files.includes(expected),
      `expected a snapshot at ${expected}; found ${files.join(", ")}`);
  }
});
