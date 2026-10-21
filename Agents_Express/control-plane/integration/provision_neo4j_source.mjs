// Idempotent provisioning of the Neo4j Graph Source in the control plane.
//
// WHY THIS EXISTS: with GRAPH_CONTROL_STORE=local the control plane keeps graph
// sources in an in-memory singleton, so a process restart drops the registered
// source. This script re-creates and re-approves it from the environment in one
// command, making the workflow reproducible rather than a manual click-through.
// With GRAPH_CONTROL_STORE=dynamodb the source persists and this script becomes
// a no-op after the first run (it converges either way).
//
// It talks to the control plane over HTTP only — the same API the UI uses — so
// it exercises the real validation, SSRF allowlist and approval state machine.
//
// NO SECRET IS SENT. Only the NAME of the env var holding the password is
// stored on the record (`authSecret.envVar`); the control-plane process resolves
// the value itself at query time.
//
// Usage:
//   set -a; . /path/to/Neo4j-<id>-Created-<date>.txt; set +a
//   node integration/provision_neo4j_source.mjs
//
// Env:
//   NEO4J_URI, NEO4J_USERNAME, NEO4J_DATABASE   (from the Aura credentials file)
//   NEO4J_SECRET_ENV_VAR  name of the var the SERVER reads  [NEO4J_AURA_PASSWORD]
//   CONTROL_PLANE_URL     base URL incl. basePath  [http://localhost:3000/proxy/3000]
//   GRAPH_SOURCE_ID       [aura-supplier-graph]
//   GRAPH_SOURCE_BU       [fn-supply]

import assert from "node:assert";

const BASE = (process.env.CONTROL_PLANE_URL || "http://localhost:3000/proxy/3000").replace(/\/+$/, "");
const ID = process.env.GRAPH_SOURCE_ID || "aura-supplier-graph";
const BU = process.env.GRAPH_SOURCE_BU || "fn-supply";
const SECRET_ENV_VAR = process.env.NEO4J_SECRET_ENV_VAR || "NEO4J_AURA_PASSWORD";

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USERNAME;
const DB = process.env.NEO4J_DATABASE || "neo4j";

/** Allowlist derived from the URI host: pin the registrable suffix, not a wildcard. */
function allowedHostFor(uri) {
  const host = new URL(uri).hostname;            // a5da18e6.databases.neo4j.io
  const parts = host.split(".");
  return parts.length > 3 ? parts.slice(1).join(".") : host; // databases.neo4j.io
}

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
  assert(URI && USER, "NEO4J_URI and NEO4J_USERNAME must be set");
  assert(
    process.env[SECRET_ENV_VAR] || process.env.NEO4J_PASSWORD,
    `the control plane will need ${SECRET_ENV_VAR} (or NEO4J_PASSWORD) in ITS environment`
  );

  const allowedHosts = [allowedHostFor(URI)];
  console.log(`control plane : ${BASE}`);
  console.log(`graph source  : ${ID} (bu=${BU})`);
  console.log(`bolt uri      : ${URI}  db=${DB}`);
  console.log(`allowlist     : ${allowedHosts.join(", ")}`);
  console.log(`secret ref    : env var '${SECRET_ENV_VAR}' (name only, no value sent)`);

  // 1. Does it already exist?
  const list = await api("/api/graph", { method: "GET" });
  assert(list.status === 200, `GET /api/graph failed: ${list.status} ${JSON.stringify(list.body)}`);
  let source = (list.body.sources ?? []).find((s) => s.graphSourceId === ID);

  // 2. Register if absent.
  if (!source) {
    const reg = await api("/api/graph", {
      method: "POST",
      body: JSON.stringify({
        op: "register",
        source: {
          graphSourceId: ID,
          bu: BU,
          tenantId: BU,
          displayName: "Supplier Graph (Neo4j Aura)",
          description: "Live Neo4j Aura instance: suppliers, contracts and therapeutic areas.",
          ontology: { type: "none" }, // a native graph IS its own ontology
          backend: {
            type: "neo4j",
            uri: URI,
            database: DB,
            username: USER,
            authSecret: { envVar: SECRET_ENV_VAR },
          },
          llmEndpoint: "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
          allowedHosts,
        },
      }),
    });
    assert(reg.status === 201, `register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
    source = reg.body;
    console.log(`\nregistered    : status=${source.status}`);
  } else {
    console.log(`\nalready present: status=${source.status}`);
  }

  // 3. Walk the approval state machine to Approved (idempotent).
  const path = { Draft: ["Pending approval", "Approved"], "Pending approval": ["Approved"] };
  for (const next of path[source.status] ?? []) {
    const r = await api("/api/graph", {
      method: "PATCH",
      body: JSON.stringify({ graphSourceId: ID, status: next }),
    });
    assert(r.status === 200, `transition -> ${next} failed: ${r.status} ${JSON.stringify(r.body)}`);
    source = r.body;
    console.log(`transitioned  : -> ${source.status}`);
  }
  assert(source.status === "Approved", `source is ${source.status}, expected Approved`);

  // 4. Prove the governed path works: policy preview, then a real Bolt read.
  const persona = (list.body.personas ?? [])[0];
  assert(persona, "no personas available to evaluate policy against");

  const preview = await api("/api/graph", {
    method: "POST",
    body: JSON.stringify({
      op: "query",
      graphSourceId: ID,
      personaId: persona.id,
      question: "what labels exist in this graph",
      preview: true,
    }),
  });
  assert(preview.status === 200, `preview failed: ${preview.status} ${JSON.stringify(preview.body)}`);
  assert(preview.body.targetConfigured === true, "bolt URI is not configured/allowlisted");
  console.log(`\npreview       : allowed=${preview.body.decision?.allowed} plan=${preview.body.planSource}`);

  const live = await api("/api/graph", {
    method: "POST",
    body: JSON.stringify({
      op: "query",
      graphSourceId: ID,
      personaId: persona.id,
      question: "what labels exist in this graph",
      preview: false,
    }),
  });
  assert(live.status === 200, `live query failed: ${live.status} ${JSON.stringify(live.body)}`);
  const result = live.body.result ?? {};
  console.log(`live query    : rows=${result.rowCount} server=${result.server?.agent ?? "?"}`);
  for (const row of (result.rows ?? []).slice(0, 10)) {
    console.log(`                ${JSON.stringify(row)}`);
  }

  // 5. The write guard must still refuse a mutation on this path.
  const write = await api("/api/graph", {
    method: "POST",
    body: JSON.stringify({
      op: "query",
      graphSourceId: ID,
      personaId: persona.id,
      question: "x",
      cypher: "MATCH (n) DETACH DELETE n",
      preview: false,
    }),
  });
  assert(write.status === 400 && write.body.code === "UNSAFE_CYPHER",
    `write guard did not reject: ${write.status} ${JSON.stringify(write.body)}`);
  console.log(`write guard   : rejected (${write.body.code})`);

  console.log("\nPROVISIONING OK");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nPROVISIONING FAILED:", e.message);
    process.exit(1);
  });
