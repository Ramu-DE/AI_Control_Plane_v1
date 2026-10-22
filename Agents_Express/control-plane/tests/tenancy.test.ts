// Offline tests for tenant usage and capacity.
//
// The thing worth protecting here is that a capacity bar only ever appears for
// a limit the server ACTUALLY enforces at tenant scope. Two traps were live
// while writing this module:
//
//   1. `RegistryRecord.owner` holds `console-user`, `platform-team`,
//      `finance-platform` — a mix of people and teams, not tenant ids. A first
//      version counted records with `owner === tenantId` and reported 0 for
//      almost every tenant.
//   2. Only `maxAgents` is counted across a tenant. `maxToolsPerAgent`,
//      `maxKnowledgeBases` and `maxMemories` are each compared against ONE
//      agent's refs on create. A tenant-wide bar for those would have shown
//      "8 / 1 memories" while every individual agent was within its limit — a
//      meter implying a guarantee nothing enforces.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  descendantIds,
  perAgentLimits,
  tenantCapacity,
  tenantUsage,
} from "../src/lib/tenancy.ts";
import { getTierConfig, nextPlan, planLabel } from "../src/lib/tiers.ts";
import { store } from "../src/lib/store.ts";
import type {
  AgentConfig,
  RegistryRecord,
  Tenant,
  Workflow,
} from "../src/lib/types.ts";

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: "t1",
    tenantId: "t1",
    tenantName: "T1",
    parentId: null,
    type: "bu",
    tier: "basic",
    isolation: "pool",
    resourcePool: "shared-pool-01",
    createdAt: "",
    updatedAt: "",
    ...over,
  } as Tenant;
}

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "a1",
    name: "A1",
    description: "",
    tenantId: "t1",
    modelId: "m1",
    systemPrompt: "",
    toolRefs: [],
    knowledgeRefs: [],
    memoryRefs: [],
    compute: { agentRuntimeId: "aws-agentcore-runtime", modelRuntimeId: "aws-bedrock" },
    visibility: "private",
    status: "ready",
    createdAt: "",
    ...over,
  } as AgentConfig;
}

function record(over: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    id: "r1",
    registryId: "reg1",
    name: "r1",
    description: "",
    recordSource: "Define manually",
    type: "Custom",
    credentialType: "No authorization",
    status: "Approved",
    tools: [],
    owner: "console-user",
    createdAt: "",
    ...over,
  } as RegistryRecord;
}

const EMPTY = { tenants: [], agents: [], workflows: [] as Workflow[], records: [] };

// --------------------------------------------------------------------------- //
// descendantIds
// --------------------------------------------------------------------------- //
test("descendantIds walks the whole subtree, excluding the root", () => {
  const tenants = [
    tenant({ id: "root", parentId: null }),
    tenant({ id: "a", parentId: "root" }),
    tenant({ id: "b", parentId: "root" }),
    tenant({ id: "a1", parentId: "a" }),
    tenant({ id: "a1x", parentId: "a1" }),
    tenant({ id: "other", parentId: null }),
  ];
  assert.deepEqual(descendantIds(tenants, "root").sort(), ["a", "a1", "a1x", "b"]);
  assert.deepEqual(descendantIds(tenants, "a").sort(), ["a1", "a1x"]);
  assert.deepEqual(descendantIds(tenants, "a1x"), []);
});

test("a cycle in parentId terminates instead of hanging the console", () => {
  // Tenant trees come from data. Assuming acyclicity is how a page freezes.
  const tenants = [
    tenant({ id: "x", parentId: "y" }),
    tenant({ id: "y", parentId: "x" }),
  ];
  const out = descendantIds(tenants, "x");
  assert.ok(out.length <= 2, `must terminate, got ${JSON.stringify(out)}`);
  assert.ok(!out.includes("x"), "the root is never its own descendant");
});

// --------------------------------------------------------------------------- //
// usage
// --------------------------------------------------------------------------- //
test("agents are counted per tenant, matching what the API enforces", () => {
  const input = {
    ...EMPTY,
    tenants: [tenant({ id: "t1" }), tenant({ id: "t2" })],
    agents: [
      agent({ id: "a1", tenantId: "t1", status: "ready" }),
      agent({ id: "a2", tenantId: "t1", status: "draft" }),
      agent({ id: "a3", tenantId: "t2" }),
    ],
  };
  const u = tenantUsage("t1", input);
  assert.equal(u.agents, 2);
  assert.equal(u.agentsReady, 1);
  assert.equal(u.agentsDraft, 1);
  // Not rolled up through descendants: the limit is per tenant, so a
  // rolled-up number beside it would read as over capacity when it is not.
  assert.equal(tenantUsage("t2", input).agents, 1);
});

