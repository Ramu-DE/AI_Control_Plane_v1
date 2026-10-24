// Offline tests for the agent-facing graph tools (graph_query, graph_schema).
//
// A model-issued Cypher is the riskiest graph path in the platform: the HTTP
// route answers a person, a tool answers a model acting for one. These pin the
// checks that path must make, in order, against the seeded tenant tree and
// policies — no Neo4j connection is opened (the query runner is injected).

import { test } from "node:test";
import assert from "node:assert/strict";

import { GraphQueryError, MAX_TOOL_ROWS, queryGraphAsAgent } from "../src/lib/graph/query.ts";
import type { GraphCaller } from "../src/lib/graph/query.ts";
import type { GraphSource } from "../src/lib/graph/entities.ts";
import { TOOL_IMPLEMENTATIONS, executeToolCall } from "../src/lib/tools/registry.ts";
import { toConverseTools } from "../src/lib/bedrock.ts";

function source(over: Partial<GraphSource> = {}): GraphSource {
  return {
    graphSourceId: "biomedical",
    bu: "fn-rnd",
    tenantId: "fn-rnd",
    displayName: "BioMedical",
    description: "",
    ontology: { type: "none" },
    backend: {
      type: "neo4j",
      uri: "neo4j+s://abc123.databases.neo4j.io",
      database: "abc123",
      username: "abc123",
      authSecret: { envVar: "NEO4J_PASSWORD" },
    },
    llmEndpoint: "",
    queryEngineUrl: "",
    allowedHosts: ["databases.neo4j.io"],
    status: "Approved",
    owner: "test",
    createdAt: "",
    updatedAt: "",
    ...over,
  } as GraphSource;
}

const caller: GraphCaller = {
  personaId: "persona-john",
  tenantId: "fn-rnd",
  agentId: "agent-test",
  origin: "workflow",
};

function deps(src: GraphSource | null) {
  const calls: { cypher: string; params: Record<string, unknown>; limit?: number }[] = [];
  return {
    calls,
    deps: {
      getSource: async () => src,
      runQuery: async (_b: unknown, cypher: string, params: Record<string, unknown> = {}, opts: { limit?: number } = {}) => {
        calls.push({ cypher, params, limit: opts.limit });
        return { columns: ["n"], rows: [{ n: 1 }], rowCount: 1 };
      },
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GraphQueryError, `expected GraphQueryError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a refusal");
}

const READ = "MATCH (t:ClinicalTrial) RETURN t.nct_id LIMIT $limit";

test("runs an allowed read-only query and reports the plan", async () => {
  const d = deps(source());
  const r = await queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, caller, d.deps);
  assert.equal(r.rowCount, 1);
  assert.equal(r.planSource, "explicit");
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].cypher, READ);
});

test("refuses without a caller — a tool call needs a principal", async () => {
  const d = deps(source());
  assert.equal(await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, undefined, d.deps)), "NO_CALLER");
  assert.equal(
    await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, { ...caller, agentId: "" }, d.deps)),
    "NO_CALLER"
  );
  assert.equal(d.calls.length, 0);
});

test("refuses an unknown or unapproved source", async () => {
  assert.equal(await refusal(queryGraphAsAgent({ graphSourceId: "nope", cypher: READ }, caller, deps(null).deps)), "NOT_FOUND");
  for (const status of ["Draft", "Pending approval", "Rejected", "Deprecated"] as const) {
    const d = deps(source({ status }));
    assert.equal(await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, caller, d.deps)), "NOT_APPROVED");
    assert.equal(d.calls.length, 0);
  }
});

test("a sibling tenant's graph is refused; own and ancestor graphs are allowed", async () => {
  // fn-supply is a sibling of fn-rnd under takeda.
  const sibling = deps(source({ tenantId: "fn-supply", bu: "fn-supply" }));
  assert.equal(
    await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, caller, sibling.deps)),
    "TENANT_DENIED"
  );
  assert.equal(sibling.calls.length, 0, "no query may run for a refused tenant");

  // A graph owned by the org root is inherited by every BU/BF.
  const ancestor = deps(source({ tenantId: "takeda", bu: "takeda" }));
  await queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, caller, ancestor.deps);
  assert.equal(ancestor.calls.length, 1);

  // A sub-unit's graph does NOT flow up to its parent.
  const child = deps(source({ tenantId: "fn-rnd-research", bu: "fn-rnd-research" }));
  assert.equal(
    await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, caller, child.deps)),
    "TENANT_DENIED"
  );
});

test("Cedar is evaluated for the caller: an unknown persona is denied", async () => {
  const d = deps(source());
  assert.equal(
    await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, { ...caller, personaId: "persona-ghost" }, d.deps)),
    "POLICY_DENIED"
  );
  assert.equal(d.calls.length, 0);
});

test("write and admin Cypher never reaches the database", async () => {
  for (const cypher of [
    "MATCH (n) DETACH DELETE n",
    "CREATE (n:Probe) RETURN n",
    "MATCH (n) SET n.x = 1 RETURN n",
    "MERGE (n:Probe {id: 1}) RETURN n",
    "DROP INDEX foo",
  ]) {
    const d = deps(source());
    assert.equal(await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher }, caller, d.deps)), "UNSAFE_CYPHER", cypher);
    assert.equal(d.calls.length, 0, `must not execute: ${cypher}`);
  }
});

test("non-Neo4j and non-allowlisted backends are refused", async () => {
  const dbx = deps(source({ backend: { type: "databricks-uc", catalog: "c", schema: "s", registryTable: "", universalJoinKey: "" } as GraphSource["backend"] }));
  assert.equal(await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, caller, dbx.deps)), "UNSUPPORTED_BACKEND");
  const offList = deps(source({ allowedHosts: ["example.com"] }));
  assert.equal(await refusal(queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ }, caller, offList.deps)), "NOT_CONFIGURED");
});

test("the row cap is clamped and truncation is reported", async () => {
  const d = deps(source());
  const r = await queryGraphAsAgent({ graphSourceId: "biomedical", cypher: READ, limit: 10_000 }, caller, d.deps);
  assert.equal(d.calls[0].limit, MAX_TOOL_ROWS);
  assert.equal(d.calls[0].params.limit, MAX_TOOL_ROWS);
  assert.equal(r.truncated, false);
});

test("graph tools are implemented and refuse to run without an agent context", async () => {
  for (const name of ["graph_query", "graph_schema"]) {
    assert.ok(TOOL_IMPLEMENTATIONS[name], `${name} is implemented`);
    const { record, payload } = await executeToolCall(name, { graph_source_id: "biomedical", cypher: READ });
    assert.equal(record.ok, false);
    assert.match(JSON.stringify(payload), /persona, tenant and agent/);
  }
});

test("a tool the step was not offered is refused even if it is implemented", async () => {
  const offered = [TOOL_IMPLEMENTATIONS.graph_schema];
  const { record, payload } = await executeToolCall("uc_query", { sql: "SELECT 1" }, undefined, offered);
  assert.equal(record.ok, false);
  assert.match(JSON.stringify(payload), /was not offered/);
});

test("Converse tool specs carry name, description and JSON schema", () => {
  const [spec] = toConverseTools([TOOL_IMPLEMENTATIONS.graph_query]);
  assert.equal(spec.toolSpec?.name, "graph_query");
  assert.ok(spec.toolSpec?.description);
  const schema = spec.toolSpec?.inputSchema && "json" in spec.toolSpec.inputSchema ? spec.toolSpec.inputSchema.json : undefined;
  assert.deepEqual((schema as { required?: string[] })?.required, ["graph_source_id", "cypher"]);
});
