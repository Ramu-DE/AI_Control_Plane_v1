// Idempotent provisioning + live proof of the Unity Catalog AGENT.
//
// Builds the whole governed path and then runs it for real:
//   registry record (declares the UC tool schema)  -> Approved
//   catalog model   (tool-capable Databricks endpoint)
//   agent           (UC_Catalog_Explorer, toolRefs -> that record)
//   workflow        (one step BOUND to the agent)
//   run             (model calls uc_list_tables; platform executes it)
//
// This is the first path where an agent's tools are genuinely INVOKED: the
// model chooses the tool and arguments, lib/tools/uc.ts executes read-only
// against Databricks, and the answer is built from the returned rows.
//
// Usage:
//   DATABRICKS_HOST=… DATABRICKS_TOKEN=… DATABRICKS_WAREHOUSE_ID=… \
//   node integration/provision_uc_agent.mjs
//
// Env:
//   CONTROL_PLANE_URL  [http://localhost:3000/proxy/3000]
//   UC_CATALOG         [workspace]
//   UC_SCHEMA          [default]
//   UC_TENANT          [fn-ddt]
//   UC_PERSONA         [persona-mary]

import assert from "node:assert";

const BASE = (process.env.CONTROL_PLANE_URL || "http://localhost:3000/proxy/3000").replace(/\/+$/, "");
const CATALOG = process.env.UC_CATALOG || "workspace";
const SCHEMA = process.env.UC_SCHEMA || "default";
const TENANT = process.env.UC_TENANT || "fn-ddt";
const PERSONA = process.env.UC_PERSONA || "persona-mary";
const ENDPOINT = "databricks-meta-llama-3-3-70b-instruct"; // verified tool-calling

const TOOL_SCHEMA = [
  {
    name: "uc_list_tables",
    description: "List tables in a Unity Catalog schema",
    inputSchema: {
      type: "object",
      required: ["catalog", "schema"],
      properties: { catalog: { type: "string" }, schema: { type: "string" } },
    },
  },
  {
    name: "uc_describe_table",
    description: "Describe one Unity Catalog table",
    inputSchema: {
      type: "object",
      required: ["full_name"],
      properties: { full_name: { type: "string" } },
    },
  },
  {
    name: "uc_query",
    description: "Run a single read-only SQL statement",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: { sql: { type: "string" } },
    },
  },
];

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

async function approve(id) {
  for (const status of ["Pending approval", "Approved"]) {
    await api("/api/registry", { method: "PATCH", body: JSON.stringify({ id, status }) });
  }
}