test("attachments are counted from the agents, not from record.owner", () => {
  const input = {
    ...EMPTY,
    tenants: [tenant({ id: "t1" })],
    agents: [
      agent({ id: "a1", tenantId: "t1", toolRefs: ["r1"], knowledgeRefs: ["kb1"] }),
    ],
    // Owned by a PERSON, which is the real shape of this field.
    records: [
      record({ id: "r1", owner: "console-user" }),
      record({ id: "kb1", type: "Knowledge Base", owner: "platform-team" }),
    ],
  };
  const u = tenantUsage("t1", input);
  assert.equal(u.toolsAttached, 1, "owner is not a tenant id; refs are the truth");
  assert.equal(u.knowledgeBasesAttached, 1);
});

test("a record shared by two agents counts once", () => {
  const input = {
    ...EMPTY,
    tenants: [tenant({ id: "t1" })],
    agents: [
      agent({ id: "a1", tenantId: "t1", knowledgeRefs: ["kb1"] }),
      agent({ id: "a2", tenantId: "t1", knowledgeRefs: ["kb1"] }),
    ],
    records: [record({ id: "kb1", type: "Knowledge Base" })],
  };
  // Two agents sharing one knowledge base are using ONE.
  assert.equal(tenantUsage("t1", input).knowledgeBasesAttached, 1);
});

test("a dangling ref is not counted as an attachment", () => {
  const input = {
    ...EMPTY,
    tenants: [tenant({ id: "t1" })],
    agents: [agent({ tenantId: "t1", toolRefs: ["gone"] })],
    records: [],
  };
  assert.equal(tenantUsage("t1", input).toolsAttached, 0,
    "a reference to a deleted record is not a resource in use");
});

test("peakPerAgent reports the highest on any ONE agent", () => {
  const input = {
    ...EMPTY,
    tenants: [tenant({ id: "t1" })],
    agents: [
      agent({ id: "a1", tenantId: "t1", toolRefs: ["x"] }),
      agent({ id: "a2", tenantId: "t1", toolRefs: ["x", "y", "z"] }),
    ],
    records: [record({ id: "x" }), record({ id: "y" }), record({ id: "z" })],
  };
  const u = tenantUsage("t1", input);
  assert.equal(u.peakPerAgent.tools, 3, "the peak, not the sum or the average");
  assert.equal(u.toolsAttached, 3, "and distinct attachments across the tenant");
});

test("a tenant with nothing reports zeroes, not undefined", () => {
  const u = tenantUsage("empty", { ...EMPTY, tenants: [tenant({ id: "empty" })] });
  assert.equal(u.agents, 0);
  assert.equal(u.toolsAttached, 0);
  assert.equal(u.peakPerAgent.memories, 0);
  assert.equal(u.descendants, 0);
});

// --------------------------------------------------------------------------- //
// capacity
// --------------------------------------------------------------------------- //
test("only tenant-scoped limits get a capacity bar", () => {
  const usage = tenantUsage("t1", { ...EMPTY, tenants: [tenant({ id: "t1" })] });
  const cap = tenantCapacity(usage, getTierConfig("basic"), planLabel("basic"));
  assert.deepEqual(cap.lines.map((l) => l.key), ["agents"],
    "maxToolsPerAgent / maxKnowledgeBases / maxMemories are PER-AGENT limits " +
    "and must not appear as tenant-wide bars");
});

test("capacity state crosses to tight at 80% and full at the limit", () => {
  const mk = (n: number, limit: number) => {
    const agents = Array.from({ length: n }, (_, i) =>
      agent({ id: `a${i}`, tenantId: "t1" }));
    const usage = tenantUsage("t1", {
      ...EMPTY, tenants: [tenant({ id: "t1" })], agents,
    });
    return tenantCapacity(
      usage, { ...getTierConfig("basic"), maxAgents: limit }, "Standard"
    ).lines[0];
  };

  // On a limit of 10 the whole scale is reachable.
  assert.equal(mk(0, 10).state, "ok");
  assert.equal(mk(7, 10).state, "ok", "70% is not yet tight");
  assert.equal(mk(8, 10).state, "tight", "80% is the threshold");
  assert.equal(mk(10, 10).state, "full");
  assert.equal(mk(12, 10).state, "full", "over the limit is still full");

  // On the Standard limit of 3, `tight` is UNREACHABLE: 2/3 is 67% and 3/3 is
  // already full. That is inherent to a percentage threshold on a small
  // integer limit, not a bug — but it is worth pinning, because a reader
  // seeing no amber state on a Standard tenant should know why.
  assert.equal(mk(2, 3).state, "ok");
  assert.equal(mk(3, 3).state, "full");
});

test("a zero limit means any use is full, and no use is not NaN", () => {
  const usage = tenantUsage("t1", {
    ...EMPTY,
    tenants: [tenant({ id: "t1" })],
    agents: [agent({ tenantId: "t1" })],
  });
  const config = { ...getTierConfig("basic"), maxAgents: 0 };
  const used = tenantCapacity(usage, config, "Standard").lines[0];
  assert.equal(used.state, "full");
  assert.equal(used.ratio, 1, "1/0 must not be Infinity");

  const none = tenantUsage("t2", { ...EMPTY, tenants: [tenant({ id: "t2" })] });
  const empty = tenantCapacity(none, config, "Standard").lines[0];
  assert.equal(empty.ratio, 0, "0/0 must not be NaN");
  assert.equal(empty.state, "full", "nothing is allowed, so nothing is available");
});

