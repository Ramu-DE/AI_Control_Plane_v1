// Offline tests: inbound SigV4/OIDC validation + outbound pattern planning.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  simulateSigV4,
  validateInbound,
  validateOidcJwt,
} from "../src/lib/identity/inbound.ts";
import { hasConsent, planOutbound } from "../src/lib/identity/outbound.ts";
import type { OutboundContext } from "../src/lib/identity/outbound.ts";
import { SIMULATED } from "../src/lib/identity/types.ts";
import type {
  ConsentGrant,
  InboundOidcConfig,
  SimulatedDecodedJwt,
  ToolAuthBinding,
} from "../src/lib/identity/types.ts";

// ---- inbound SigV4 ----
test("SigV4 matches an allowed principal ARN pattern", () => {
  const r = simulateSigV4(
    "arn:aws:iam::123456789012:role/EventBridge-Scheduler-nightly",
    "arn:aws:iam::*:role/EventBridge-Scheduler-*"
  );
  assert.equal(r.valid, true);
  assert.equal(r.principal, "arn:aws:iam::123456789012:role/EventBridge-Scheduler-nightly");
});

test("SigV4 rejects a non-matching ARN", () => {
  const r = simulateSigV4(
    "arn:aws:iam::123456789012:role/SomeOtherRole",
    "arn:aws:iam::*:role/EventBridge-Scheduler-*"
  );
  assert.equal(r.valid, false);
});

test("SigV4 rejects a non-ARN principal", () => {
  const r = simulateSigV4("not-an-arn", "arn:aws:iam::*:role/*");
  assert.equal(r.valid, false);
});

// ---- inbound OIDC ----
const oidc: InboundOidcConfig = {
  kind: "oidc",
  issuer: "https://issuer.example/v2.0",
  audience: "my-agent",
  requiredScopes: ["openid", "mail.use"],
};

function jwt(over: Partial<SimulatedDecodedJwt> = {}): SimulatedDecodedJwt {
  return {
    iss: "https://issuer.example/v2.0",
    aud: "my-agent",
    sub: "john",
    scope: "openid mail.use",
    exp: Math.floor(Date.now() / 1000) + 300,
    marker: SIMULATED,
    ...over,
  };
}

test("OIDC validates a good token", () => {
  const r = validateOidcJwt(jwt(), oidc);
  assert.equal(r.valid, true);
  assert.equal(r.principal, "john");
});

test("OIDC rejects bad issuer", () => {
  const r = validateOidcJwt(jwt({ iss: "https://evil" }), oidc);
  assert.equal(r.valid, false);
  assert.match(r.reasons.join(" "), /issuer/);
});

test("OIDC rejects wrong audience", () => {
  const r = validateOidcJwt(jwt({ aud: "other" }), oidc);
  assert.equal(r.valid, false);
  assert.match(r.reasons.join(" "), /audience/);
});

test("OIDC rejects missing scope", () => {
  const r = validateOidcJwt(jwt({ scope: "openid" }), oidc);
  assert.equal(r.valid, false);
  assert.match(r.reasons.join(" "), /scope/);
});

test("OIDC rejects an expired token", () => {
  const r = validateOidcJwt(jwt({ exp: Math.floor(Date.now() / 1000) - 10 }), oidc);
  assert.equal(r.valid, false);
  assert.match(r.reasons.join(" "), /expired/);
});

test("validateInbound dispatches on kind", () => {
  const r = validateInbound(oidc, { jwt: jwt() });
  assert.equal(r.kind, "oidc");
  assert.equal(r.valid, true);
});

// ---- outbound patterns ----
const ctx: OutboundContext = {
  agentId: "agent-1",
  agentClientId: "client-abc",
  botPrincipal: "policy-bot",
  userSub: "maria",
  tenantId: "t1",
};

test("M2M claims: sub=bot, aud=resource, no user", () => {
  const b: ToolAuthBinding = { toolName: "t", pattern: "m2m", resource: "policy-api", minScopes: ["policy.read"], incrementalScopes: [] };
  const r = planOutbound(b, { ...ctx, userSub: null });
  assert.equal(r.ok, true);
  assert.equal(r.plan!.claims.sub, "policy-bot");
  assert.equal(r.plan!.claims.aud, "policy-api");
  assert.equal(r.plan!.key.userSub, null);
  assert.equal(r.plan!.withRefresh, false);
});

test("3LO claims: sub=user, cid=agent, requires consent", () => {
  const b: ToolAuthBinding = { toolName: "createPullRequest", pattern: "3lo", resource: "github-api", minScopes: ["repo", "pull_request:write"], incrementalScopes: ["issues:write"] };
  const r = planOutbound(b, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.plan!.claims.sub, "maria");
  assert.equal(r.plan!.claims.cid, "client-abc");
  assert.equal(r.plan!.requiresConsent, true);
  // minimum viable scope: issues:write (incremental) is NOT requested up front.
  assert.deepEqual(r.plan!.scopes, ["pull_request:write", "repo"]);
});

test("OBO claims: sub=user, act=agent, cid=agent", () => {
  const b: ToolAuthBinding = { toolName: "summarizeInbox", pattern: "obo", resource: "microsoft-graph", minScopes: ["Mail.Read"], incrementalScopes: ["Mail.Send"] };
  const r = planOutbound(b, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.plan!.claims.sub, "maria");
  assert.equal(r.plan!.claims.act, "agent");
  assert.equal(r.plan!.claims.cid, "client-abc");
  assert.equal(r.plan!.requiresConsent, false);
  assert.deepEqual(r.plan!.scopes, ["Mail.Read"]);
});

test("3LO/OBO require an authenticated user", () => {
  const b: ToolAuthBinding = { toolName: "t", pattern: "obo", resource: "r", minScopes: ["x"], incrementalScopes: [] };
  const r = planOutbound(b, { ...ctx, userSub: null });
  assert.equal(r.ok, false);
});

test("IAM claims: sub=bot principal, no user, no refresh", () => {
  const b: ToolAuthBinding = { toolName: "scan", pattern: "iam", resource: "s3", minScopes: ["s3:GetBucketPolicy"], incrementalScopes: [] };
  const r = planOutbound(b, { ...ctx, userSub: null });
  assert.equal(r.ok, true);
  assert.equal(r.plan!.pattern, "iam");
  assert.equal(r.plan!.withRefresh, false);
  assert.equal(r.plan!.key.userSub, null);
});

test("hasConsent honors scope coverage and revocation", () => {
  const consents: ConsentGrant[] = [
    { id: "c1", userSub: "maria", agentId: "agent-1", resource: "github-api", scopes: ["repo"], grantedAt: "x", revokedAt: null },
  ];
  assert.equal(hasConsent(consents, "maria", "agent-1", "github-api", ["repo"]), true);
  assert.equal(hasConsent(consents, "maria", "agent-1", "github-api", ["repo", "issues:write"]), false);
  consents[0].revokedAt = "y";
  assert.equal(hasConsent(consents, "maria", "agent-1", "github-api", ["repo"]), false);
});
