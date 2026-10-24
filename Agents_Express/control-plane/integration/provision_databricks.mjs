// Idempotent provisioning + live proof of the Databricks execution plane.
//
// WHY: the control plane keeps registries, catalog models, agents and workflows
// in an in-memory store, so a restart drops them. This re-creates the whole
// Databricks demo path in one command and then PROVES it by running a workflow
// whose steps execute on real Databricks Model Serving endpoints.
//
// It talks to the control plane over HTTP only — the same API the UI uses — so
// it exercises the real validation, the plane-agreement guard and the audit.
//
// NO SECRET IS SENT: catalog models carry only `tokenEnvVar` (a reference); the
// server resolves DATABRICKS_TOKEN itself at execution time.
//
// Usage:
//   DATABRICKS_HOST=… DATABRICKS_TOKEN=… \
//   node integration/provision_databricks.mjs
//
// Env:
//   CONTROL_PLANE_URL  base URL incl. basePath [http://localhost:3000/proxy/3000]
//   DBX_TENANT         owning tenant id        [fn-supply]

import assert from "node:assert";

// Maker-checker: a named submitter, and a DIFFERENT approver (lib/approvals.ts).
const SUBMITTER = process.env.SUBMITTER_PERSONA_ID || "persona-john";
const REVIEWER = process.env.REVIEWER_PERSONA_ID || "persona-mary";
const actorFor = (status) =>
  status === "Pending approval" ? { submitterPersonaId: SUBMITTER } : { reviewerPersonaId: REVIEWER };

const BASE = (process.env.CONTROL_PLANE_URL || "http://localhost:3000/proxy/3000").replace(/\/+$/, "");
const TENANT = process.env.DBX_TENANT || "fn-supply";

/** Live, READY pay-per-token endpoints verified in this workspace. */
const ENDPOINTS = [
  { label: "DBX Llama 3.3 70B", vendor: "Meta", endpoint: "databricks-meta-llama-3-3-70b-instruct" },
  { label: "DBX Qwen3 Next 80B", vendor: "Qwen", endpoint: "databricks-qwen3-next-80b-a3b-instruct" },
  { label: "DBX GPT-OSS 120B", vendor: "OpenAI", endpoint: "databricks-gpt-oss-120b" },
];

