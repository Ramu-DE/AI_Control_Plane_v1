// Integration check for the Neo4j backend EXECUTION PATH used by /api/graph.
//
// Exercises the SAME modules the route runs — src/lib/graph/cypher.ts
// (buildCypher) and src/lib/graph/neo4j.ts (runReadQuery / verifyNeo4j) —
// against the live Aura instance. Seeds a tiny demo graph via the app's own
// runReadQuery is read-only, so we seed with the raw driver, then prove the
// governed read path returns real rows, then clean up.
//
// Run: NEO4J_PASSWORD=... node --import ./tests/register.mjs integration/neo4j_app_path.mjs
import assert from "node:assert";
import neo4j from "neo4j-driver";
import { buildCypher } from "../src/lib/graph/cypher.ts";
import { runReadQuery, verifyNeo4j, validateBoltUri } from "../src/lib/graph/neo4j.ts";

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USERNAME;
const PASS = process.env.NEO4J_PASSWORD;
const DB = process.env.NEO4J_DATABASE || "neo4j";
const TAG = "omda_apppath_demo";

const backend = { type: "neo4j", uri: URI, database: DB, username: USER };

function section(name) {
  console.log(`\n=== ${name} ===`);
}

async function seed() {
  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASS));
  try {
    const s = driver.session({ database: DB });
    try {
      await s.run("MATCH (n {demo:$tag}) DETACH DELETE n", { tag: TAG });
      await s.run(
        `UNWIND $rows AS row
         MERGE (sup:Supplier {name: row.supplier, demo:$tag})
         MERGE (c:Contract {id: row.contract, demo:$tag}) SET c.fees = row.fees
         MERGE (sup)-[:HAS_CONTRACT]->(c)`,
        {
          tag: TAG,
          rows: [
            { supplier: "Acme Health", contract: "C-1001", fees: 125000 },
            { supplier: "Acme Health", contract: "C-1002", fees: 75000 },
            { supplier: "Globex Pharma", contract: "C-2001", fees: 240000 },
          ],
        }
      );
    } finally {
      await s.close();
    }
  } finally {
    await driver.close();
  }
}

async function cleanup() {
  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASS));
  try {
    const s = driver.session({ database: DB });
    try {
      await s.run("MATCH (n {demo:$tag}) DETACH DELETE n", { tag: TAG });
    } finally {
      await s.close();
    }
  } finally {
    await driver.close();
  }
}

async function main() {
  assert(URI && USER && PASS, "NEO4J_URI/USERNAME/PASSWORD must be set");

  section("SSRF: Bolt URI validation (app code)");
  const vgood = validateBoltUri(URI, ["databases.neo4j.io"]);
  console.log("allowlisted Aura URI ->", vgood);
  assert.equal(vgood.ok, true, "live Aura URI should pass with allowlist");
  const vbad = validateBoltUri("bolt://127.0.0.1:7687");
  console.log("loopback URI        ->", vbad);
  assert.equal(vbad.ok, false, "loopback must be rejected");

  section("verifyNeo4j (app code)");
  const info = await verifyNeo4j(backend);
  console.log("server:", info);
  assert(info.version, "server version should be reported");

  await seed();
  console.log("seeded demo graph");

  section("buildCypher — explicit read-only Cypher (governed)");
  const explicit = buildCypher(
    "total fees by supplier",
    50,
    `MATCH (sup:Supplier {demo:'${TAG}'})-[:HAS_CONTRACT]->(c:Contract {demo:'${TAG}'})
     RETURN sup.name AS supplier, count(c) AS contracts, sum(c.fees) AS total_fees
     ORDER BY total_fees DESC`
  );
  console.log("planSource:", explicit.source);
  const res1 = await runReadQuery(backend, explicit.cypher, explicit.params, { limit: 50 });
  console.log("columns:", res1.columns);
  for (const r of res1.rows) console.log("  ", r);
  assert.equal(res1.rowCount, 2, "two suppliers expected");
  const globex = res1.rows.find((r) => r.supplier === "Globex Pharma");
  assert.equal(Number(globex.total_fees), 240000, "Globex total fees");
  const acme = res1.rows.find((r) => r.supplier === "Acme Health");
  assert.equal(Number(acme.total_fees), 200000, "Acme total fees (125k+75k)");

  section("buildCypher — derived label sample (no explicit Cypher)");
  const derived = buildCypher("show me some Supplier nodes", 10);
  console.log("planSource:", derived.source, "| cypher:", derived.cypher);
  const res2 = await runReadQuery(backend, derived.cypher, derived.params, { limit: 10 });
  console.log("rowCount:", res2.rowCount);
  assert(res2.rowCount >= 2, "should sample seeded Supplier nodes");

  section("write rejection on the governed path");
  assert.throws(
    () => buildCypher("q", 10, "MATCH (n) DETACH DELETE n"),
    /read-only/i,
    "a DELETE must be rejected by buildCypher"
  );
  console.log("DELETE correctly rejected by buildCypher");

  await cleanup();
  console.log("\nAPP-PATH NEO4J EXECUTION SUCCEEDED");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("FAILED:", e);
    try {
      await cleanup();
    } catch {}
    process.exit(1);
  });
