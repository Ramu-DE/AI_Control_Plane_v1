// Offline tests: delegation (subset + confused-deputy denial), interceptors
// (FGAC/filter/mask/exchange), and the tamper-evident audit hash chain.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authorizeDelegation,
  effectiveScopes,
} from "../src/lib/identity/delegation.ts";
import { maskPii, runInterceptors } from "../src/lib/identity/interceptors.ts";
import {
  appendIdentityAudit,
  verifyChain,
} from "../src/lib/identity/audit.ts";
import type {
  DelegationPolicy,
  IdentityAuditEvent,
  InterceptorInput,
} from "../src/lib/identity/types.ts";

const policy: DelegationPolicy = {
  id: "pol-1",
  allow: [
    { fromAgent: "orchestrator", toAgent: "reader" },
    { fromAgent: "reader", toAgent: "summarizer" },
  ],
};

test("delegation: scope shrinks at every hop → authorized", () => {
  const r = authorizeDelegation(
    {
      rootUserSub: "maria",
      rootScopes: ["read", "write", "admin"],
      hops: [
        { fromAgent: "orchestrator", toAgent: "reader", scopes: ["read", "write"], authorizedByPolicyId: "pol-1" },
        { fromAgent: "reader", toAgent: "summarizer", scopes: ["read"], authorizedByPolicyId: "pol-1" },
      ],
    },
    policy
  );
  assert.equal(r.authorized, true, r.reasons.join("; "));
  assert.equal(r.chain!.hops.every((h) => h.userSub === "maria"), true);
  assert.deepEqual(effectiveScopes(r.chain!), ["read"]);
});

test("delegation: child widening scope is denied (confused deputy)", () => {
  const r = authorizeDelegation(
    {
      rootUserSub: "maria",
      rootScopes: ["read"],
      hops: [
        { fromAgent: "orchestrator", toAgent: "reader", scopes: ["read"], authorizedByPolicyId: "pol-1" },
        { fromAgent: "reader", toAgent: "summarizer", scopes: ["read", "write"], authorizedByPolicyId: "pol-1" },
      ],
    },
    policy
  );
  assert.equal(r.authorized, false);
  assert.match(r.reasons.join(" "), /confused-deputy|exceed/);
});

test("delegation: hop exceeding the user's own scopes is denied", () => {
  // The agent 'reader' might itself hold 'admin', but the ceiling is the USER.
  const r = authorizeDelegation(
    {
      rootUserSub: "maria",
      rootScopes: ["read"],
      hops: [
        { fromAgent: "orchestrator", toAgent: "reader", scopes: ["admin"], authorizedByPolicyId: "pol-1" },
      ],
    },
    policy
  );
  assert.equal(r.authorized, false);
});

test("delegation: unauthorized agent pair is denied", () => {
  const r = authorizeDelegation(
    {
      rootUserSub: "maria",
      rootScopes: ["read"],
      hops: [
        { fromAgent: "orchestrator", toAgent: "payments", scopes: ["read"], authorizedByPolicyId: "pol-1" },
      ],
    },
    policy
  );
  assert.equal(r.authorized, false);
  assert.match(r.reasons.join(" "), /not authorized by policy/);
});

// ---- interceptors ----
const baseInput: InterceptorInput = {
  agentId: "agent-1",
  tool: "summarizeInbox",
  userSub: "john",
  callerScopes: ["Mail.Read"],
  requiredScope: "Mail.Read",
  payload: { subject: "Hi", email: "john@corp.com", body: "ok", nested: { phone: "123456789" } },
};

test("interceptors: FGAC denies when scope missing", () => {
  const r = runInterceptors(
    { ...baseInput, callerScopes: [] },
    { toolAllowlist: ["summarizeInbox"], exchangeToken: true }
  );
  assert.equal(r.allowed, false);
  assert.equal(r.stages[0].stage, "fgac");
  assert.equal(r.stages[0].passed, false);
});

test("interceptors: tool-filter denies non-allowlisted tool", () => {
  const r = runInterceptors(
    { ...baseInput, tool: "deleteEverything" },
    { toolAllowlist: ["summarizeInbox"], exchangeToken: false }
  );
  assert.equal(r.allowed, false);
  assert.equal(r.stages.find((s) => s.stage === "tool-filter")!.passed, false);
});

test("interceptors: passes, masks PII, exchanges token", () => {
  const r = runInterceptors(baseInput, { toolAllowlist: ["summarizeInbox"], exchangeToken: true });
  assert.equal(r.allowed, true);
  assert.notEqual(r.maskedPayload!.email, "john@corp.com");
  assert.equal(r.maskedPayload!.body, "ok"); // non-PII preserved
  assert.equal((r.maskedPayload!.nested as Record<string, unknown>).phone !== "123456789", true);
  assert.ok(r.exchangedHandle);
});

test("maskPii masks nested PII fields", () => {
  const { maskedFields } = maskPii({ name: "John", meta: { ssn: "111" }, ok: "x" });
  assert.ok(maskedFields.includes("name"));
  assert.ok(maskedFields.includes("meta.ssn"));
  assert.ok(!maskedFields.includes("ok"));
});

// ---- audit hash chain ----
test("audit chain is append-only and tamper-evident", () => {
  const chain: IdentityAuditEvent[] = [];
  appendIdentityAudit(chain, { id: "e1", action: "a", actor: "x", detail: "d1", attribution: { agentId: "agent-1" }, at: "t1" });
  appendIdentityAudit(chain, { id: "e2", action: "b", actor: "y", detail: "d2", attribution: { humanSub: "john", agentId: "agent-1", act: "agent" }, at: "t2" });
  assert.equal(chain[0].prevHash, "");
  assert.equal(chain[1].prevHash, chain[0].hash);
  assert.equal(verifyChain(chain).valid, true);

  // tamper with an earlier event → chain breaks.
  chain[0].detail = "TAMPERED";
  const v = verifyChain(chain);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 0);
});

test("audit events carry human+agent+session+delegation attribution", () => {
  const chain: IdentityAuditEvent[] = [];
  const e = appendIdentityAudit(chain, {
    id: "e1",
    action: "vault-issue",
    actor: "john",
    detail: "issued OBO token",
    attribution: { humanSub: "john", agentId: "agent-1", sessionId: "sess-1", delegationChainId: "chain-1", act: "agent" },
    at: "t1",
  });
  assert.equal(e.attribution.humanSub, "john");
  assert.equal(e.attribution.agentId, "agent-1");
  assert.equal(e.attribution.sessionId, "sess-1");
  assert.equal(e.attribution.delegationChainId, "chain-1");
  assert.equal(e.attribution.act, "agent");
});