async function main() {
  assert(process.env.DATABRICKS_TOKEN, "the SERVER needs DATABRICKS_TOKEN in its environment");
  console.log(`control plane : ${BASE}`);
  console.log(`unity catalog : ${CATALOG}.${SCHEMA}`);
  console.log(`tenant/persona: ${TENANT} / ${PERSONA}\n`);

  // ---- 1. registry record declaring the executable tools ------------------
  const reg0 = await api("/api/registry", { method: "GET" });
  assert(reg0.status === 200, "GET /api/registry failed");
  let registry = (reg0.body.registries ?? []).find((r) => r.name === "Databricks_UC_Tools");
  if (!registry) {
    const r = await api("/api/registry", {
      method: "POST",
      body: JSON.stringify({
        kind: "registry",
        name: "Databricks_UC_Tools",
        description: "Executable Unity Catalog tools",
        autoApproval: false,
      }),
    });
    assert(r.status === 201, `create registry failed: ${JSON.stringify(r.body)}`);
    registry = r.body;
  }
  console.log(`registry      : ${registry.id}`);

  let record = (reg0.body.records ?? []).find((x) => x.name === "unity_catalog_tools");
  if (!record) {
    const r = await api("/api/registry", {
      method: "POST",
      body: JSON.stringify({
        kind: "record",
        registryId: registry.id,
        name: "unity_catalog_tools",
        description:
          "Read-only Unity Catalog access: list tables, describe a table, run a read-only query.",
        recordSource: "define-manually",
        type: "Custom",
        credentialType: "API key",
        mcpSchema: { name: "UnityCatalogTools", version: "1.0.0", toolSchema: TOOL_SCHEMA },
      }),
    });
    assert(r.status === 201, `create record failed: ${JSON.stringify(r.body)}`);
    record = r.body;
  }
  if (record.status !== "Approved") await approve(record.id);
  console.log(`tool record   : ${record.id} -> Approved (${record.tools.join(", ")})`);

  // ---- 2. tool-capable catalog model -------------------------------------
  const cat = await api("/api/catalog", { method: "GET" });
  let model = (cat.body ?? []).find((m) => m.modelId === ENDPOINT);
  if (!model) {
    const r = await api("/api/catalog", {
      method: "POST",
      body: JSON.stringify({
        name: "DBX Llama 3.3 70B (tools)",
        modelProvider: "Meta",
        modelId: ENDPOINT,
        inferenceProvider: "Databricks Model Serving",
        tokenEnvVar: "DATABRICKS_TOKEN",
      }),
    });
    assert(r.status === 201, `add model failed: ${JSON.stringify(r.body)}`);
    model = r.body;
  }
  console.log(`model         : ${model.id} -> ${ENDPOINT}`);

  // ---- 3. the agent ------------------------------------------------------
  const ags = await api("/api/agents", { method: "GET" });
  let agent = (ags.body ?? []).find((a) => a.name === "UC_Catalog_Explorer");
  if (!agent) {
    const r = await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "UC_Catalog_Explorer",
        description:
          "Queries Unity Catalog: lists tables, describes schemas, runs read-only SQL.",
        tenantId: TENANT,
        modelId: model.id,
        systemPrompt:
          "You are a Unity Catalog data steward. Answer strictly from tool results. " +
          "Never invent table or column names.",
        toolRefs: [record.id],
        knowledgeRefs: [],
        compute: {
          agentRuntimeId: "databricks-agent-runtime",
          modelRuntimeId: "databricks-fm-api-pay-per-token",
        },
        visibility: "public",
        status: "ready",
      }),
    });
    assert(r.status === 201, `create agent failed: ${JSON.stringify(r.body)}`);
    agent = r.body;
  }
  console.log(`agent         : ${agent.id} (${agent.compute.agentRuntimeId})`);

  // ---- 4. workflow bound to the agent ------------------------------------
  const wfs = await api("/api/workflows", { method: "GET" });
  let workflow = (wfs.body.workflows ?? []).find((w) => w.name === "UC_Catalog_Inventory");
  if (!workflow) {
    const r = await api("/api/workflows", {
      method: "POST",
      body: JSON.stringify({
        op: "create",
        name: "UC_Catalog_Inventory",
        description: "Agent lists every table in Unity Catalog and summarizes the schema",
        tenantId: TENANT,
        steps: [
          {
            id: "s1",
            name: "Catalog Explorer",
            agentId: agent.id,
            prompt:
              `List every table in catalog '${CATALOG}', schema '${SCHEMA}'. For each table give ` +
              `its name and column count, then state the total number of tables.`,
            toolRefs: [],
            knowledgeRefs: [],
            reviewGate: false,
          },
        ],
      }),
    });
    assert(r.status === 201, `create workflow failed: ${JSON.stringify(r.body)}`);
    workflow = r.body;
  }
  console.log(`workflow      : ${workflow.id}`);

  // ---- 5. RUN IT ---------------------------------------------------------
  const run = await api("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      op: "start",
      workflowId: workflow.id,
      personaId: PERSONA,
      input: `Inventory the Unity Catalog ${CATALOG}.${SCHEMA} schema.`,
    }),
  });
  assert(run.status === 201, `start run failed: ${JSON.stringify(run.body)}`);
  const r = run.body;
  const step = r.steps[0];
  console.log(`\nrun           : ${r.status} | ${r.totalTokens} tokens`);
  console.log(`  as agent    : ${step.provenance?.agentName} (${step.provenance?.executor})`);
  console.log(`  invoked     : ${step.modelId} | ${step.latencyMs}ms`);
  for (const c of step.toolCalls ?? []) {
    console.log(`  TOOL ${c.name} ok=${c.ok} ${c.latencyMs}ms args=${JSON.stringify(c.arguments)}`);
  }
  console.log("  answer      :");
  for (const line of (step.output || "").split("\n").slice(0, 12)) {
    console.log(`    ${line}`);
  }

  // ---- 6. assert it was REAL --------------------------------------------
  assert(r.status === "completed", `run did not complete: ${r.status}`);
  const calls = step.toolCalls ?? [];
  assert(calls.length > 0, "the model made no tool calls — the answer would be ungrounded");
  assert(
    calls.some((c) => c.name === "uc_list_tables" && c.ok),
    "uc_list_tables did not execute successfully"
  );
  assert(
    step.provenance?.executor === "databricks",
    `expected databricks execution, got ${step.provenance?.executor}`
  );

  console.log(`\nUC AGENT PROVISIONING OK — ${calls.length} real tool call(s) executed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nUC AGENT PROVISIONING FAILED:", e.message);
    process.exit(1);
  });
