// Offline tests for governed SPARQL on Neptune Graph Sources.
//
// Neptune's default graph is the union of every named graph in the cluster, so
// an unscoped query against one Graph Source reads all of them. These pin the
// three things that keep a model-issued SPARQL query inside its source: read-
// only forms only, no self-chosen dataset (FROM / GRAPH) or federation
// (SERVICE), and an injected FROM per source graph. No Neptune call is made.

import { test } from "node:test";
import assert from "node:assert/strict";

import { UnsafeSparqlError, maskSparql, planSparql } from "../src/lib/graph/sparql.ts";
import { GraphQueryError, queryGraphAsAgent } from "../src/lib/graph/query.ts";
import type { GraphSource } from "../src/lib/graph/entities.ts";

const G = ["urn:kg:build:kgb-1", "urn:kg:build:kgb-1:inferred"];

function refused(query: string, pattern: RegExp) {
  assert.throws(() => planSparql(query, G, 25), (e: unknown) => {
    assert.ok(e instanceof UnsafeSparqlError, `expected UnsafeSparqlError for: ${query}`);
    assert.match((e as Error).message, pattern);
    return true;
  });
}

test("SELECT is scoped to exactly the source's graphs, before WHERE", () => {
  const { query, form } = planSparql(
    "PREFIX s: <http://x/s#>\nSELECT ?o WHERE { ?o a s:Order }", G, 25);
  assert.equal(form, "SELECT");
  assert.match(query, /SELECT \?o FROM <urn:kg:build:kgb-1> FROM <urn:kg:build:kgb-1:inferred> WHERE \{/);
  assert.match(query, /LIMIT 25$/);
});

test("scoping works without the optional WHERE keyword, and keeps an existing LIMIT", () => {
  const { query } = planSparql("SELECT * { ?s ?p ?o } LIMIT 3", G, 25);
  assert.match(query, /SELECT \* FROM <urn:kg:build:kgb-1> FROM <urn:kg:build:kgb-1:inferred> \{/);
  assert.doesNotMatch(query, /LIMIT 25/);
});

test("ASK is allowed and not given a LIMIT", () => {
  const { query, form } = planSparql("ASK { ?s a <http://x/T> }", G, 25);
  assert.equal(form, "ASK");
  assert.doesNotMatch(query, /LIMIT/);
});

test("every update form is refused", () => {
  for (const q of [
    "INSERT DATA { <http://x/a> <http://x/p> 1 }",
    "DELETE WHERE { ?s ?p ?o }",
    "DROP GRAPH <urn:kg:build:kgb-1>",
    "CLEAR ALL",
    "LOAD <http://x/data.nt>",
    "CREATE GRAPH <urn:x>",
    "WITH <urn:x> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }",
    "COPY DEFAULT TO <urn:x>",
  ]) refused(q, /read-only|not permitted/);
});

test("a query cannot choose its own dataset or federate", () => {
  refused("SELECT ?s FROM <urn:kg:build:other> WHERE { ?s ?p ?o }", /FROM is not permitted/);
  refused("SELECT ?s FROM NAMED <urn:kg:build:other> WHERE { GRAPH ?g { ?s ?p ?o } }", /not permitted/);
  refused("SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }", /GRAPH is not permitted/);
  refused("SELECT ?s WHERE { SERVICE <http://169.254.169.254/> { ?s ?p ?o } }", /SERVICE/);
});

test("CONSTRUCT and DESCRIBE are refused (only SELECT / ASK)", () => {
  refused("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }", /only SELECT or ASK/);
  refused("DESCRIBE <http://x/a>", /only SELECT or ASK/);
});

test("keywords inside strings, IRIs, comments and names are not mistaken for clauses", () => {
  const q =
    'PREFIX s: <http://x/insert/drop#>\n' +
    '# DROP everything (a comment)\n' +
    'SELECT ?fromLocation ?graph WHERE { ?l s:fromLocation ?fromLocation ; s:note "DELETE me" . ' +
    'BIND("GRAPH" AS ?graph) }';
  const { query } = planSparql(q, G, 10);
  assert.match(query, /FROM <urn:kg:build:kgb-1>/);
  const masked = maskSparql('SELECT ?x WHERE { ?x <http://a/b> "DROP" }');
  assert.doesNotMatch(masked, /DROP|http/);
  assert.equal(masked.length, 'SELECT ?x WHERE { ?x <http://a/b> "DROP" }'.length);
});

test("graph names that are not build graphs are refused, and an empty scope is refused", () => {
  assert.throws(() => planSparql("SELECT * { ?s ?p ?o }", ["http://evil/graph"], 5), /unexpected graph/);
  assert.throws(() => planSparql("SELECT * { ?s ?p ?o }", [], 5), /no named graphs/);
});

// --------------------------------------------------------------------------- //
// The agent tool's Neptune branch
// --------------------------------------------------------------------------- //
function neptuneSource(over: Partial<GraphSource> = {}): GraphSource {
  return {
    graphSourceId: "scm-kg-rdf", bu: "fn-supply", tenantId: "fn-supply",
    displayName: "SCM RDF", description: "", ontology: { type: "none" },
    backend: {
      type: "neptune",
      endpoint: "https://kg.cluster-abc.us-east-1.neptune.amazonaws.com:8182",
      namedGraphs: G,
    },
    llmEndpoint: "", queryEngineUrl: "", allowedHosts: ["neptune.amazonaws.com"],
    status: "Approved", owner: "t", createdAt: "", updatedAt: "",
    ...over,
  } as GraphSource;
}

const supplyCaller = { personaId: "persona-john", tenantId: "fn-supply", agentId: "a1", origin: "workflow" };

test("the Neptune branch scopes, authorizes and runs; Cypher is redirected", async () => {
  const seen: string[] = [];
  const deps = {
    getSource: async () => neptuneSource(),
    runSparql: async (_b: unknown, plan: { query: string }) => {
      seen.push(plan.query);
      return { columns: ["o"], rows: [{ o: "x" }], rowCount: 1 };
    },
  };
  const r = await queryGraphAsAgent(
    { graphSourceId: "scm-kg-rdf", sparql: "SELECT ?o WHERE { ?o ?p ?v }" }, supplyCaller, deps);
  assert.equal(r.language, "sparql");
  assert.match(seen[0], /FROM <urn:kg:build:kgb-1>/);

  await assert.rejects(
    queryGraphAsAgent({ graphSourceId: "scm-kg-rdf", cypher: "MATCH (n) RETURN n" }, supplyCaller, deps),
    (e: unknown) => e instanceof GraphQueryError && e.code === "UNSUPPORTED_BACKEND");
});

test("the Neptune branch refuses a sibling tenant and unsafe SPARQL before any call", async () => {
  let calls = 0;
  const deps = {
    getSource: async () => neptuneSource(),
    runSparql: async () => { calls++; return { columns: [], rows: [], rowCount: 0 }; },
  };
  await assert.rejects(
    queryGraphAsAgent({ graphSourceId: "scm-kg-rdf", sparql: "SELECT * { ?s ?p ?o }" },
      { ...supplyCaller, tenantId: "fn-rnd" }, deps),
    (e: unknown) => e instanceof GraphQueryError && e.code === "TENANT_DENIED");
  await assert.rejects(
    queryGraphAsAgent({ graphSourceId: "scm-kg-rdf", sparql: "DROP ALL" }, supplyCaller, deps),
    (e: unknown) => e instanceof GraphQueryError && e.code === "UNSAFE_QUERY");
  await assert.rejects(
    queryGraphAsAgent({ graphSourceId: "scm-kg-rdf", sparql: "SELECT * { ?s ?p ?o }" }, supplyCaller,
      { ...deps, getSource: async () => neptuneSource({ allowedHosts: ["example.com"] }) }),
    (e: unknown) => e instanceof GraphQueryError && e.code === "NOT_CONFIGURED");
  assert.equal(calls, 0, "no Neptune call for any refusal");
});
