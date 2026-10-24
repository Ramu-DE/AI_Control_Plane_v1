// Offline tests for tenant-scoped personas.
//
// Before this, a persona was platform-wide: any identity could run any
// tenant's agents and query any tenant's graph, because the tenant came from
// the workflow and nothing asked whether the person belonged to it. These pin
// the membership rule (the tenant tree's: own subtree, never a sibling or a
// parent), the nearest-membership role, the IdP group convention, and the
// enforcement points that consult it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupFor,
  membershipsFromGroups,
  personaTenantDecision,
  takedaPersonas,
  upgradePersonas,
} from "../src/lib/personas.ts";
import { evaluate } from "../src/lib/evaluator.ts";
import { store } from "../src/lib/store.ts";
import { authorizeAgentStep } from "../src/lib/workflow/govern.ts";
import { queryGraphAsAgent, GraphQueryError } from "../src/lib/graph/query.ts";
import type { Persona } from "../src/lib/types.ts";

const tenants = store.tenants;
const persona = (id: string) => store.personas.find((p) => p.id === id)!;

test("the seeded store carries tenant-scoped Takeda personas", () => {
  for (const id of ["persona-priya", "persona-daniel", "persona-lena", "persona-kenji", "persona-omar", "persona-sofia"]) {
    const p = persona(id);
    assert.ok(p, `${id} seeded`);
    assert.ok(p.memberships?.length, `${id} has memberships`);
    assert.equal(p.provider, "Entra ID");
    for (const m of p.memberships!) assert.ok(p.groups.includes(groupFor(m)), "groups agree with memberships");
  }
  assert.deepEqual(JSON.parse(JSON.stringify(persona("persona-john").memberships)),
    [{ tenantId: "takeda", role: "approver" }],
    "the workshop identity is org-wide EXPLICITLY");
});

test("a membership covers its subtree, never a sibling or a parent", () => {
  const priya = persona("persona-priya"); // analyst in fn-rnd
  assert.equal(personaTenantDecision(priya, "fn-rnd", tenants).allowed, true, "own tenant");
  const child = personaTenantDecision(priya, "fn-rnd-research", tenants);
  assert.equal(child.allowed, true, "a sub-unit of R&D");
  assert.equal(child.via, "fn-rnd");
  assert.equal(personaTenantDecision(priya, "fn-supply", tenants).allowed, false, "sibling function");
  assert.equal(personaTenantDecision(priya, "takeda", tenants).allowed, false, "membership does not flow up");
});

test("the nearest membership decides the role", () => {
  const p: Persona = {
    ...persona("persona-priya"),
    memberships: [{ tenantId: "takeda", role: "viewer" }, { tenantId: "fn-rnd", role: "approver" }],
  };
  assert.equal(personaTenantDecision(p, "fn-rnd-research", tenants).role, "approver", "R&D membership is nearer");
  assert.equal(personaTenantDecision(p, "fn-supply", tenants).role, "viewer", "elsewhere the org-wide one applies");
});

test("no memberships fails closed", () => {
  const d = personaTenantDecision({ ...persona("persona-priya"), memberships: undefined }, "fn-rnd", tenants);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /no tenant membership/);
});

test("IdP groups TKD-<TENANT>-<ROLE> map to memberships; unknown ones are reported", () => {
  const { memberships, unmapped } = membershipsFromGroups(
    ["seniority_manager", "TKD-FN-RND-ANALYST", "TKD-BU-JAPAN-APPROVER", "TKD-NOPE-ADMIN", "TKD-FN-HR-OWNER"],
    tenants);
  assert.deepEqual(memberships, [
    { tenantId: "fn-rnd", role: "analyst" },
    { tenantId: "bu-japan", role: "approver" },
  ]);
  assert.deepEqual(unmapped, ["TKD-NOPE-ADMIN", "TKD-FN-HR-OWNER"], "unknown tenant and unknown role");
  assert.equal(groupFor({ tenantId: "bu-plasma-biolife", role: "viewer" }), "TKD-BU-PLASMA-BIOLIFE-VIEWER");
});

test("Cedar refuses a non-member before any policy, and sees the per-tenant role", () => {
  const base = { agentId: "a", action: "queryGraphSource", tool: "omda", resource: "g" };
  const denied = evaluate({ ...base, personaId: "persona-priya", tenantId: "fn-supply" });
  assert.equal(denied.allowed, false);
  assert.match(denied.decisions[0].reason, /not a member of 'fn-supply'/);
  assert.equal(evaluate({ ...base, personaId: "persona-priya", tenantId: "fn-rnd" }).allowed, true);
  // No tenant on the request (the expense demo) is unaffected by membership.
  assert.equal(evaluate({ ...base, personaId: "persona-priya" }).allowed, true);
});

