// Offline tests for maker-checker on Registry records and Graph Sources.
//
// Approving a tool, knowledge base or graph makes it usable by every agent in
// a tenant. These pin the rule (lib/approvals.ts): a named submitter who is an
// analyst+ of the resource's tenant; a named, DIFFERENT decider who is an
// approver+ there and passes Cedar (so GxP binds approvers); platform-provided
// resources decided at the org root.

import { test } from "node:test";
import assert from "node:assert/strict";

import { authorizeTransition } from "../src/lib/approvals.ts";
import { store } from "../src/lib/store.ts";

function code(o: ReturnType<typeof authorizeTransition>): string {
  return o.ok ? `ok:${o.role}` : o.code;
}

test("a submission must name an analyst+ of the resource's tenant", () => {
  const base = { next: "Pending approval" as const, tenantId: "fn-supply", resourceId: "r" };
  assert.equal(code(authorizeTransition({ ...base })), "SUBMITTER_REQUIRED");
  assert.equal(code(authorizeTransition({ ...base, personaId: "persona-lena" })), "ok:submit");
  assert.equal(code(authorizeTransition({ ...base, personaId: "persona-priya" })), "SUBMITTER_NOT_PERMITTED",
    "an R&D persona cannot submit into Supply");
  const viewer = authorizeTransition({ ...base, tenantId: "bu-plasma-biolife", personaId: "persona-sofia" });
  assert.equal(code(viewer), "SUBMITTER_NOT_PERMITTED");
  assert.match((viewer as { error: string }).error, /submitting needs analyst/);
});

test("a decision must name an approver+ of the resource's tenant who did not submit it", () => {
  const base = { tenantId: "fn-rnd", resourceId: "r", submittedByPersonaId: "persona-priya" };
  for (const next of ["Approved", "Rejected", "Deprecated"] as const) {
    assert.equal(code(authorizeTransition({ ...base, next })), "REVIEWER_REQUIRED", next);
  }
  assert.equal(code(authorizeTransition({ ...base, next: "Approved", personaId: "persona-priya" })), "SELF_REVIEW");
  const analyst = authorizeTransition({ ...base, next: "Approved", personaId: "persona-lena" });
  assert.equal(code(analyst), "REVIEWER_NOT_PERMITTED", "not a member of R&D");
  assert.equal(code(authorizeTransition({ ...base, next: "Approved", personaId: "persona-daniel" })), "ok:decide",
    "trained R&D approver, different person");
});

test("GxP binds approvers: an untrained approver of a GxP tenant is refused", () => {
  if (!store.personas.some((p) => p.id === "t-appr-untrained")) {
    store.personas.push({
      id: "t-appr-untrained", name: "Untrained Approver", sub: "s", email: "e", provider: "Entra ID",
      groups: [], attributes: { role: "manager", gxpTrained: "false", region: "EU" },
      memberships: [{ tenantId: "fn-supply", role: "approver" }],
    });
  }
  const r = authorizeTransition({ next: "Approved", tenantId: "fn-supply", resourceId: "r",
    personaId: "t-appr-untrained" });
  assert.equal(code(r), "REVIEWER_NOT_PERMITTED");
  assert.match((r as { error: string }).error, /GxP/);
});

test("platform-provided resources are decided at the org root", () => {
  const platform = { next: "Approved" as const, resourceId: "r" }; // no tenantId
  assert.equal(code(authorizeTransition({ ...platform, personaId: "persona-daniel" })), "REVIEWER_NOT_PERMITTED",
    "an R&D approver is not an org-level approver");
  assert.equal(code(authorizeTransition({ ...platform, personaId: "persona-mary" })), "ok:decide");
  // A tenant id that does not exist (e.g. a free-text BU) is treated as platform-level, not open.
  assert.equal(code(authorizeTransition({ ...platform, tenantId: "market-access", personaId: "persona-daniel" })),
    "REVIEWER_NOT_PERMITTED");
});

test("transitions that are not submissions or decisions need no persona", () => {
  assert.equal(code(authorizeTransition({ next: "Draft", tenantId: "fn-rnd", resourceId: "r" })), "ok:none");
});
