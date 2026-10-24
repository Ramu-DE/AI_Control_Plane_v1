// Offline tests for Graph Source build specs and the ontology-first job.
//
// The Knowledge Graph page used to build whatever Unity Catalog location was
// typed into its form, into whichever database was selected — choosing the
// BioMedical source wrote a contracts graph into the BioMedical database.
// These pin that the source's spec decides what is built and where, that the
// job writes into the SOURCE's own database, and that its inputs cannot be
// steered outside graph-utility.

import { test } from "node:test";
import assert from "node:assert/strict";

import { describeKgSpec, validateKgSpec } from "../src/lib/kg/spec.ts";
import { KgJobError, buildCommand, parseBuildOutput } from "../src/lib/kg/jobs.ts";
import { displayName } from "../src/lib/kg/sourceRead.ts";
import type { GraphSource, KgSpec } from "../src/lib/graph/entities.ts";

const neo4jBackend = {
  type: "neo4j" as const, uri: "neo4j+s://src1.databases.neo4j.io", database: "src1db", username: "src1user",
  authSecret: { envVar: "TEST_SRC1_PASSWORD" },
};
const neptuneBackend: GraphSource["backend"] = {
  type: "neptune", endpoint: "https://kg.cluster-x.us-east-1.neptune.amazonaws.com:8182", namedGraphs: ["urn:kg:build:kgb-1"],
};

function source(backend: GraphSource["backend"], over: Partial<GraphSource> = {}): GraphSource {
  return {
    graphSourceId: "scm-kg", bu: "fn-supply", tenantId: "fn-supply", displayName: "SCM", description: "",
    ontology: { type: "none" }, backend, llmEndpoint: "", queryEngineUrl: "",
    status: "Approved", owner: "", createdAt: "", updatedAt: "", ...over,
  } as GraphSource;
}

const ONTO: KgSpec = {
  mode: "ontology-first", ontology: "takeda/supply-chain.ttl", namespace: "http://example.org/takeda/scm#",
  dataset: { kind: "uc", catalog: "workspace", schema: "scm_demo" }, approvalProfile: "standard",
};

test("specs are validated per mode and per backend", () => {
  assert.equal(validateKgSpec({ mode: "native", labels: ["ClinicalTrial", "Disease"] }, source(neo4jBackend)), null);
  assert.match(validateKgSpec({ mode: "native", labels: [] }, source(neo4jBackend))!, /labels/);
  assert.match(validateKgSpec({ mode: "native", labels: ["Bad-Label"] }, source(neo4jBackend))!, /identifiers/);
  assert.match(validateKgSpec({ mode: "native", labels: ["X"] }, source(neptuneBackend))!, /Neo4j/);
  assert.equal(validateKgSpec(ONTO, source(neo4jBackend)), null);
  assert.equal(validateKgSpec(ONTO, source(neptuneBackend)), null);
  assert.match(validateKgSpec({ ...ONTO, ontology: "../../etc/passwd" }, source(neo4jBackend))!, /under graph-utility\/ontologies/);
  assert.match(validateKgSpec({ ...ONTO, ontology: "/abs/x.ttl" }, source(neo4jBackend))!, /relative path/);
  assert.match(validateKgSpec({ ...ONTO, approvalProfile: "yolo" } as never, source(neo4jBackend))!, /approvalProfile/);
  assert.match(validateKgSpec({ ...ONTO, dataset: { kind: "uc", catalog: "w; DROP", schema: "s" } }, source(neo4jBackend))!, /identifiers/);
  assert.match(validateKgSpec({ ...ONTO, dataset: { kind: "csv", dir: "../secrets" } }, source(neo4jBackend))!, /plain path/);
  assert.match(validateKgSpec({ mode: "derived", catalog: "workspace", schema: "x" }, source(neptuneBackend))!, /Neo4j/);
  assert.match(describeKgSpec(undefined), /No build spec/);
  assert.match(describeKgSpec(ONTO), /takeda\/supply-chain\.ttl over workspace\.scm_demo/);
});