/** Agentic-workload runtimes to attach agents to (all Databricks). */
const AGENT_RUNTIMES = [
  "databricks-agent-runtime",
  "databricks-apps-custom",
  "databricks-lakeflow-jobs-agent",
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

async function main() {
  assert(process.env.DATABRICKS_TOKEN, "DATABRICKS_TOKEN must be set in the SERVER's environment too");
  console.log(`control plane : ${BASE}`);
  console.log(`tenant        : ${TENANT}`);
  console.log(`token         : via env reference DATABRICKS_TOKEN (never sent)\n`);

  // ---- 1. registry + governed records -------------------------------------
  const existing = await api("/api/registry", { method: "GET" });
  assert(existing.status === 200, `GET /api/registry failed: ${existing.status}`);
  let registry = (existing.body.registries ?? []).find((r) => r.name === "Databricks_Runtime_Registry");
  if (!registry) {
    const r = await api("/api/registry", {
      method: "POST",
      body: JSON.stringify({
        kind: "registry",
        name: "Databricks_Runtime_Registry",
        description: "Databricks serving endpoints, jobs and UC assets approved for agent use.",
        autoApproval: false,
      }),
    });
    assert(r.status === 201, `create registry failed: ${JSON.stringify(r.body)}`);
    registry = r.body;
  }
  console.log(`registry      : ${registry.id} (${registry.name})`);

  const wanted = [
    ["Databricks_FM_Llama33_70B", "FM API endpoint databricks-meta-llama-3-3-70b-instruct (pay-per-token)"],
    ["Databricks_FM_GPT_OSS_120B", "FM API endpoint databricks-gpt-oss-120b (pay-per-token)"],
    ["Databricks_UC_Suppliers_Table", "UC table workspace.default.agentexpress_suppliers"],
  ];
  for (const [name, description] of wanted) {
    const have = (existing.body.records ?? []).find((x) => x.name === name);
    if (have && have.status === "Approved") {
      console.log(`record        : ${name} already Approved`);
      continue;
    }
    const created = have
      ? { body: have }
      : await api("/api/registry", {
          method: "POST",
          body: JSON.stringify({
            kind: "record",
            registryId: registry.id,
            name,
            description,
            recordSource: "define-manually",
            type: "Custom",
            credentialType: "API key",
          }),
        });
    const id = created.body.id;
    // Draft -> Pending approval -> Approved
    for (const status of ["Pending approval", "Approved"]) {
      const t = await api("/api/registry", { method: "PATCH", body: JSON.stringify({ id, status, ...actorFor(status) }) });
      if (t.status !== 200) break; // already further along
    }
    console.log(`record        : ${name} -> Approved`);
  }

  // ---- 2. catalog models (Databricks Model Serving) -----------------------
  const catalog = await api("/api/catalog", { method: "GET" });
  const modelIds = [];
  for (const { label, vendor, endpoint } of ENDPOINTS) {
    let model = (catalog.body ?? []).find((m) => m.modelId === endpoint);
    if (!model) {
      const r = await api("/api/catalog", {
        method: "POST",
        body: JSON.stringify({
          name: label,
          modelProvider: vendor,
          modelId: endpoint,
          inferenceProvider: "Databricks Model Serving",
          tokenEnvVar: "DATABRICKS_TOKEN",
        }),
      });
      assert(r.status === 201, `add model '${label}' failed: ${JSON.stringify(r.body)}`);
      model = r.body;
    }
    modelIds.push(model.id);
    console.log(`model         : ${model.id} -> ${endpoint}`);
  }

  // ---- 3. agents on Databricks runtime pairs ------------------------------
  const agents = await api("/api/agents", { method: "GET" });
  for (let i = 0; i < AGENT_RUNTIMES.length; i++) {
    const agentRuntimeId = AGENT_RUNTIMES[i];
    const name = `DBX_Agent_${agentRuntimeId.replace(/^databricks-/, "")}`;
    if ((agents.body ?? []).some((a) => a.name === name)) {
      console.log(`agent         : ${name} already present`);
      continue;
    }
    const r = await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: `Agent on ${agentRuntimeId} using Databricks FM API pay-per-token`,
        tenantId: TENANT,
        modelId: modelIds[i % modelIds.length],
        systemPrompt: "You analyse supplier contract data.",
        compute: { agentRuntimeId, modelRuntimeId: "databricks-fm-api-pay-per-token" },
        visibility: "public",
        status: "ready",
      }),
    });
    assert(r.status === 201, `create agent '${name}' failed: ${JSON.stringify(r.body)}`);
    console.log(`agent         : ${name} -> ${agentRuntimeId} + ${r.body.compute.modelRuntimeId}`);
  }

  // ---- 4. the plane-agreement guard must still bite ----------------------
  const bad = await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      name: "DBX_Agent_WrongPlane_Probe",
      tenantId: TENANT,
      modelId: modelIds[0],
      compute: { agentRuntimeId: "aws-agentcore-runtime", modelRuntimeId: "aws-bedrock" },
    }),
  });
  assert(bad.status === 400, `plane-mismatch guard did not fire (got ${bad.status})`);
  console.log(`guard         : Databricks model + aws-bedrock runtime rejected (400)`);

  // ---- 5. workflow that EXECUTES on Databricks ---------------------------
  const wf = await api("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      op: "create",
      name: "Databricks_Supplier_Analysis",
      description: "Multi-step analysis executed on Databricks Model Serving",
      tenantId: TENANT,
      steps: [
        { id: "s1", name: "Extractor", modelId: modelIds[0], prompt: "List the therapeutic areas and their total fees from the task. Be terse.", toolRefs: [], knowledgeRefs: [], reviewGate: false },
        { id: "s2", name: "Analyst", modelId: modelIds[1], prompt: "Using the prior step, name the highest-spend therapeutic area in one sentence.", toolRefs: [], knowledgeRefs: [], reviewGate: false },
        { id: "s3", name: "Reviewer", modelId: modelIds[2], prompt: "State in one line whether the analysis is consistent with the input.", toolRefs: [], knowledgeRefs: [], reviewGate: false },
      ],
    }),
  });
  assert(wf.status === 201, `create workflow failed: ${JSON.stringify(wf.body)}`);
  console.log(`workflow      : ${wf.body.id}`);

  const run = await api("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      op: "start",
      workflowId: wf.body.id,
      input:
        "Supplier contract fees from workspace.default.agentexpress_suppliers: " +
        "Oncology 2 contracts totalling 365000; Cardiology 1 contract 318000; Neurology 1 contract 61000.",
    }),
  });
  assert(run.status === 201, `start run failed: ${JSON.stringify(run.body)}`);
  const r = run.body;
  console.log(`\nrun           : ${r.status} | ${r.totalTokens} tokens`);
  for (const s of r.steps) {
    console.log(`  [${s.name}] ${s.status}`);
    console.log(`    executed on : ${s.modelId}`);
    console.log(`    usage       : ${JSON.stringify(s.usage)} | ${s.latencyMs}ms | costUsd=${s.costUsd}`);
    console.log(`    output      : ${JSON.stringify((s.output || "").slice(0, 110))}`);
    if (s.error) console.log(`    error       : ${s.error}`);
  }

  assert(r.status === "completed", `run did not complete: ${r.status}`);
  const onDbx = r.steps.filter((s) => (s.modelId || "").startsWith("databricks:"));
  assert(onDbx.length === r.steps.length, "not every step executed on Databricks");
  console.log(`\nDATABRICKS PROVISIONING OK — ${onDbx.length}/${r.steps.length} steps ran on Databricks`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nDATABRICKS PROVISIONING FAILED:", e.message);
    process.exit(1);
  });