test("an unlimited dimension is not reported as a ratio", () => {
  const usage = tenantUsage("t1", { ...EMPTY, tenants: [tenant({ id: "t1" })] });
  const cap = tenantCapacity(usage, { ...getTierConfig("pro"), maxAgents: null as never },
                             "Expanded");
  const line = cap.lines[0];
  assert.equal(line.limit, null);
  assert.equal(line.ratio, null, "null, not 0 — there is no fraction of infinity");
  assert.equal(line.state, "ok");
});

test("anyFull and anyTight summarise the lines", () => {
  const config = getTierConfig("basic");
  const agents = Array.from({ length: 3 }, (_, i) =>
    agent({ id: `a${i}`, tenantId: "t1" }));
  const usage = tenantUsage("t1", { ...EMPTY, tenants: [tenant({ id: "t1" })], agents });
  const cap = tenantCapacity(usage, config, "Standard");
  assert.equal(cap.anyFull, true);
  assert.equal(cap.anyTight, true, "full implies tight; a UI must not have to know that");
});

test("perAgentLimits reports a real peak for every dimension", () => {
  const input = {
    ...EMPTY,
    tenants: [tenant({ id: "t1" })],
    agents: [agent({
      tenantId: "t1", toolRefs: ["a", "b"], knowledgeRefs: ["k"], memoryRefs: ["m"],
    })],
    records: [record({ id: "a" }), record({ id: "b" }), record({ id: "k" }),
              record({ id: "m" })],
  };
  const usage = tenantUsage("t1", input);
  const limits = perAgentLimits(usage, getTierConfig("basic"));
  const byKey = Object.fromEntries(limits.map((l) => [l.key, l]));
  // An earlier version hardcoded peak: 0 for two of the three, which is worse
  // than omitting the field: it reports a measurement it never took.
  assert.equal(byKey.tools.peak, 2);
  assert.equal(byKey.knowledgeBases.peak, 1);
  assert.equal(byKey.memories.peak, 1);
  assert.equal(byKey.tools.atCeiling, true, "basic allows 2 tools per agent");
  assert.equal(byKey.knowledgeBases.atCeiling, true, "and 1 KB per agent");
});

// --------------------------------------------------------------------------- //
// plan labels
// --------------------------------------------------------------------------- //
test("plan labels replace the raw tier keys the console no longer shows", () => {
  assert.equal(planLabel("basic"), "Standard");
  assert.equal(planLabel("pro"), "Expanded");
  // A console that never says "basic" must not be fed an error that does.
  assert.ok(!planLabel("basic").toLowerCase().includes("basic"));
  assert.ok(!planLabel("pro").toLowerCase().includes("pro"));
});

test("nextPlan points up, and stops at the top", () => {
  assert.equal(nextPlan("basic"), "pro");
  assert.equal(nextPlan("pro"), null);
});

test("the tier limits themselves are unchanged", () => {
  // The ask was to remove the tags from the UI, not to loosen enforcement.
  const basic = getTierConfig("basic");
  const pro = getTierConfig("pro");
  assert.equal(basic.maxAgents, 3);
  assert.equal(basic.maxToolsPerAgent, 2);
  assert.equal(basic.maxKnowledgeBases, 1);
  assert.equal(basic.maxMemories, 1);
  assert.equal(pro.maxAgents, 50);
  assert.equal(pro.monthlyTokenBudget, null);
});

// --------------------------------------------------------------------------- //
// against the real seed
// --------------------------------------------------------------------------- //
test("every seeded tenant produces a usage record without throwing", () => {
  const input = {
    tenants: store.tenants,
    agents: store.agents,
    workflows: store.workflows,
    records: store.records,
  };
  for (const t of store.tenants) {
    const u = tenantUsage(t.id, input);
    assert.ok(u.agents >= 0 && u.descendants >= 0, `${t.tenantId} usage is sane`);
    const cap = tenantCapacity(u, getTierConfig(t.tier), planLabel(t.tier));
    assert.equal(cap.lines.length, 1);
    // No tenant in the seed should already be over its agent limit; if one is,
    // the seed itself violates a rule the API enforces on create.
    assert.ok(
      u.agents <= getTierConfig(t.tier).maxAgents,
      `${t.tenantId} has ${u.agents} agents, over its limit of ` +
        `${getTierConfig(t.tier).maxAgents}`
    );
  }
});

test("the seeded agents' tenants resolve, so the console cannot show an orphan", () => {
  const ids = new Set(store.tenants.map((t) => t.id));
  for (const a of store.agents) {
    assert.ok(ids.has(a.tenantId),
      `agent '${a.name}' references tenant '${a.tenantId}', which does not exist`);
  }
});
