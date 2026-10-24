// Offline tests for GxP and data-residency policy, and review-gate identity.
//
// The rules are ordinary Cedar forbid policies (lib/regulatory.ts) over two
// facts: the tenant's inherited attributes (resource.gxp, resource.region) and
// the persona's (principal.gxpTrained, principal.region). These pin that the
// evaluator reads both, that forbid beats every permit, that inheritance runs
// down the tenant tree, and that a review decision is bound by the same rules.

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate } from "../src/lib/evaluator.ts";
import { store } from "../src/lib/store.ts";
import { tenantPolicyAttributes } from "../src/lib/tenancy.ts";
import { REVIEW_GATE_ACTION, REVIEW_GATE_TOOL, regulatoryPolicies } from "../src/lib/regulatory.ts";
import type { Persona } from "../src/lib/types.ts";

function person(id: string, tenantId: string, role: Persona["memberships"] extends (infer M)[] | undefined ? M extends { role: infer R } ? R : never : never,
                attrs: Record<string, string>): string {
  if (!store.personas.some((p) => p.id === id)) {
    store.personas.push({
      id, name: id, sub: id, email: `${id}@t.example`, provider: "Entra ID", groups: [],
      attributes: { role: "ic", ...attrs }, memberships: [{ tenantId, role }], homeTenantId: tenantId,
    });
  }
  return id;
}

const run = (personaId: string, tenantId: string, action = "runAgent", tool = "workflow") =>
  evaluate({ personaId, agentId: "a", action, tool, resource: "r", tenantId });

test("regulatory policies are seeded and enabled", () => {
  for (const p of regulatoryPolicies("")) {
    const seeded = store.policies.find((x) => x.id === p.id);
    assert.ok(seeded?.enabled, `${p.id} seeded`);
  }
});

test("GxP and region are inherited down the tenant tree", () => {
  assert.equal(tenantPolicyAttributes("fn-rnd-research", store.tenants).gxp, "true", "R&D sub-unit inherits GxP");
  assert.equal(tenantPolicyAttributes("bu-plasma-biolife", store.tenants).gxp, "true", "BioLife inherits from Plasma");
  assert.equal(tenantPolicyAttributes("bu-onc-japan", store.tenants).region, "JP");
  assert.equal(tenantPolicyAttributes("fn-finance", store.tenants).gxp, "false");
  assert.equal(tenantPolicyAttributes("fn-finance", store.tenants).regionBound, "false");
});

test("GxP data requires GxP training — forbid wins over the perimeter permit", () => {
  const untrained = person("t-rnd-untrained", "fn-rnd", "analyst", { gxpTrained: "false", region: "US" });
  const denied = run(untrained, "fn-rnd");
  assert.equal(denied.allowed, false);
  assert.match(denied.decisions[0].reason, /GxP data requires GxP training/);
  assert.equal(run("persona-priya", "fn-rnd").allowed, true, "trained analyst may run agents");
  // The same untrained person in a non-GxP tenant is unaffected by the GxP rule.
  const finance = person("t-fin-untrained", "fn-finance", "analyst", { gxpTrained: "false", region: "EU" });
  assert.equal(run(finance, "fn-finance").allowed, true);
});

test("a missing gxpTrained attribute is treated as untrained (fails closed)", () => {
  const unknown = person("t-rnd-unknown", "fn-rnd", "analyst", { region: "US" });
  assert.equal(run(unknown, "fn-rnd").allowed, false);
});

test("region-bound data stays with people in that region, or GLOBAL", () => {
  assert.equal(run("persona-kenji", "bu-japan").allowed, true, "JP persona in JP tenant");
  const usInJapan = person("t-jp-from-us", "bu-japan", "analyst", { gxpTrained: "false", region: "US" });
  const denied = run(usInJapan, "bu-japan");
  assert.equal(denied.allowed, false);
  assert.match(denied.decisions[0].reason, /region-bound data/);
  const globalInJapan = person("t-jp-global", "bu-japan", "analyst", { gxpTrained: "false", region: "GLOBAL" });
  assert.equal(run(globalInJapan, "bu-japan").allowed, true, "GLOBAL scope passes");
  assert.equal(run(usInJapan, "bu-japan", "queryGraphSource", "omda").allowed, false, "reads are covered too");
});

test("the org-wide workshop identities are explicitly trained and GLOBAL", () => {
  for (const id of ["persona-john", "persona-mary"]) {
    const p = store.personas.find((x) => x.id === id)!;
    assert.equal(p.attributes.gxpTrained, "true");
    assert.equal(p.attributes.region, "GLOBAL");
  }
  assert.equal(run("persona-john", "fn-rnd").allowed, true);
  assert.equal(run("persona-john", "bu-japan").allowed, true);
});

test("requests with no tenant are untouched (the expense playground)", () => {
  const r = evaluate({ personaId: "persona-john", agentId: "a", action: "invokeTool", tool: "approveExpense", amount: "3000" });
  assert.equal(r.allowed, true);
});

test("review-gate decisions need an approver, and GxP binds approvers too", () => {
  const gate = (personaId: string, tenantId: string) =>
    evaluate({ personaId, agentId: "review-gate", action: REVIEW_GATE_ACTION, tool: REVIEW_GATE_TOOL, resource: "run", tenantId });
  const analyst = gate("persona-lena", "fn-supply");
  assert.equal(analyst.allowed, false, "an analyst may not decide");
  assert.match(analyst.decisions[0].reason, /approveReviewGate needs approver/);
  assert.equal(gate("persona-daniel", "fn-rnd").allowed, true, "trained R&D approver may");
  const untrainedApprover = person("t-rnd-approver-untrained", "fn-rnd", "approver", { gxpTrained: "false", region: "US" });
  const gxp = gate(untrainedApprover, "fn-rnd");
  assert.equal(gxp.allowed, false);
  assert.match(gxp.decisions[0].reason, /GxP/);
  assert.equal(gate("persona-kenji", "fn-rnd").allowed, false, "not a member of R&D");
});