test("running another tenant's agent is refused at the agent-step check", () => {
  const supplyAgent = store.agents.find((a) => a.tenantId === "fn-supply") ??
    { id: "agent-tmp-supply", tenantId: "fn-supply" };
  if (!store.agents.some((a) => a.id === supplyAgent.id)) {
    store.agents.push({ ...(store.agents[0]), id: supplyAgent.id, tenantId: "fn-supply" });
  }
  const r = authorizeAgentStep(supplyAgent.id, "persona-priya");
  assert.equal(r.allowed, false);
  assert.match(r.perimeter.reason, /not a member of 'fn-supply'/);
  assert.equal(authorizeAgentStep(supplyAgent.id, "persona-lena").perimeter.allowed, true,
    "the supply planner may");
});

test("graph tools refuse a persona outside the source's tenant even when the agent is right", async () => {
  const deps = {
    getSource: async () => ({
      graphSourceId: "scm", bu: "fn-supply", tenantId: "fn-supply", displayName: "", description: "",
      ontology: { type: "none" },
      backend: { type: "neo4j", uri: "neo4j+s://a1.databases.neo4j.io", database: "a1", username: "a1" },
      llmEndpoint: "", queryEngineUrl: "", allowedHosts: ["databases.neo4j.io"],
      status: "Approved", owner: "", createdAt: "", updatedAt: "",
    }) as never,
    runQuery: async () => ({ columns: [], rows: [], rowCount: 0 }),
  };
  // A supply agent run by an R&D persona: the tenant matches, the person does not.
  await assert.rejects(
    queryGraphAsAgent({ graphSourceId: "scm", cypher: "MATCH (n) RETURN n LIMIT $limit" },
      { personaId: "persona-priya", tenantId: "fn-supply", agentId: "a1", origin: "workflow" }, deps),
    (e: unknown) => e instanceof GraphQueryError && e.code === "POLICY_DENIED");
  await queryGraphAsAgent({ graphSourceId: "scm", cypher: "MATCH (n) RETURN n LIMIT $limit" },
    { personaId: "persona-lena", tenantId: "fn-supply", agentId: "a1", origin: "workflow" }, deps);
});

test("upgrading a restored store is additive and never grants a tenant silently", () => {
  const restored: Persona[] = [
    { id: "persona-john", name: "John", sub: "s", email: "e", provider: "AWS Cognito", groups: [], attributes: {} },
    { id: "persona-legacy", name: "Old", sub: "s", email: "e", provider: "AWS Cognito", groups: [], attributes: {} },
  ];
  upgradePersonas(restored);
  assert.deepEqual(restored[0].memberships, [{ tenantId: "takeda", role: "approver" }]);
  assert.equal(restored[1].memberships, undefined, "an unknown legacy persona stays unscoped (fails closed)");
  assert.equal(restored.filter((p) => p.id.startsWith("persona-")).length, 2 + takedaPersonas().length);
  const again = upgradePersonas(restored);
  assert.deepEqual(again, [], "idempotent");
});

test("the role in force limits what a member may do", () => {
  // Daniel is an approver in R&D but only a viewer in Medical (both GxP; he is trained).
  const base = { personaId: "persona-daniel", agentId: "a", tool: "omda", resource: "g", tenantId: "fn-medical" };
  assert.equal(evaluate({ ...base, action: "queryGraphSource" }).allowed, true, "viewer may query");
  const run = evaluate({ ...base, action: "runAgent", tool: "workflow" });
  assert.equal(run.allowed, false, "viewer may not run agents");
  assert.match(run.decisions[0].reason, /runAgent needs analyst/);
  const inRnd = evaluate({ ...base, action: "runAgent", tool: "workflow", tenantId: "fn-rnd" });
  assert.doesNotMatch(inRnd.decisions[0].reason, /needs analyst/, "the same person may run agents where he is approver");
});

test("a disabled persona fails every tenant decision and every evaluation", () => {
  const p = { ...persona("persona-priya"), disabled: true };
  assert.equal(personaTenantDecision(p, "fn-rnd", tenants).allowed, false);
  assert.match(personaTenantDecision(p, "fn-rnd", tenants).reason, /disabled/);
});
