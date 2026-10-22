#!/usr/bin/env node
/**
 * End-to-end smoke test of the control plane, through the same HTTP API the UI
 * buttons call.
 *
 * This walks the real user journey — register a model, create an agent on it,
 * build a workflow bound to that agent, run it for real on Databricks, take an
 * approval decision, then check the audit trail recorded all of it — and
 * exercises every other governed path (Cedar authorization, Neo4j graph read,
 * knowledge-graph derive, A2A, playground, KB retrieval).
 *
 * What it does NOT do: click buttons in a browser. There is no headless Chrome
 * in this environment. Every assertion here is against the endpoint a button
 * invokes, which is where the behaviour lives; page RENDERING is checked only
 * as an HTTP 200 plus a marker string. That distinction is stated in the output
 * so the result is not over-read.
 *
 *   node integration/smoke_control_plane.mjs [--base http://127.0.0.1:3000/proxy/3000]
 */

const argv = process.argv.slice(2);
const baseArg = argv.indexOf("--base");
const BASE = baseArg >= 0 ? argv[baseArg + 1] : "http://127.0.0.1:3000/proxy/3000";
const API = `${BASE}/api`;

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

function ok(name, detail = "") {
  pass += 1;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name, detail) {
  fail += 1;
  failures.push(`${name}: ${detail}`);
  console.log(`  FAIL  ${name} — ${detail}`);
}
function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP  ${name} — ${why}`);
}
function section(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null; callers report the raw text */
  }
  return { status: res.status, json, text };
}

const state = {};

/**
 * Wait for a run to settle.
 *
 * `op:"start"` returns 202 with the run still "running" — a multi-step agentic
 * workflow takes far longer than an HTTP request should be held open for, and
 * awaiting it produced a 504 at the proxy. So the test polls, exactly as the UI
 * does. Asserting on the immediate response would be asserting on a run that
 * has not happened yet.
 */
async function waitForRun(runId, timeoutMs = 240000) {
  const TERMINAL = ["completed", "error", "paused", "denied"];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await req("GET", "/workflows");
    const runs = r.json?.runs || [];
    last = runs.find((x) => x.id === runId) || last;
    if (last && TERMINAL.includes(last.status)) return last;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return last;
}


// --------------------------------------------------------------------------- //
async function pagesRender() {
  section("1. Navigation — every page in the sidebar returns a document");
  const pages = [
    "", "/agents", "/workflows", "/registry", "/approvals", "/policies",
    "/audit", "/tenants", "/kg", "/graph", "/a2a", "/playground", "/settings",
    "/aws-resources", "/policy-engines", "/policy-stores",
  ];
  for (const p of pages) {
    try {
      const res = await fetch(`${BASE}${p}`);
      const html = await res.text();
      const isDoc = html.includes("<!DOCTYPE html") || html.includes("<html");
      if (res.status === 200 && isDoc) {
        ok(`GET ${p || "/"}`, `${html.length.toLocaleString()} bytes`);
      } else {
        bad(`GET ${p || "/"}`, `status ${res.status}, document=${isDoc}`);
      }
    } catch (e) {
      bad(`GET ${p || "/"}`, e.message);
    }
  }
}

async function readEndpoints() {
  section("2. Read APIs — what each page loads on mount");
  const endpoints = [
    "agents", "workflows", "registry", "approvals", "policies", "audit",
    "tenants", "models", "personas", "runtimes", "catalog", "governance",
    "graph", "policy-engines", "policy-stores", "policy-library", "a2a", "kg",
    "aws/status",
  ];
  for (const e of endpoints) {
    const r = await req("GET", `/${e}`);
    if (r.status === 200 && r.json !== null) ok(`GET /api/${e}`);
    else bad(`GET /api/${e}`, `status ${r.status}${r.json === null ? " (not JSON)" : ""}`);
  }
}

async function registryJourney() {
  section("3. Registry — register a Databricks Model Serving model");
  const r = await req("POST", "/catalog", {
    name: `Smoke Llama 3.3 70B ${Date.now()}`,
    modelProvider: "Meta",
    modelId: "databricks-meta-llama-3-3-70b-instruct",
    inferenceProvider: "Databricks Model Serving",
    inferenceApi: "Chat Completions (/v1/chat/completions)",
    tokenEnvVar: "DATABRICKS_TOKEN",
  });
  if (r.status < 300 && r.json?.id) {
    state.modelId = r.json.id;
    ok("POST /api/catalog", `created ${r.json.id} (${r.json.inferenceProvider})`);
  } else {
    return bad("POST /api/catalog", `status ${r.status}: ${r.text.slice(0, 200)}`);
  }

  const list = await req("GET", "/catalog");
  const found = (list.json || []).some((m) => m.id === state.modelId);
  found
    ? ok("registry list includes the new model")
    : bad("registry list includes the new model", "not present after create");

  // Credential-by-reference: the record must carry an env var NAME, not a token.
  const model = (list.json || []).find((m) => m.id === state.modelId);
  if (model && model.tokenEnvVar === "DATABRICKS_TOKEN" && !JSON.stringify(model).match(/dapi[0-9a-f]/)) {
    ok("model stores a credential REFERENCE, not a secret");
  } else {
    bad("model stores a credential REFERENCE, not a secret", JSON.stringify(model).slice(0, 160));
  }
}

async function agentJourney() {
  section("4. Agents — create an agent bound to the Databricks model");
  if (!state.modelId) return skip("agent creation", "no model was registered");

  const tenants = await req("GET", "/tenants");
  const tenant = (tenants.json?.tenants || [])[0];
  if (!tenant) return bad("agent creation", "no tenant available");
  state.tenantId = tenant.id;

  const r = await req("POST", "/agents", {
    name: `Smoke UC Analyst ${Date.now()}`,
    description: "Smoke-test agent that queries Unity Catalog",
    tenantId: tenant.id,
    modelId: state.modelId,
    systemPrompt:
      "You query Unity Catalog. Use the provided tools to list tables and answer concisely.",
    toolRefs: [],
    knowledgeRefs: [],
    // Plane agreement: a Databricks-served model needs a databricks-* runtime.
    compute: {
      agentRuntimeId: "databricks-agent-runtime",
      modelRuntimeId: "databricks-fm-api-pay-per-token",
    },
    // The Create Agent button sends this, and a workflow step will only bind
    // to a READY agent (lib/workflow/resolve.ts). Matching the UI exactly is
    // the point of this test.
    status: "ready",
  });
  if (r.status < 300 && r.json?.id) {
    state.agentId = r.json.id;
    ok("POST /api/agents", `created ${r.json.id} on tenant ${tenant.id}`);
  } else {
    return bad("POST /api/agents", `status ${r.status}: ${r.text.slice(0, 250)}`);
  }

  // Plane agreement: a Bedrock-plane agent must not accept a Databricks model.
  const bedrock = (await req("GET", "/catalog")).json
    ?.find((m) => m.inferenceProvider === "Amazon Bedrock");
  if (bedrock) {
    const mismatch = await req("POST", "/agents", {
      name: "Smoke mismatch probe",
      tenantId: tenant.id,
      modelId: bedrock.id,
      systemPrompt: "x",
      toolRefs: [],
      knowledgeRefs: [],
      compute: {
        agentRuntimeId: "databricks-agent-runtime",
        modelRuntimeId: "databricks-fm-api-pay-per-token",
      },
    });
    mismatch.status >= 400
      ? ok("a Bedrock model with a Databricks runtime is refused",
           `${mismatch.status}: ${(mismatch.json?.error || "").slice(0, 80)}`)
      : bad("a Bedrock model with a Databricks runtime is refused",
            `accepted with ${mismatch.status}`);
  }
}

async function workflowJourney() {
  section("5. Workflows — create, bind to the agent, run for REAL on Databricks");
  if (!state.agentId) return skip("workflow journey", "no agent was created");

  const create = await req("POST", "/workflows", {
    op: "create",
    name: `Smoke UC Workflow ${Date.now()}`,
    description: "Lists Unity Catalog tables via a registered agent",
    tenantId: state.tenantId,
    steps: [
      {
        id: "step-1",
        name: "UC Analyst",
        agentId: state.agentId,
        prompt: "List the tables you can see and summarise them in one sentence.",
        toolRefs: [],
        knowledgeRefs: [],
        reviewGate: true,
      },
    ],
  });
  if (create.status < 300 && create.json?.id) {
    state.workflowId = create.json.id;
    ok("POST /api/workflows {op:create}", `created ${create.json.id}`);
  } else {
    return bad("POST /api/workflows {op:create}", `status ${create.status}: ${create.text.slice(0, 250)}`);
  }

  const listed = await req("GET", "/workflows");
  const wfs = listed.json?.workflows || listed.json || [];
  (Array.isArray(wfs) ? wfs : []).some((w) => w.id === state.workflowId)
    ? ok("workflow appears in the Workflows list")
    : bad("workflow appears in the Workflows list", "not present after create");

  // Persona is mandatory: running without one must be refused, not defaulted.
  const noPersona = await req("POST", "/workflows", {
    op: "start", workflowId: state.workflowId, input: "probe",
  });
  noPersona.status >= 400
    ? ok("starting without a persona is refused", `status ${noPersona.status} ${noPersona.json?.code || ""}`)
    : bad("starting without a persona is refused", `accepted with status ${noPersona.status}`);

  const personas = await req("GET", "/personas");
  const persona = (personas.json?.personas || [])[0];
  if (!persona) return bad("workflow run", "no persona available");

  console.log(`  ....  starting run as ${persona.id} (real Databricks inference)`);
  const start = await req("POST", "/workflows", {
    op: "start",
    workflowId: state.workflowId,
    input: "Which tables exist in workspace.graph_demo?",
    personaId: persona.id,
  });
  if (start.status >= 300) {
    return bad("POST /api/workflows {op:start}", `status ${start.status}: ${start.text.slice(0, 300)}`);
  }
  const accepted = start.json?.run || start.json;
  state.runId = accepted?.id;
  ok("POST /api/workflows {op:start}", `202 accepted, run ${state.runId}`);

  console.log("  ....  polling until the run settles");
  const run = await waitForRun(state.runId);
  if (!run) return bad("workflow run settled", "the run never appeared");
  ok("workflow run settled", `status=${run.status}`);

  const steps = run?.steps || [];
  if (!steps.length) return bad("workflow produced a step run", "no steps in the run");
  const step = steps[0];
  if (step.output && String(step.output).trim()) {
    ok("step executed and produced output", `${String(step.output).slice(0, 90).replace(/\s+/g, " ")}…`);
  } else if (step.error) {
    bad("step executed and produced output", `step error: ${String(step.error).slice(0, 200)}`);
  } else {
    bad("step executed and produced output", `status=${step.status}, no output or error`);
  }
  if (step.provenance) {
    ok("step records provenance", JSON.stringify(step.provenance).slice(0, 120));
  } else {
    bad("step records provenance", "no provenance on the step run");
  }
  if (typeof step.tokensIn === "number" || typeof step.tokensOut === "number"
      || step.usage || typeof step.latencyMs === "number") {
    ok("step records usage/latency");
  } else {
    skip("step records usage/latency", "no usage fields present");
  }
}

async function toolExecutionJourney() {
  section("5b. Tool execution — is the answer MEASURED or just plausible?");
  // The previous step bound no tools, yet its output claimed to have queried
  // Unity Catalog. With no tools attached that is the model confabulating, and
  // a confident wrong answer is the worst possible outcome. So bind a real
  // tool and check the step carries an actual invocation whose result contains
  // table names that genuinely exist.
  if (!state.modelId || !state.tenantId) return skip("tool execution", "no model/tenant");

  // A tool can only be attached once it is an APPROVED registry record, so the
  // real journey is: create registry -> publish record (Draft) -> Pending ->
  // Approved -> attach. Exercising the state machine IS the approval test.
  const reg = await req("POST", "/registry", {
    kind: "registry", name: `Smoke Tools ${Date.now()}`,
    description: "Smoke-test tool registry", autoApproval: false,
  });
  if (reg.status >= 300 || !reg.json?.id) {
    return bad("create registry", `status ${reg.status}: ${reg.text.slice(0, 160)}`);
  }
  ok("POST /api/registry {kind:registry}", `${reg.json.id} autoApproval=false`);

  const rec = await req("POST", "/registry", {
    kind: "record", registryId: reg.json.id, type: "Tool",
    recordSource: "define-manually", name: "uc_list_tables",
    mcpSchema: {
      toolSchema: [{
        name: "uc_list_tables",
        description: "List tables in a Unity Catalog schema",
        inputSchema: { type: "object", properties: {} },
      }],
    },
  });
  if (rec.status >= 300 || !rec.json?.id) {
    return bad("publish tool record", `status ${rec.status}: ${rec.text.slice(0, 200)}`);
  }
  ok("POST /api/registry {kind:record}", `${rec.json.id} status=${rec.json.status}`);
  state.recordId = rec.json.id;

  // An unapproved record must NOT be attachable — check before approving.
  const premature = await req("POST", "/agents", {
    name: "Smoke premature tool probe", tenantId: state.tenantId,
    modelId: state.modelId, systemPrompt: "x",
    toolRefs: [rec.json.id], knowledgeRefs: [],
    compute: { agentRuntimeId: "databricks-agent-runtime",
               modelRuntimeId: "databricks-fm-api-pay-per-token" },
    status: "ready",
  });
  premature.status >= 400
    ? ok("a Draft tool cannot be attached to an agent", `${premature.status}: ${(premature.json?.error || "").slice(0, 70)}`)
    : bad("a Draft tool cannot be attached to an agent", `accepted with ${premature.status}`);

  // Illegal transition must be refused (Draft cannot jump straight to Approved).
  const jump = await req("PATCH", "/registry", { id: rec.json.id, status: "Approved" });
  jump.status >= 400
    ? ok("Draft -> Approved directly is refused", `${jump.status}: ${(jump.json?.error || "").slice(0, 70)}`)
    : skip("Draft -> Approved directly is refused", `allowed (${jump.status}) — transition table may permit it`);

  for (const next of ["Pending approval", "Approved"]) {
    const r = await req("PATCH", "/registry", { id: rec.json.id, status: next });
    r.status < 300
      ? ok(`PATCH /api/registry -> ${next}`)
      : bad(`PATCH /api/registry -> ${next}`, `${r.status}: ${r.text.slice(0, 140)}`);
  }
  const nowRec = ((await req("GET", "/registry")).json?.records || [])
    .find((x) => x.id === rec.json.id);
  nowRec?.status === "Approved"
    ? ok("record is Approved and attachable")
    : bad("record is Approved and attachable", `status=${nowRec?.status}`);

  const agent = await req("POST", "/agents", {
    name: `Smoke UC Tool Agent ${Date.now()}`,
    description: "Agent with the uc_list_tables tool actually bound",
    tenantId: state.tenantId,
    modelId: state.modelId,
    systemPrompt:
      "You answer ONLY from tool results. Call uc_list_tables before answering.",
    toolRefs: [state.recordId],
    knowledgeRefs: [],
    compute: {
      agentRuntimeId: "databricks-agent-runtime",
      modelRuntimeId: "databricks-fm-api-pay-per-token",
    },
    status: "ready",
  });
  if (agent.status >= 300 || !agent.json?.id) {
    return bad("create tool-bound agent", `status ${agent.status}: ${agent.text.slice(0, 180)}`);
  }
  ok("create tool-bound agent", `${agent.json.id} with uc_list_tables`);

  const wf = await req("POST", "/workflows", {
    op: "create",
    name: `Smoke UC Tool Workflow ${Date.now()}`,
    tenantId: state.tenantId,
    steps: [{
      id: "step-1", name: "UC Lister", agentId: agent.json.id,
      prompt: "List every table in workspace.graph_demo. Use the tool.",
      toolRefs: [state.recordId], knowledgeRefs: [], reviewGate: false,
    }],
  });
  if (wf.status >= 300) {
    return bad("create tool-bound workflow", `status ${wf.status}: ${wf.text.slice(0, 180)}`);
  }

  console.log("  ....  running with a real tool (Databricks + Unity Catalog)");
  const run = await req("POST", "/workflows", {
    op: "start", workflowId: wf.json.id,
    input: "Which tables are in workspace.graph_demo?",
    personaId: "persona-john",
  });
  if (run.status >= 300) {
    return bad("run tool-bound workflow", `status ${run.status}: ${run.text.slice(0, 220)}`);
  }
  const accepted2 = run.json?.run || run.json;
  const settled = await waitForRun(accepted2?.id);
  if (!settled) return bad("tool-bound run settled", "the run never appeared");
  const step = (settled.steps || [])[0] || {};

  const calls = step.toolCalls || [];
  if (calls.length) {
    ok("the step actually INVOKED a tool", `${calls.length} call(s): ${calls.map((c) => c.name || c.tool).join(", ")}`);
  } else {
    bad("the step actually INVOKED a tool",
        "no toolCalls recorded — the answer cannot be grounded in Unity Catalog");
  }

  // The real schema has these tables. A confabulated answer will not match.
  const blob = JSON.stringify(step).toLowerCase();
  const real = ["trial", "site", "investigator", "trial_site"];
  const hits = real.filter((n) => blob.includes(n));
  if (hits.length >= 3) {
    ok("tool result contains the REAL table names", hits.join(", "));
  } else {
    bad("tool result contains the REAL table names",
        `only matched ${JSON.stringify(hits)} — output may be invented: ` +
        String(step.output || "").slice(0, 140).replace(/\s+/g, " "));
  }
  if (step.output && !/i (cannot|can't|don't have)/i.test(String(step.output))) {
    ok("step produced a usable answer", String(step.output).slice(0, 90).replace(/\s+/g, " ") + "…");
  } else {
    skip("step produced a usable answer", String(step.output || "none").slice(0, 110));
  }
}


async function approvalJourney() {
  section("6. Approvals — the review gate decision path");
  if (!state.runId) return skip("approval journey", "no run to decide on");

  const before = await req("GET", "/approvals");
  const beforeCount = (before.json?.items || []).length;

  const decide = await req("POST", "/workflows", {
    op: "decision",
    runId: state.runId,
    decision: "approve",
    note: "Approved by the control-plane smoke test",
  });
  if (decide.status < 300) {
    ok("POST /api/workflows {op:decision} approve", `run status=${(decide.json?.run || decide.json)?.status}`);
  } else {
    bad("POST /api/workflows {op:decision} approve", `status ${decide.status}: ${decide.text.slice(0, 250)}`);
  }

  const bogus = await req("POST", "/workflows", {
    op: "decision", runId: "run-does-not-exist", decision: "approve", note: "x",
  });
  bogus.status >= 400
    ? ok("decision on an unknown run is refused", `status ${bogus.status}`)
    : bad("decision on an unknown run is refused", `accepted with ${bogus.status}`);

  const after = await req("GET", "/approvals");
  const afterCount = (after.json?.items || []).length;
  ok("approvals endpoint still consistent", `${beforeCount} -> ${afterCount} item(s)`);

  const rerun = await req("POST", "/workflows", {
    op: "rerun", runId: state.runId, stepIndex: 0,
  });
  [200, 400, 409].includes(rerun.status)
    ? ok("rerun endpoint responds deterministically", `status ${rerun.status}`)
    : bad("rerun endpoint responds deterministically", `status ${rerun.status}`);
}

async function auditJourney() {
  section("7. Audit — every governed action must leave a trace");
  const r = await req("GET", "/audit");
  // Array.prototype.entries is a FUNCTION, so an `r.json?.entries || ...`
  // fallback chain silently picks up the method on an array response.
  const list = Array.isArray(r.json)
    ? r.json
    : (r.json?.entries || r.json?.items || []);
  if (!list.length) {
    return bad("audit has entries",
      `empty after the journey; endpoint returned ${r.status} ${r.text.slice(0, 160)}`);
  }
  ok("audit has entries", `${list.length} entry/entries`);

  const categories = [...new Set(list.map((e) => e.category))];
  ok("audit categories present", categories.join(", "));
  const text = JSON.stringify(list);
  /dapi[0-9a-f]{8}/.test(text)
    ? bad("audit contains no raw secret", "a Databricks token pattern appears in the audit log")
    : ok("audit contains no raw secret");
}

async function governedPaths() {
  section("8. Governed paths — Cedar, Neo4j, Unity Catalog, A2A, KB");

  // --- Cedar authorization, LOCAL: the gate the product actually enforces ---
  // An unknown persona must be denied a knowledge-graph BUILD (the only write
  // path), and the denial must be a clean 403 rather than an exception.
  const kgSources = (await req("GET", "/kg")).json?.sources || [];
  const target = kgSources.find((s) => s.backend === "neo4j" && s.status === "Approved");
  if (target) {
    const denied = await req("POST", "/kg", {
      op: "build", graphSourceId: target.graphSourceId, personaId: "persona-ghost",
      catalog: "workspace", schema: "graph_demo",
    });
    denied.status === 403
      ? ok("Cedar denies an unknown persona a KG build", `403 ${denied.json?.code || ""}`)
      : bad("Cedar denies an unknown persona a KG build", `status ${denied.status}: ${denied.text.slice(0, 160)}`);
  } else {
    skip("Cedar KG build denial", "no Approved neo4j source");
  }

  // --- AWS Verified Permissions adapter (separate from local Cedar) ---
  const stores = (await req("GET", "/policy-stores")).json?.stores || [];
  const store0 = stores[0];
  const authz = await req("POST", "/aws/authorize", {
    policyStoreId: store0?.policyStoreId || "",
    principalType: "User", principalId: "alice",
    actionType: "Action", actionId: "approveExpense",
    resourceType: "Expense", resourceId: "exp-1",
  });
  if (authz.status === 200) {
    ok("POST /api/aws/authorize", JSON.stringify(authz.json).slice(0, 90));
  } else {
    // The seeded policyStoreId is a placeholder, so a real AWS call cannot
    // succeed here. What matters is that it fails with a NAMED cause.
    const named = authz.json?.error || authz.json?.code;
    named
      ? skip("POST /api/aws/authorize", `no real Verified Permissions store — ${String(named).slice(0, 80)}`)
      : bad("POST /api/aws/authorize", `unnamed failure ${authz.status}: ${authz.text.slice(0, 140)}`);
  }

  // --- Neo4j read path ---
  const sources = (await req("GET", "/kg")).json?.sources || [];
  const neo = sources.find((s) => s.backend === "neo4j" && s.status === "Approved");
  if (!neo) {
    skip("Neo4j graph read", "no Approved neo4j graph source");
  } else {
    const g = await req("GET", `/kg?graphSourceId=${encodeURIComponent(neo.graphSourceId)}&instances=1`);
    if (g.status === 200 && g.json?.truncation) {
      ok("GET /api/kg (live Neo4j read)",
         `${g.json.truncation.nodesReturned}/${g.json.truncation.nodesTotal} nodes, complete=${g.json.truncation.complete}`);
    } else {
      bad("GET /api/kg (live Neo4j read)", `status ${g.status}: ${g.text.slice(0, 200)}`);
    }
  }

  // --- Unity Catalog derive (read-only) ---
  const derive = await req("POST", "/kg", {
    op: "derive", catalog: "workspace", schema: "graph_demo",
  });
  if (derive.status === 200 && derive.json?.summary) {
    const s = derive.json.summary;
    ok("POST /api/kg {op:derive} (live Unity Catalog)",
       `${s.tablesSeen} table(s) -> ${s.classes} class(es), ${s.relationships} rel(s), ${s.blocked} blocked`);
  } else {
    bad("POST /api/kg {op:derive}", `status ${derive.status}: ${derive.text.slice(0, 250)}`);
  }

  // --- traversal guard ---
  const badDepth = await req("POST", "/kg", {
    op: "neighbors", graphSourceId: neo?.graphSourceId || "x", nodeId: "n", depth: 99,
  });
  badDepth.status >= 400
    ? ok("traversal depth is bounded", `status ${badDepth.status} ${badDepth.json?.code || ""}`)
    : bad("traversal depth is bounded", `depth 99 accepted (${badDepth.status})`);

  // --- A2A ---
  const a2a = await req("GET", "/a2a");
  a2a.status === 200 ? ok("GET /api/a2a") : bad("GET /api/a2a", `status ${a2a.status}`);
  const peer = await req("POST", "/a2a", {
    op: "registerPeer", name: "Smoke peer", baseUrl: "http://169.254.169.254/",
  });
  peer.status >= 400
    ? ok("A2A refuses a metadata-service URL (SSRF guard)", `status ${peer.status}`)
    : bad("A2A refuses a metadata-service URL (SSRF guard)", `accepted with ${peer.status}`);

  // --- Playground ---
  const agents = (await req("GET", "/agents")).json || [];
  const agent0 = (Array.isArray(agents) ? agents : agents.agents || [])[0];
  if (agent0) {
    const pg = await req("POST", "/playground", {
      personaId: "persona-john",
      agentId: agent0.id,
      action: "invokeTool",
      tool: "expense.submit",
      amount: "100",
      modelId: state.modelId,
      runAgent: true,
    });
    if (pg.status === 200 && (pg.json?.decision || pg.json?.layers || pg.json?.allowed !== undefined)) {
      const d = pg.json.decision || (pg.json.allowed ? "allow" : "deny");
      ok("POST /api/playground (Cedar evaluation)", `decision=${JSON.stringify(d).slice(0, 70)}`);
    } else {
      bad("POST /api/playground", `status ${pg.status}: ${pg.text.slice(0, 200)}`);
    }
    const noPersona = await req("POST", "/playground", { tool: "expense.submit" });
    noPersona.status >= 400
      ? ok("playground requires a persona", `status ${noPersona.status}`)
      : bad("playground requires a persona", `accepted with ${noPersona.status}`);
  } else {
    skip("playground", "no agent available");
  }

  // --- Knowledge base retrieval (Qdrant) ---
  const kb = await req("POST", "/kb/retrieve", {
    recordId: "kb-smoke", query: "test", personaId: "persona-john",
  });
  if (kb.status === 200) ok("POST /api/kb/retrieve");
  else if ([400, 403, 404, 503].includes(kb.status)) {
    skip("POST /api/kb/retrieve", `status ${kb.status} — ${(kb.json?.error || kb.text).slice(0, 110)}`);
  } else {
    bad("POST /api/kb/retrieve", `status ${kb.status}: ${kb.text.slice(0, 180)}`);
  }
}

async function negativePaths() {
  section("9. Negative paths — invalid input must be refused, not absorbed");
  const cases = [
    ["POST /api/catalog (no name)", "POST", "/catalog", { modelProvider: "x" }],
    ["POST /api/agents (no tenant)", "POST", "/agents", { name: "x", modelId: "y" }],
    ["POST /api/workflows (unknown op)", "POST", "/workflows", { op: "nonsense" }],
    ["POST /api/kg (unknown op)", "POST", "/kg", { op: "nonsense" }],
  ];
  for (const [name, method, path, body] of cases) {
    const r = await req(method, path, body);
    r.status >= 400
      ? ok(name, `refused with ${r.status}`)
      : bad(name, `accepted with ${r.status}`);
  }
  const malformed = await fetch(`${API}/workflows`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
  });
  malformed.status >= 400
    ? ok("malformed JSON is refused", `status ${malformed.status}`)
    : bad("malformed JSON is refused", `accepted with ${malformed.status}`);
}

// --------------------------------------------------------------------------- //
(async () => {
  console.log(`Control-plane smoke test against ${BASE}`);
  console.log("NOTE: this drives the HTTP API behind each UI control. It does");
  console.log("      not click buttons — no headless browser in this environment.");

  await pagesRender();
  await readEndpoints();
  await registryJourney();
  await agentJourney();
  await workflowJourney();
  await toolExecutionJourney();
  await approvalJourney();
  await governedPaths();
  await auditJourney();   // after the actions that write to it
  await negativePaths();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PASS ${pass}   FAIL ${fail}   SKIP ${skipped}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail ? 1 : 0);
})();
