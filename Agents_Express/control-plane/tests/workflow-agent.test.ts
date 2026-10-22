// Offline tests for agent-bound workflow steps.
//
// This is the join between the platform's governance half (/agents) and its
// execution half (/workflows). The resolver is pure, so inheritance, tenancy,
// plane agreement and fail-closed behaviour are all testable without network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  StepResolutionError,
  composePrompt,
  executorFor,
  hasAgentBoundStep,
  isAncestorTenant,
  resolveStep,
} from "../src/lib/workflow/resolve.ts";
import {
  RUN_AGENT_ACTION,
  WORKFLOW_PERIMETER_TOOL,
  agentScopedPolicyExists,
  agentScopedTool,
  authorizeAgentStep,
} from "../src/lib/workflow/govern.ts";
import { store } from "../src/lib/store.ts";
import type {
  AgentConfig,
  CatalogModel,
  RegistryRecord,
  WorkflowStep,
} from "../src/lib/types.ts";

// --------------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------------- //

const bedrockModel: CatalogModel = {
  id: "m-bedrock",
  name: "Claude",
  modelProvider: "Anthropic",
  modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  inferenceProvider: "Amazon Bedrock",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const dbxModel: CatalogModel = {
  id: "m-dbx",
  name: "DBX Llama",
  modelProvider: "Meta",
  modelId: "databricks-meta-llama-3-3-70b-instruct",
  inferenceProvider: "Databricks Model Serving",
  tokenEnvVar: "DATABRICKS_TOKEN",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "a-1",
    name: "Supplier Analyst",
    description: "",
    tenantId: "fn-supply",
    memoryRefs: [],
    modelId: "m-dbx",
    systemPrompt: "You analyse supplier contracts.",
    toolRefs: [],
    knowledgeRefs: [],
    compute: {
      agentRuntimeId: "databricks-agent-runtime",
      modelRuntimeId: "databricks-fm-api-pay-per-token",
    },
    visibility: "public",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function step(over: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: "s1",
    name: "Analyst",
    prompt: "Summarize the spend.",
    toolRefs: [],
    knowledgeRefs: [],
    reviewGate: false,
    ...over,
  };
}

const approvedKb: RegistryRecord = {
  id: "rec-kb-ok",
  registryId: "r1",
  name: "Docs_KB",
  description: "",
  recordSource: "define-manually",
  type: "Knowledge Base",
  credentialType: "API key",
  status: "Approved",
  tools: [],
  owner: "t",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const draftKb: RegistryRecord = { ...approvedKb, id: "rec-kb-draft", status: "Draft" };
const approvedTool: RegistryRecord = {
  ...approvedKb,
  id: "rec-tool",
  name: "expense_tool",
  type: "Custom",
  tools: ["submitExpense", "listMyExpenses"],
};

function ctx(over: Partial<Parameters<typeof resolveStep>[1]> = {}) {
  return {
    agents: [agent()],
    models: [bedrockModel, dbxModel],
    records: [approvedKb, draftKb, approvedTool],
    tenants: store.tenants,
    workflowTenantId: "fn-supply",
    ...over,
  };
}

// --------------------------------------------------------------------------- //
// Inheritance
// --------------------------------------------------------------------------- //

test("agent-bound step inherits model, prompt and runtime", () => {
  const r = resolveStep(step({ agentId: "a-1" }), ctx());
  assert.equal(r.agent?.id, "a-1");
  assert.equal(r.step.modelId, "m-dbx");
  assert.equal(r.executor, "databricks");
  // Both prompts are kept, agent persona first.
  assert.equal(r.step.prompt, "You analyse supplier contracts.\n\nSummarize the spend.");
});

test("a model-only step behaves exactly as before", () => {
  const r = resolveStep(step({ modelId: "m-bedrock" }), ctx());
  assert.equal(r.agent, null);
  assert.equal(r.executor, "bedrock");
  assert.equal(r.step.prompt, "Summarize the spend.");
  assert.deepEqual(r.notes, []);
});

test("an explicit step model overrides the agent's, and says so", () => {
  const a = agent({ modelId: "m-dbx", compute: { agentRuntimeId: "aws-agentcore-runtime", modelRuntimeId: "aws-bedrock" } });
  const r = resolveStep(step({ agentId: "a-1", modelId: "m-bedrock" }), ctx({ agents: [a] }));
  assert.equal(r.step.modelId, "m-bedrock");
  assert.equal(r.executor, "bedrock");
  assert.ok(r.notes.some((n) => /overrides the agent's model/.test(n)));
});

test("composePrompt keeps whichever half is present", () => {
  assert.equal(composePrompt("A", "B"), "A\n\nB");
  assert.equal(composePrompt("", "B"), "B");
  assert.equal(composePrompt("A", ""), "A");
  assert.equal(composePrompt("", ""), "");
});

test("executorFor maps the provider to the execution plane", () => {
  assert.equal(executorFor(dbxModel), "databricks");
  assert.equal(executorFor(bedrockModel), "bedrock");
});

// --------------------------------------------------------------------------- //
// Fail-closed resolution
// --------------------------------------------------------------------------- //

test("unknown agent, unready agent, and missing model all fail closed", () => {
  assert.throws(
    () => resolveStep(step({ agentId: "nope" }), ctx()),
    (e: Error) => e instanceof StepResolutionError && /does not exist/.test(e.message)
  );
  assert.throws(
    () => resolveStep(step({ agentId: "a-1" }), ctx({ agents: [agent({ status: "draft" })] })),
    (e: Error) => e instanceof StepResolutionError && /only a ready agent/.test(e.message)
  );
  assert.throws(
    () => resolveStep(step({ agentId: "a-1" }), ctx({ models: [bedrockModel] })),
    (e: Error) => e instanceof StepResolutionError && /not in the catalog/.test(e.message)
  );
  assert.throws(
    () => resolveStep(step(), ctx()),
    (e: Error) => e instanceof StepResolutionError && /no modelId and no agentId/.test(e.message)
  );
});

test("plane disagreement between agent runtime and model is refused", () => {
  // Databricks runtime, Bedrock-served model.
  assert.throws(
    () =>
      resolveStep(
        step({ agentId: "a-1" }),
        ctx({ agents: [agent({ modelId: "m-bedrock" })] })
      ),
    (e: Error) => e instanceof StepResolutionError && /served by/.test(e.message)
  );
  // AWS runtime, Databricks-served model.
  assert.throws(
    () =>
      resolveStep(
        step({ agentId: "a-1" }),
        ctx({
          agents: [
            agent({
              modelId: "m-dbx",
              compute: { agentRuntimeId: "aws-agentcore-runtime", modelRuntimeId: "aws-bedrock" },
            }),
          ],
        })
      ),
    (e: Error) => e instanceof StepResolutionError && /Databricks Model Serving/.test(e.message)
  );
});

test("cross-tenant execution is refused, ancestor tenants are allowed", () => {
  // fn-supply agent, workflow in an unrelated tenant.
  assert.throws(
    () => resolveStep(step({ agentId: "a-1" }), ctx({ workflowTenantId: "bu-japan" })),
    (e: Error) => e instanceof StepResolutionError && /cross-tenant/.test(e.message)
  );
  // An agent owned by the root org may serve a child tenant's workflow.
  const rootAgent = agent({ tenantId: "takeda" });
  const r = resolveStep(step({ agentId: "a-1" }), ctx({ agents: [rootAgent], workflowTenantId: "fn-supply" }));
  assert.equal(r.agent?.tenantId, "takeda");
});

test("isAncestorTenant walks the real seeded org tree", () => {
  assert.equal(isAncestorTenant("takeda", "fn-supply", store.tenants), true);
  assert.equal(isAncestorTenant("fn-finance", "fn-procurement", store.tenants), true);
  assert.equal(isAncestorTenant("fn-supply", "takeda", store.tenants), false);
  assert.equal(isAncestorTenant("bu-japan", "fn-supply", store.tenants), false);
});

// --------------------------------------------------------------------------- //
// Tools and knowledge bases — approved-only, and honest about execution
// --------------------------------------------------------------------------- //

test("only Approved knowledge bases are carried; others are noted and skipped", () => {
  const a = agent({ knowledgeRefs: ["rec-kb-ok", "rec-kb-draft", "missing"] });
  const r = resolveStep(step({ agentId: "a-1" }), ctx({ agents: [a] }));
  assert.deepEqual(r.knowledgeRefs, ["rec-kb-ok"]);
  assert.equal(r.notes.filter((n) => /knowledge base/.test(n)).length, 2);
});

test("approved-but-unimplemented tools are flagged as NOT invoked", () => {
  // The seeded expense tools have no implementation in lib/tools/registry.ts,
  // so they must be reported rather than silently dropped or implied to run.
  const a = agent({ toolRefs: ["rec-tool"] });
  const r = resolveStep(step({ agentId: "a-1" }), ctx({ agents: [a] }));
  assert.deepEqual(r.resolvedTools, ["submitExpense", "listMyExpenses"]);
  assert.equal(r.executableTools.length, 0);
  assert.ok(
    r.notes.some((n) => /no implementation and are NOT invoked/.test(n)),
    "must not imply execution for a tool the platform cannot run"
  );
});

test("approved AND implemented tools become executable and are offered", () => {
  const ucRecord: RegistryRecord = {
    ...approvedTool,
    id: "rec-uc",
    name: "unity_catalog_tools",
    tools: ["uc_list_tables", "uc_query", "not_a_real_tool"],
  };
  const a = agent({ toolRefs: ["rec-uc"] });
  const r = resolveStep(
    step({ agentId: "a-1" }),
    ctx({ agents: [a], records: [ucRecord] })
  );
  assert.deepEqual(
    r.executableTools.map((t) => t.name),
    ["uc_list_tables", "uc_query"]
  );
  assert.ok(r.notes.some((n) => /executable tool\(s\) offered to the model/.test(n)));
  // The unimplemented one is still reported.
  assert.ok(r.notes.some((n) => /not_a_real_tool/.test(n)));
});

test("a non-approved tool record is skipped with a note", () => {
  const a = agent({ toolRefs: ["rec-kb-draft"] });
  const r = resolveStep(step({ agentId: "a-1" }), ctx({ agents: [a] }));
  assert.deepEqual(r.resolvedTools, []);
  assert.ok(r.notes.some((n) => /not Approved/.test(n)));
});

test("hasAgentBoundStep detects whether a run needs a persona", () => {
  assert.equal(hasAgentBoundStep([step({ modelId: "m-bedrock" })]), false);
  assert.equal(hasAgentBoundStep([step({ modelId: "m-bedrock" }), step({ agentId: "a-1" })]), true);
});

// --------------------------------------------------------------------------- //
// Cedar: runAgent, two stages
// --------------------------------------------------------------------------- //

test("runAgent constants and the seeded perimeter policy line up", () => {
  assert.equal(RUN_AGENT_ACTION, "runAgent");
  assert.equal(WORKFLOW_PERIMETER_TOOL, "workflow");
  assert.equal(agentScopedTool("a-1"), "workflow:a-1");
  const a = authorizeAgentStep("agent-expense-assistant", "persona-john");
  assert.equal(a.perimeter.allowed, true);
  assert.equal(a.perimeter.matchedPolicyId, "pol-gw-run-agent-perimeter");
  assert.equal(a.agentScoped.evaluated, false);
  assert.equal(a.allowed, true);
});

test("an agent-scoped policy becomes authoritative and can deny", () => {
  const agentId = "agent-expense-assistant";
  store.policies.unshift({
    id: "pol-test-run-agent-scoped",
    name: "Test: only directors may run this agent",
    layer: "gateway",
    description: "test-only",
    enabled: true,
    createdAt: new Date().toISOString(),
    cedar: `permit(
  principal,
  action == Action::"runAgent",
  resource == Tool::"${agentScopedTool(agentId)}"
) when { principal.role == "director" };`,
  });
  try {
    assert.equal(agentScopedPolicyExists(store.policies, agentId), true);
    const mgr = authorizeAgentStep(agentId, "persona-john"); // manager
    assert.equal(mgr.perimeter.allowed, true);
    assert.equal(mgr.agentScoped.evaluated, true);
    assert.equal(mgr.allowed, false, "a manager must be denied by the agent-scoped rule");

    const dir = authorizeAgentStep(agentId, "persona-mary"); // director
    assert.equal(dir.allowed, true);
  } finally {
    store.policies = store.policies.filter((p) => p.id !== "pol-test-run-agent-scoped");
  }
});

test("an unknown persona is denied and stage 2 is skipped", () => {
  const a = authorizeAgentStep("agent-expense-assistant", "persona-ghost");
  assert.equal(a.allowed, false);
  assert.equal(a.agentScoped.evaluated, false);
});