test("the build writes into the SOURCE's own Neo4j database, whatever the platform default is", () => {
  process.env.TEST_SRC1_PASSWORD = "pw-src1";
  process.env.NEO4J_URI = "neo4j+s://platform-default.databases.neo4j.io";
  const cmd = buildCommand(source(neo4jBackend), ONTO as Extract<KgSpec, { mode: "ontology-first" }>, "Lena");
  assert.equal(cmd.target, "neo4j");
  assert.equal(cmd.env.NEO4J_URI, neo4jBackend.uri);
  assert.equal(cmd.env.NEO4J_DATABASE, "src1db");
  assert.equal(cmd.env.NEO4J_USERNAME, "src1user");
  assert.equal(cmd.env.NEO4J_PASSWORD, "pw-src1");
  assert.ok(cmd.args.includes("--neo4j"));
  const at = (flag: string) => cmd.args[cmd.args.indexOf(flag) + 1];
  assert.equal(at("--graph-source-id"), "scm-kg");
  assert.equal(at("--tenant"), "fn-supply");
  assert.equal(at("--schema"), "scm_demo");
  assert.ok(!cmd.args.includes("--publisher"), "standard needs no publisher");
});

test("a gxp-strict build is published under the acting persona's name", () => {
  process.env.TEST_SRC1_PASSWORD = "pw";
  const cmd = buildCommand(source(neo4jBackend), { ...ONTO, approvalProfile: "gxp-strict" } as never, "Daniel Okafor");
  assert.equal(cmd.args[cmd.args.indexOf("--publisher") + 1], "Daniel Okafor");
});

test("Neptune builds need the loader settings and target the source's endpoint", () => {
  delete process.env.NEPTUNE_S3_BUCKET;
  assert.throws(() => buildCommand(source(neptuneBackend), ONTO as never, "Lena"),
    (e: unknown) => e instanceof KgJobError && e.code === "NOT_CONFIGURED");
  process.env.NEPTUNE_S3_BUCKET = "b";
  process.env.NEPTUNE_LOADER_ROLE_ARN = "arn:aws:iam::1:role/r";
  const cmd = buildCommand(source(neptuneBackend), ONTO as never, "Lena");
  assert.equal(cmd.target, "neptune");
  assert.equal(cmd.env.NEPTUNE_ENDPOINT, "kg.cluster-x.us-east-1.neptune.amazonaws.com");
  assert.ok(cmd.args.includes("--neptune"));
});

test("an ontology that does not exist is refused before anything runs", () => {
  process.env.TEST_SRC1_PASSWORD = "pw";
  assert.throws(() => buildCommand(source(neo4jBackend), { ...ONTO, ontology: "takeda/nope.ttl" } as never, "x"),
    (e: unknown) => e instanceof KgJobError && e.code === "BAD_ONTOLOGY");
});

test("build output is parsed into the run's result", () => {
  const facts = parseBuildOutput([
    "  auto      : 32 approved by policy (auto:standard)",
    "  graph      : <urn:kg:build:kgb-4c93e9dd>  (191 quad(s))",
    "  instances  : 44   literals: 88   edges: 51   labels: 0",
  ]);
  assert.deepEqual(facts, { buildGraph: "urn:kg:build:kgb-4c93e9dd", instances: 44, literals: 88, edges: 51, auto: "32" });
});

test("node display names come from properties, in order of preference", () => {
  assert.equal(displayName({ title: "A trial", nct_id: "NCT1" }, "x"), "A trial");
  assert.equal(displayName({ studyTitle: "Study T1", iri: "http://r/trial/T1" }, "x"), "Study T1");
  assert.equal(displayName({ supplier_id: "SUP-001" }, "x"), "SUP-001");
  assert.equal(displayName({ iri: "http://r/value/Product/SKU-1" }, "x"), "SKU-1");
  assert.equal(displayName({}, "fallback"), "fallback");
});
