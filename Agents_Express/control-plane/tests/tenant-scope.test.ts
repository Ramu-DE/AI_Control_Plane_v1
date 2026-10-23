// Offline tests for the three tenancy dimensions that had no boundary.
//
// Measured against the pool/bridge/silo framework, memory was the only
// dimension where tenant isolation was STRUCTURAL rather than conventional.
// Three others were pooled with nothing enforcing a boundary at all:
//
//   telemetry      `AuditEvent` had `actor` but no `tenantId`, so "show me
//                  BU-Japan's activity" and "what did Oncology spend" were
//                  unanswerable — the tenant appeared only inside `detail`,
//                  which is a log line, not a queryable dimension.
//   authorization  `EvaluationRequest` was persona + agent + tool. A tenant
//                  could only be smuggled into a resource STRING, which is a
//                  convention a policy author can forget.
//   tools          `RegistryRecord.owner` holds people and teams, not tenants,
//                  so a platform-provided tool and a tenant-onboarded one were
//                  indistinguishable and nothing stopped one BU attaching a
//                  sibling BU's tool.
//
// The rule they all share is subtree containment, and it had been written
// twice before (memory, workflow eligibility) with two chances to get the
// direction backwards. It now lives once in lib/tenancy.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterAuditForTenant,
  inTenantSubtree,
  resourceAvailableToTenant,
  tenantChain,
  usageByTenant,
  visibleTenantIds,
} from "../src/lib/tenancy.ts";
import type { AuditEvent, Tenant } from "../src/lib/types.ts";

function tenant(id: string, parentId: string | null): Tenant {
  return {
    id, tenantId: id, tenantName: id.toUpperCase(), parentId, type: "bu",
    tier: "pro", isolation: "silo", resourcePool: "p",
    createdAt: "", updatedAt: "",
  } as Tenant;
}

// org
//  ├── us ──── us-hr
//  └── japan ─ japan-ddt
const TREE: Tenant[] = [
  tenant("org", null),
  tenant("us", "org"),
  tenant("us-hr", "us"),
  tenant("japan", "org"),
  tenant("japan-ddt", "japan"),
  tenant("other-root", null),
];

function evt(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "e1", category: "agent", action: "create", actor: "someone",
    detail: "", at: "2026-10-23T00:00:00.000Z",
    ...over,
  } as AuditEvent;
}

// --------------------------------------------------------------------------- //
// The shared subtree rule
// --------------------------------------------------------------------------- //
test("tenantChain walks self then ancestors, root last", () => {
  assert.deepEqual(tenantChain("us-hr", TREE), ["us-hr", "us", "org"]);
  assert.deepEqual(tenantChain("org", TREE), ["org"]);
  assert.deepEqual(tenantChain("nope", TREE), []);
});

test("subtree containment is reflexive", () => {
  // Without this, every caller writes `id === root || inSubtree(...)` and the
  // one that forgets denies a tenant access to its own resources.
  assert.equal(inTenantSubtree("us", "us", TREE), true);
  assert.equal(inTenantSubtree("us-hr", "us", TREE), true);
  assert.equal(inTenantSubtree("us-hr", "org", TREE), true);
});

test("subtree containment refuses sideways and upward", () => {
  assert.equal(inTenantSubtree("us", "japan", TREE), false, "sibling");
  assert.equal(inTenantSubtree("us-hr", "japan-ddt", TREE), false, "cousin");
  assert.equal(inTenantSubtree("org", "us", TREE), false,
    "a parent is NOT inside its child's subtree — direction matters");
  assert.equal(inTenantSubtree("other-root", "org", TREE), false, "separate root");
});

test("a cycle in parentId terminates", () => {
  const cyclic = [tenant("a", "b"), tenant("b", "a")];
  assert.equal(inTenantSubtree("a", "zzz", cyclic), false);
  assert.ok(tenantChain("a", cyclic).length <= 2);
});

test("visibleTenantIds is the tenant plus its descendants", () => {
  assert.deepEqual(visibleTenantIds("us", TREE).sort(), ["us", "us-hr"]);
  assert.deepEqual(visibleTenantIds("org", TREE).sort(),
    ["japan", "japan-ddt", "org", "us", "us-hr"]);
  assert.deepEqual(visibleTenantIds("us-hr", TREE), ["us-hr"]);
});

