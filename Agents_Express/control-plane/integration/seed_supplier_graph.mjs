// Idempotent seed for the demo supplier graph used by the Neo4j Graph Source.
//
// Every node carries `source:"agentexpress-demo"` so the dataset is trivially
// identifiable and removable, and every write is a MERGE, so re-running this
// converges rather than duplicating.
//
// This is the ONLY script in the repo that writes to Neo4j. The application's
// query path is read-only by construction (READ access mode + a write-clause
// guard), so demo data has to be planted out-of-band — exactly as it would be
// in production, where the graph is populated by an upstream pipeline.
//
// Run:
//   set -a; . /path/to/Neo4j-<id>-Created-<date>.txt; set +a
//   node integration/seed_supplier_graph.mjs            # seed / converge
//   node integration/seed_supplier_graph.mjs --remove    # delete the demo data
//
// Credentials come from the environment only (NEO4J_URI / NEO4J_USERNAME /
// NEO4J_PASSWORD / NEO4J_DATABASE) and are never written to disk or logged.

import assert from "node:assert";
import neo4j from "neo4j-driver";

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USERNAME;
const PASS = process.env.NEO4J_PASSWORD;
const DB = process.env.NEO4J_DATABASE || "neo4j";
const TAG = "agentexpress-demo";
const remove = process.argv.includes("--remove");

const SUPPLIERS = [
  { supplierId: "SUP-001", name: "Acme Health", country: "US", parent: "Initech Holdings" },
  { supplierId: "SUP-002", name: "Globex Pharma", country: "US", parent: "Initech Holdings" },
  { supplierId: "SUP-003", name: "Umbra Labs", country: "DE", parent: null },
];

const CONTRACTS = [
  { contractId: "C-1001", supplierId: "SUP-001", feesAmount: 125000, status: "active", area: "Oncology" },
  { contractId: "C-1002", supplierId: "SUP-001", feesAmount: 75000, status: "active", area: "Cardiology" },
  { contractId: "C-2001", supplierId: "SUP-002", feesAmount: 240000, status: "active", area: "Oncology" },
  { contractId: "C-2002", supplierId: "SUP-002", feesAmount: 61000, status: "expired", area: "Neurology" },
  { contractId: "C-3001", supplierId: "SUP-003", feesAmount: 318000, status: "active", area: "Oncology" },
];

async function main() {
  assert(URI && USER && PASS, "NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD must be set");
  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASS), {
    disableLosslessIntegers: true,
  });
  try {
    await driver.verifyConnectivity();
    const session = driver.session({ database: DB });
    try {
      if (remove) {
        const res = await session.run(
          "MATCH (n {source:$tag}) DETACH DELETE n RETURN count(n) AS removed",
          { tag: TAG }
        );
        console.log(`removed ${res.records[0]?.get("removed") ?? 0} demo node(s)`);
        return;
      }

      // Suppliers + parent companies.
      await session.run(
        `UNWIND $rows AS row
         MERGE (s:Supplier {supplierId: row.supplierId})
           SET s.name = row.name, s.country = row.country, s.source = $tag
         FOREACH (_ IN CASE WHEN row.parent IS NULL THEN [] ELSE [1] END |
           MERGE (p:Supplier {supplierId: 'PARENT-' + row.parent})
             SET p.name = row.parent, p.source = $tag, p.isParent = true
           MERGE (s)-[:SUBSIDIARY_OF]->(p)
         )`,
        { rows: SUPPLIERS, tag: TAG }
      );

      // Contracts + therapeutic areas.
      await session.run(
        `UNWIND $rows AS row
         MATCH (s:Supplier {supplierId: row.supplierId})
         MERGE (c:Contract {contractId: row.contractId})
           SET c.feesAmount = row.feesAmount, c.status = row.status, c.source = $tag
         MERGE (s)-[:HAS_CONTRACT]->(c)
         MERGE (t:TherapeuticArea {name: row.area})
           SET t.source = $tag
         MERGE (c)-[:COVERS]->(t)`,
        { rows: CONTRACTS, tag: TAG }
      );

      const summary = await session.run(
        `MATCH (n {source:$tag})
         RETURN labels(n)[0] AS label, count(*) AS count ORDER BY label`,
        { tag: TAG }
      );
      console.log("seeded (idempotent):");
      for (const r of summary.records) {
        console.log(`  ${r.get("label")}: ${r.get("count")}`);
      }
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  });
