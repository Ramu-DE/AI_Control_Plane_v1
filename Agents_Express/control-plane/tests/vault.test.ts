// Offline tests: token vault (TTL, JIT/session binding, one-time refresh +
// replay, revocation, composite-key isolation) and workload identity lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getActive,
  issue,
  keysEqual,
  revokeByEvent,
  rotateRefresh,
} from "../src/lib/identity/vault.ts";
import {
  createWorkloadIdentity,
  revokeWorkloadIdentity,
  rotateWorkloadIdentity,
} from "../src/lib/identity/workloadIdentity.ts";
import { SIMULATED } from "../src/lib/identity/types.ts";
import type {
  Session,
  SimulatedClaims,
  VaultKey,
} from "../src/lib/identity/types.ts";

function session(over: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: over.id ?? "sess-1",
    userSub: over.userSub ?? "user-maria",
    agentId: over.agentId ?? "agent-1",
    startedAt: new Date(now).toISOString(),
    expiresAt: over.expiresAt ?? new Date(now + 600_000).toISOString(),
    active: over.active ?? true,
  };
}

const key: VaultKey = {
  tenantId: "t1",
  agentId: "agent-1",
  userSub: "user-maria",
  resource: "finance-api",
};

const claims: SimulatedClaims = {
  sub: "user-maria",
  act: "agent",
  cid: "client-abc",
  aud: "finance-api",
  scope: "spend.read",
  marker: SIMULATED,
};

test("issue requires an active session (JIT, no standing access)", () => {
  const r = issue({ key, pattern: "obo", scopes: ["spend.read"], ttlSeconds: 300, session: null, claims, withRefresh: true });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /JIT/);
});

test("issue rejects ttl > 900s (short-lived only)", () => {
  const r = issue({ key, pattern: "obo", scopes: ["spend.read"], ttlSeconds: 3600, session: session(), claims, withRefresh: true });
  assert.equal(r.ok, false);
});

test("issue succeeds, entry stores NO raw token, carries sub+act", () => {
  const r = issue({ key, pattern: "obo", scopes: ["spend.read"], ttlSeconds: 300, session: session(), claims, withRefresh: true });
  assert.equal(r.ok, true);
  const e = r.entry!;
  // metadata-only invariant: no "token"/"secret"/"accessToken" fields exist.
  const json = JSON.stringify(e);
  assert.ok(!/"token"\s*:/.test(json));
  assert.ok(!/"accessToken"/.test(json));
  assert.ok(!/"secret"/.test(json));
  assert.equal(e.claims.sub, "user-maria");
  assert.equal(e.claims.act, "agent");
  assert.equal(e.claims.marker, SIMULATED);
  assert.ok(e.handle.startsWith("tok_"));
});

test("getActive denies after TTL expiry", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const r = issue({ key, pattern: "m2m", scopes: ["x"], ttlSeconds: 1, session: session(), claims, withRefresh: false });
  const e = r.entry!;
  e.expiresAt = past; // simulate elapsed TTL
  const chk = getActive(e, [session()]);
  assert.equal(chk.active, false);
  assert.match(chk.reason!, /TTL|expired/);
});

test("getActive denies when bound session is inactive (revocation event)", () => {
  const r = issue({ key, pattern: "obo", scopes: ["spend.read"], ttlSeconds: 300, session: session(), claims, withRefresh: true });
  const e = r.entry!;
  const chk = getActive(e, [session({ active: false })]);
  assert.equal(chk.active, false);
});

test("one-time refresh rotates; replay is detected and revokes lineage", () => {
  const r = issue({ key, pattern: "3lo", scopes: ["repo"], ttlSeconds: 300, session: session(), claims, withRefresh: true });
  const e = r.entry!;
  const rh = e.refreshHandle!;

  const rot = rotateRefresh(e, rh);
  assert.equal(rot.ok, true);
  const rotated = rot.rotated!;
  assert.equal(rotated.lineageId, e.lineageId, "lineage preserved across rotation");
  assert.notEqual(rotated.refreshHandle, rh, "new refresh handle minted");

  // mark the original consumed (as the store would) then replay it.
  e.refreshConsumed = true;
  const replay = rotateRefresh(e, rh);
  assert.equal(replay.ok, false);
  assert.equal(replay.replayDetected, true);
  assert.equal(replay.revokeLineageId, e.lineageId);
});

test("composite-key isolation: entries differ by user", () => {
  const a: VaultKey = { ...key, userSub: "user-a" };
  const b: VaultKey = { ...key, userSub: "user-b" };
  assert.equal(keysEqual(a, b), false);
  assert.equal(keysEqual(a, { ...a }), true);
});

test("revokeByEvent by lineage revokes every entry in the chain", () => {
  const s = session();
  const e1 = issue({ key, pattern: "obo", scopes: ["spend.read"], ttlSeconds: 300, session: s, claims, withRefresh: true }).entry!;
  const e2 = issue({ key, pattern: "obo", scopes: ["spend.read"], ttlSeconds: 300, session: s, claims, withRefresh: true }).entry!;
  e2.lineageId = e1.lineageId; // same lineage
  const revoked = revokeByEvent([e1, e2], { by: "lineage", lineageId: e1.lineageId });
  assert.equal(revoked.length, 2);
  assert.equal(e1.revoked, true);
  assert.equal(e2.revoked, true);
});

test("revokeByEvent by user only touches that user's entries", () => {
  const s = session();
  const mine = issue({ key, pattern: "obo", scopes: ["spend.read"], ttlSeconds: 300, session: s, claims, withRefresh: true }).entry!;
  const other = issue({ key: { ...key, userSub: "user-other" }, pattern: "obo", scopes: ["spend.read"], ttlSeconds: 300, session: session({ userSub: "user-other" }), claims, withRefresh: true }).entry!;
  const revoked = revokeByEvent([mine, other], { by: "user", userSub: "user-maria" });
  assert.deepEqual(revoked, [mine.id]);
  assert.equal(other.revoked, false);
});

// ---- workload identity lifecycle ----
test("workload identity: create carries no secret value, only a reference", () => {
  const w = createWorkloadIdentity("agent-1");
  assert.equal(w.status, "active");
  assert.ok(w.clientId.length > 0);
  assert.match(w.secretRef, /^arn:aws:secretsmanager:/);
  // secretRef is a reference, not a value — assert it is not a plausible secret.
  assert.ok(!/password|=|BEGIN/.test(w.secretRef));
});

test("workload identity: rotate mints a new reference, keeps clientId", () => {
  const w = createWorkloadIdentity("agent-1");
  const r = rotateWorkloadIdentity(w);
  assert.equal(r.clientId, w.clientId);
  assert.notEqual(r.secretRef, w.secretRef);
  assert.ok(r.rotatedAt);
});

test("workload identity: cannot rotate once revoked", () => {
  const w = revokeWorkloadIdentity(createWorkloadIdentity("agent-1"));
  assert.throws(() => rotateWorkloadIdentity(w));
});