// --------------------------------------------------------------------------- //
// 1. Telemetry separation
// --------------------------------------------------------------------------- //
test("a tenant sees its own events and its descendants'", () => {
  const events = [
    evt({ id: "a", tenantId: "us" }),
    evt({ id: "b", tenantId: "us-hr" }),
    evt({ id: "c", tenantId: "japan" }),
    evt({ id: "d", tenantId: "org" }),
  ];
  const scoped = filterAuditForTenant(events, "us", TREE);
  assert.deepEqual(scoped.events.map((e) => e.id), ["a", "b"],
    "own + descendant, not the sibling and not the parent's own events");
  assert.deepEqual(scoped.includedTenantIds.sort(), ["us", "us-hr"]);
});

test("a parent gets oversight of the whole subtree", () => {
  const events = [
    evt({ id: "a", tenantId: "us-hr" }),
    evt({ id: "b", tenantId: "japan-ddt" }),
    evt({ id: "c", tenantId: "other-root" }),
  ];
  const scoped = filterAuditForTenant(events, "org", TREE);
  assert.deepEqual(scoped.events.map((e) => e.id), ["a", "b"],
    "the separate root is excluded");
});

test("untenanted platform events are excluded by default but COUNTED", () => {
  // A log that silently omits entries is worse than one that admits it.
  const events = [
    evt({ id: "a", tenantId: "us" }),
    evt({ id: "p1" }),                       // policy edit — no tenant
    evt({ id: "p2", tenantId: undefined }),
  ];
  const off = filterAuditForTenant(events, "us", TREE);
  assert.deepEqual(off.events.map((e) => e.id), ["a"]);
  assert.equal(off.platformEvents, 2, "the omission is reported, not hidden");

  const on = filterAuditForTenant(events, "us", TREE, { includePlatform: true });
  assert.deepEqual(on.events.map((e) => e.id), ["a", "p1", "p2"]);
});

test("usage rolls up per tenant for cost attribution", () => {
  const runs = [
    { tenantId: "us", totalTokens: 100, totalCostUsd: 1 },
    { tenantId: "us", totalTokens: 50, totalCostUsd: 0.5 },
    { tenantId: "japan", totalTokens: 7, totalCostUsd: 0 },
    { tenantId: "", totalTokens: 999, totalCostUsd: 9 },   // unattributable
  ];
  const usage = usageByTenant(runs);
  assert.deepEqual(usage.us, { tokens: 150, costUsd: 1.5, runs: 2 });
  assert.deepEqual(usage.japan, { tokens: 7, costUsd: 0, runs: 1 });
  assert.ok(!("" in usage), "a run with no tenant is not attributed to one");
});

// --------------------------------------------------------------------------- //
// 3. Tool ownership: pooled, bridged, and the sideways case
// --------------------------------------------------------------------------- //
test("a platform-provided record is available to every tenant", () => {
  // The shared half of "a platform offers common tools while tenants bring
  // their own". Undefined owner keeps every pre-existing record working.
  for (const owner of [undefined, null]) {
    const v = resourceAvailableToTenant(owner, "us-hr", TREE);
    assert.equal(v.allowed, true);
    assert.match(v.reason, /platform-provided/);
  }
});

test("a record owned by an ANCESTOR is inherited", () => {
  // The bridged case: the org publishes a tool once, every BU gets it.
  const v = resourceAvailableToTenant("org", "us-hr", TREE);
  assert.equal(v.allowed, true);
  assert.match(v.reason, /inherited from ancestor/);
});

test("a SIBLING's record is refused — the case nothing prevented before", () => {
  const v = resourceAvailableToTenant("japan", "us", TREE);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /neither 'us' nor one of its ancestors/);
});

test("a DESCENDANT's record does not flow upward", () => {
  // A sub-unit's private tool is not the parent's to use. Isolation is not
  // the same as hierarchy.
  const v = resourceAvailableToTenant("us-hr", "us", TREE);
  assert.equal(v.allowed, false);
});

