// Offline tests for the governed Cypher builder.
//
// The write guard in cypher.ts is DEFENCE IN DEPTH — the authoritative control
// is Neo4j's READ access mode in runReadQuery (verified live: a write is
// refused with Neo.ClientError.Statement.AccessMode even inside a CALL
// subquery). These tests pin the guard's behaviour so it keeps rejecting real
// writes without rejecting legitimate read-only Cypher.
//
// No network: buildCypher / isReadOnlyCypher are pure.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCypher,
  isReadOnlyCypher,
  UnsafeCypherError,
} from "../src/lib/graph/cypher.ts";

// --------------------------------------------------------------------------- //
// Writes and admin surfaces must always be rejected
// --------------------------------------------------------------------------- //

test("guard: rejects every write clause, in any case, anywhere in the statement", () => {
  const writes = [
    "CREATE (n:X)",
    "MATCH (n) DETACH DELETE n",
    "MATCH (n) delete n",
    "MERGE (n:X {id:1})",
    "MATCH (n) SET n.x = 1",
    "MATCH (n) REMOVE n.x",
    "DROP INDEX idx",
    "FOREACH (x IN [1] | CREATE (:Y))",
    "LOAD CSV FROM 'http://x' AS row RETURN row",
    // nested inside a subquery — the scan covers the whole statement
    "CALL { CREATE (n:X) RETURN n } RETURN n",
    "MATCH (t) CALL { WITH t MATCH (c) SET c.x = 1 RETURN c } RETURN c",
  ];
  for (const cy of writes) {
    assert.equal(isReadOnlyCypher(cy), false, `should reject: ${cy}`);
    assert.throws(() => buildCypher("q", 10, cy), UnsafeCypherError, `should throw: ${cy}`);
  }
});

test("guard: rejects admin / privileged procedure surfaces", () => {
  for (const cy of [
    "CREATE USER bob SET PASSWORD 'x'",
    "DROP DATABASE neo4j",
    "CALL apoc.create.node(['X'],{})",
    "CALL apoc.periodic.iterate('MATCH (n) RETURN n','DELETE n',{})",
    "CALL dbms.security.listUsers()",
    "USING PERIODIC COMMIT 500 LOAD CSV FROM 'x' AS r RETURN r",
  ]) {
    assert.equal(isReadOnlyCypher(cy), false, `should reject: ${cy}`);
  }
});

// --------------------------------------------------------------------------- //
// Legitimate read-only Cypher must NOT be rejected (the regression this fixes)
// --------------------------------------------------------------------------- //

test("guard: accepts a read-only CALL {} subquery", () => {
  // Previously rejected by a blanket "CALL {" rule, even though it writes
  // nothing — and the derived label-inventory plan uses exactly this shape.
  const cy =
    "MATCH (t:TherapeuticArea) CALL { WITH t MATCH (c:Contract)-[:COVERS]->(t) " +
    "RETURN sum(c.feesAmount) AS fees } RETURN t.name AS area, fees ORDER BY fees DESC";
  assert.equal(isReadOnlyCypher(cy), true);
  const plan = buildCypher("per-area totals", 50, cy);
  assert.equal(plan.source, "explicit");
  assert.equal(plan.cypher, cy);
});

test("guard: accepts ordinary reads, including aggregation and read procedures", () => {
  for (const cy of [
    "MATCH (s:Supplier)-[:HAS_CONTRACT]->(c:Contract) RETURN s.name, sum(c.feesAmount)",
    "CALL db.labels() YIELD label RETURN label",
    "MATCH p = shortestPath((a:Supplier)-[*..4]-(b:Supplier)) RETURN p",
    "MATCH (n) WHERE n.createdAt > 0 RETURN n",      // property named *createdAt*
    "MATCH (n) RETURN n.assetSet AS s",              // identifier containing SET
    "MATCH (n:Merger) RETURN n",                     // label containing MERGE
  ]) {
    assert.equal(isReadOnlyCypher(cy), true, `should accept: ${cy}`);
  }
});

// --------------------------------------------------------------------------- //
// Derived plans
// --------------------------------------------------------------------------- //

test("derived: a label mentioned in the question produces a sample plan", () => {
  const plan = buildCypher("show me some Supplier nodes", 3);
  assert.equal(plan.source, "derived-label-sample");
  assert.match(plan.cypher, /MATCH \(n:`Supplier`\) RETURN n LIMIT \$limit/);
  assert.equal(plan.params.limit, 3);
});

test("derived: no label falls back to a read-only label inventory", () => {
  const plan = buildCypher("what is in this graph", 50);
  assert.equal(plan.source, "derived-label-inventory");
  assert.match(plan.cypher, /CALL db\.labels\(\)/);
  // The fallback itself must satisfy the guard it is now routed through.
  assert.equal(isReadOnlyCypher(plan.cypher), true);
});

test("derived: every derived plan passes the read-only guard", () => {
  for (const q of [
    "what labels exist",
    "show me some Supplier nodes",
    "describe the Contract entities",
    "",
  ]) {
    const plan = buildCypher(q, 25);
    assert.equal(isReadOnlyCypher(plan.cypher), true, `derived plan unsafe for: ${q}`);
  }
});

// --------------------------------------------------------------------------- //
// Limits and identifiers
// --------------------------------------------------------------------------- //

test("limit is clamped into [1, 1000]", () => {
  assert.equal(buildCypher("q", 0).params.limit, 50); // 0 is falsy -> default 50
  assert.equal(buildCypher("q", -5).params.limit, 1);
  assert.equal(buildCypher("q", 10_000).params.limit, 1000);
  assert.equal(buildCypher("q", 7).params.limit, 7);
});

test("limit is always bound as a parameter, never inlined", () => {
  const plan = buildCypher("show me some Supplier nodes", 42);
  assert.match(plan.cypher, /\$limit/);
  assert.equal(plan.cypher.includes("42"), false);
});