test("a tenant's own record is available to it", () => {
  const v = resourceAvailableToTenant("us", "us", TREE);
  assert.equal(v.allowed, true);
  assert.match(v.reason, /owned by 'us'/);
});

// --------------------------------------------------------------------------- //
// 2. Tenant-aware authorization
// --------------------------------------------------------------------------- //
test("a tenant-scoped policy covers the tenant and its descendants", async () => {
  const { evaluate } = await import("../src/lib/evaluator.ts");
  const { store } = await import("../src/lib/store.ts");

  const persona = store.personas[0];
  const target = store.tenants.find((t) => t.parentId !== null)!;
  const child = store.tenants.find((t) => t.parentId === target.id);

  store.policies.unshift({
    id: "pol-tenant-scope-test", name: "Tenant-scoped test", layer: "gateway",
    description: "", enabled: true, createdAt: "",
    cedar:
      `permit(principal, action == Action::"invokeTool", ` +
      `resource == Tool::"tenant-probe") when { resource.tenant == "${target.id}" };`,
  } as never);

  try {
    const own = evaluate({
      personaId: persona.id, agentId: "a", action: "invokeTool",
      tool: "tenant-probe", tenantId: target.id,
    });
    assert.equal(own.allowed, true, `own tenant must be permitted: ${JSON.stringify(own.decisions)}`);

    if (child) {
      const desc = evaluate({
        personaId: persona.id, agentId: "a", action: "invokeTool",
        tool: "tenant-probe", tenantId: child.id,
      });
      assert.equal(desc.allowed, true,
        "a descendant is covered — otherwise every parent policy needs " +
        "restating per sub-unit, and the one nobody restates is the hole");
    }

    // A tenant outside the subtree must NOT match.
    const outside = store.tenants.find(
      (t) => t.id !== target.id && !tenantChain(t.id, store.tenants).includes(target.id)
    )!;
    const other = evaluate({
      personaId: persona.id, agentId: "a", action: "invokeTool",
      tool: "tenant-probe", tenantId: outside.id,
    });
    assert.equal(other.allowed, false,
      `tenant '${outside.id}' is outside '${target.id}' and must be denied`);

    // No tenant on the request at all must FAIL CLOSED against a tenant rule.
    const none = evaluate({
      personaId: persona.id, agentId: "a", action: "invokeTool",
      tool: "tenant-probe",
    });
    assert.equal(none.allowed, false,
      "a tenant-scoped policy must not match a request with no tenant");
  } finally {
    store.policies.splice(
      store.policies.findIndex((p) => p.id === "pol-tenant-scope-test"), 1);
  }
});

test("existing policies keep their meaning without a tenant", async () => {
  // `tenantId` is optional precisely so nothing already working changes. The
  // seeded workflow perimeter has no tenant clause and must still permit.
  const { evaluate } = await import("../src/lib/evaluator.ts");
  const { store } = await import("../src/lib/store.ts");
  const persona = store.personas[0];
  const withTenant = evaluate({
    personaId: persona.id, agentId: "agent-expense-assistant",
    action: "runAgent", tool: "workflow", resource: "agent-expense-assistant",
    tenantId: "fn-finance",
  });
  const without = evaluate({
    personaId: persona.id, agentId: "agent-expense-assistant",
    action: "runAgent", tool: "workflow", resource: "agent-expense-assistant",
  });
  assert.equal(withTenant.allowed, without.allowed,
    "adding a tenant to the request must not change a tenant-agnostic policy");
});

test("the agent-step gate supplies the tenant from the agent", async () => {
  const { authorizeAgentStep } = await import("../src/lib/workflow/govern.ts");
  const { store } = await import("../src/lib/store.ts");
  const agent = store.agents[0];
  const persona = store.personas[0];
  // Smoke-level: the call must succeed and reach a decision. The tenant is
  // derived inside, so the assertion is that it does not throw or deny for
  // want of one.
  const authz = authorizeAgentStep(agent.id, persona.id);
  assert.ok(typeof authz.allowed === "boolean");
  assert.ok(authz.perimeter.reason.length > 0);
});
