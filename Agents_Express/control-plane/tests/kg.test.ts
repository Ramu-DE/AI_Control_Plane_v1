// Offline tests for knowledge-graph derivation, layout and the write gate.
//
// Derivation and layout are pure, so the interesting rules — never invent a
// join, block a class with no key, cap name-only confidence, keep the layout
// deterministic — are all verifiable without touching Neo4j or Databricks.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KEY_EVIDENCE_CONFIDENCE,
  NAME_ONLY_MAX_CONFIDENCE,
  candidateForeignKey,
  deriveOntology,
  deriveProposals,
  deriveSubjectColumns,
  parseColumns,
  toClassLabel,
  toPropertyLabel,
} from "../src/lib/kg/derive.ts";
import type { UcTableMeta } from "../src/lib/kg/derive.ts";
import { forceLayout, ringFor } from "../src/lib/kg/layout.ts";
import {
  KG_BUILD_ACTION,
  KG_PERIMETER_TOOL,
  authorizeBuild,
  kgScopedPolicyExists,
  kgScopedTool,
} from "../src/lib/kg/materialize.ts";
import { store } from "../src/lib/store.ts";

// The real shape `ucListTables` returns for the live demo schema.
const UC: UcTableMeta[] = [
  {
    fullName: "workspace.default.agentexpress_suppliers",
    tableType: "MANAGED",
    comment: "Sample suppliers",
    columns: [
      "supplier_id:STRING",
      "supplier_name:STRING",
      "country:STRING",
      "therapeutic_area:STRING",
      "contract_fees:DOUBLE",
    ],
  },
  {
    fullName: "workspace.default.agentexpress_contracts",
    tableType: "MANAGED",
    columns: [
      "contract_id:STRING",
      "supplier_id:STRING",
      "status:STRING",
      "start_date:DATE",
      "fees:DOUBLE",
    ],
  },
  {
    fullName: "workspace.default.agentexpress_sites",
    tableType: "MANAGED",
    columns: ["site_id:STRING", "site_name:STRING", "country:STRING", "active:BOOLEAN"],
  },
  {
    // No id-shaped column at all — must be blocked, not guessed.
    fullName: "workspace.default.agentexpress_therapeutic_areas",
    tableType: "MANAGED",
    columns: ["area:STRING", "division:STRING", "priority:INT"],
  },
];

// --------------------------------------------------------------------------- //
// Naming + parsing
// --------------------------------------------------------------------------- //

test("table names become singular PascalCase class labels", () => {
  assert.equal(toClassLabel("agentexpress_suppliers", "agentexpress_"), "Supplier");
  assert.equal(toClassLabel("agentexpress_therapeutic_areas", "agentexpress_"), "TherapeuticArea");
  assert.equal(toClassLabel("agentexpress_sites", "agentexpress_"), "Site");
  // ...and pluralisation of -ies is handled.
  assert.equal(toClassLabel("companies"), "Company");
});

test("column names become camelCase property labels", () => {
  assert.equal(toPropertyLabel("supplier_name"), "supplierName");
  assert.equal(toPropertyLabel("contract_fees"), "contractFees");
  assert.equal(toPropertyLabel("active"), "active");
});

test("columns parse into name + datatype", () => {
  assert.deepEqual(parseColumns(["a:STRING", "b:DOUBLE"]), [
    { name: "a", datatype: "STRING" },
    { name: "b", datatype: "DOUBLE" },
  ]);
  // Malformed entries are dropped rather than producing junk properties.
  assert.deepEqual(parseColumns(["nope", ":STRING"]), []);
});

// --------------------------------------------------------------------------- //
// Subject keys — no fabricated identity
// --------------------------------------------------------------------------- //

test("subject key is derived by shape, and absent when there is none", () => {
  assert.deepEqual(
    deriveSubjectColumns("workspace.default.agentexpress_suppliers", parseColumns(UC[0].columns)),
    ["supplier_id"]
  );
  assert.deepEqual(
    deriveSubjectColumns("workspace.default.agentexpress_therapeutic_areas", parseColumns(UC[3].columns)),
    [],
    "a table with no id-shaped column must yield NO key"
  );
});

// --------------------------------------------------------------------------- //
// Relationships — never invented
// --------------------------------------------------------------------------- //

test("a foreign key is only proposed when the target table really declares it", () => {
  const onto = deriveOntology(UC, { stripPrefix: "agentexpress_" });
  const rels = onto.relationships;
  // contracts.supplier_id -> suppliers.supplier_id is real.
  assert.equal(rels.length, 1);
  assert.equal(rels[0].fromTable, "workspace.default.agentexpress_contracts");
  assert.equal(rels[0].fromColumn, "supplier_id");
  assert.equal(rels[0].toTable, "workspace.default.agentexpress_suppliers");
  assert.equal(rels[0].label, "hasSupplier");
});

test("an id-shaped column with no matching table yields NO relationship", () => {
  const onto = deriveOntology(
    [
      {
        fullName: "c.s.orders",
        tableType: "MANAGED",
        columns: ["order_id:STRING", "ghost_id:STRING"],
      },
    ],
    {}
  );
  assert.equal(onto.relationships.length, 0, "must not invent a join to a non-existent table");
});

test("a class's own subject column is identity, not a reference", () => {
  const onto = deriveOntology(UC, { stripPrefix: "agentexpress_" });
  assert.equal(
    onto.relationships.some((r) => r.fromColumn === "site_id"),
    false
  );
});

test("candidateForeignKey requires an id-shaped name", () => {
  const onto = deriveOntology(UC, { stripPrefix: "agentexpress_" });
  assert.equal(
    candidateForeignKey({ name: "country", datatype: "STRING" }, "x", onto.classes),
    null
  );
});

// --------------------------------------------------------------------------- //
// Proposals — propose, never approve
// --------------------------------------------------------------------------- //

test("every proposal starts as a review candidate with capped confidence", () => {
  const onto = deriveOntology(UC, { stripPrefix: "agentexpress_" });
  const proposals = deriveProposals(onto);
  assert.ok(proposals.length > 10);
  for (const p of proposals) {
    assert.ok(p.confidence <= KEY_EVIDENCE_CONFIDENCE, `confidence too high for ${p.ontologyLabel}`);
    assert.ok(p.evidence.length > 0, `no evidence for ${p.ontologyLabel}`);
  }
  // Name-only class/property proposals carry the review warning.
  const nameOnly = proposals.filter((p) => p.proposalKind !== "relationship");
  assert.ok(nameOnly.length > 0);
  for (const p of nameOnly) {
    assert.ok(
      p.issues.some((i) => i.code === "name-similarity-only"),
      `${p.ontologyLabel} missing the name-similarity warning`
    );
    assert.ok(p.confidence <= NAME_ONLY_MAX_CONFIDENCE);
  }
});

test("a class with no subject key is BLOCKED from materialisation", () => {
  const onto = deriveOntology(UC, { stripPrefix: "agentexpress_" });
  const proposals = deriveProposals(onto);
  const area = proposals.find(
    (p) => p.proposalKind === "class" && p.ontologyLabel === "TherapeuticArea"
  );
  assert.ok(area, "expected a TherapeuticArea class proposal");
  assert.ok(
    area!.issues.some((i) => i.severity === "blocking" && i.code === "no-subject-key"),
    "a keyless class must be blocking, so no fabricated IRIs are minted"
  );
  // ...while a keyed class is not blocked.
  const supplier = proposals.find(
    (p) => p.proposalKind === "class" && p.ontologyLabel === "Supplier"
  );
  assert.equal(
    supplier!.issues.some((i) => i.severity === "blocking"),
    false
  );
});

test("relationship proposals carry key evidence and a composite-aware join", () => {
  const onto = deriveOntology(UC, { stripPrefix: "agentexpress_" });
  const rel = deriveProposals(onto).find((p) => p.proposalKind === "relationship");
  assert.ok(rel);
  assert.equal(rel!.confidence, KEY_EVIDENCE_CONFIDENCE);
  assert.deepEqual(rel!.join?.leftColumns, ["supplier_id"]);
  assert.deepEqual(rel!.join?.rightColumns, ["supplier_id"]);
  assert.equal(rel!.join?.origin, "discovered");
  assert.ok(rel!.evidence.some((e) => e.kind === "key-metadata"));
});

test("tableFilter limits which tables become classes", () => {
  const onto = deriveOntology(
    [...UC, { fullName: "workspace.default.unrelated_thing", tableType: "MANAGED", columns: ["id:STRING"] }],
    { tableFilter: "agentexpress_" }
  );
  assert.equal(onto.classes.length, 4);
  assert.equal(onto.classes.some((c) => c.table.endsWith("unrelated_thing")), false);
});

// --------------------------------------------------------------------------- //
// Layout — deterministic, in-bounds
// --------------------------------------------------------------------------- //

test("layout is deterministic for the same input", () => {
  const nodes = UC.map((t, i) => ({ id: `n${i}`, ring: i % 3 }));
  const edges = [{ source: "n0", target: "n1" }, { source: "n1", target: "n2" }];
  const a = forceLayout(nodes, edges, { seed: 7, iterations: 60 });
  const b = forceLayout(nodes, edges, { seed: 7, iterations: 60 });
  assert.deepEqual(a, b, "same seed must give the same picture");
});

test("layout keeps every node inside the viewport", () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, ring: i % 3 }));
  const edges = nodes.slice(1).map((n, i) => ({ source: `n${i}`, target: n.id }));
  const out = forceLayout(nodes, edges, { width: 800, height: 600, iterations: 80 });
  assert.equal(out.length, 40);
  for (const p of out) {
    assert.ok(p.x >= 40 && p.x <= 760, `x out of bounds: ${p.x}`);
    assert.ok(p.y >= 40 && p.y <= 560, `y out of bounds: ${p.y}`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("layout handles the degenerate cases", () => {
  assert.deepEqual(forceLayout([], []), []);
  const one = forceLayout([{ id: "solo" }], [], { iterations: 5 });
  assert.equal(one.length, 1);
  // An edge referencing an unknown node must not crash the simulation.
  const two = forceLayout([{ id: "a" }], [{ source: "a", target: "ghost" }], { iterations: 5 });
  assert.equal(two.length, 1);
});

test("rings put the ontology inside and data outside", () => {
  assert.equal(ringFor("class"), 0);
  assert.equal(ringFor("property"), 1);
  assert.equal(ringFor("instance"), 2);
});

// --------------------------------------------------------------------------- //
// The write gate
// --------------------------------------------------------------------------- //

test("kg-build Cedar constants and the seeded perimeter policy line up", () => {
  assert.equal(KG_BUILD_ACTION, "buildKnowledgeGraph");
  assert.equal(KG_PERIMETER_TOOL, "kg");
  assert.equal(kgScopedTool("aura-supplier-graph"), "kg:aura-supplier-graph");
  const a = authorizeBuild("aura-supplier-graph", "persona-john");
  assert.equal(a.perimeter.allowed, true);
  assert.equal(a.perimeter.matchedPolicyId, "pol-gw-kg-build-perimeter");
  assert.equal(a.scoped.evaluated, false);
  assert.equal(a.allowed, true);
});

test("a source-scoped policy can restrict who may BUILD", () => {
  const gsid = "aura-supplier-graph";
  store.policies.unshift({
    id: "pol-test-kg-scoped",
    name: "Test: only directors may build this graph",
    layer: "gateway",
    description: "test-only",
    enabled: true,
    createdAt: new Date().toISOString(),
    cedar: `permit(
  principal,
  action == Action::"buildKnowledgeGraph",
  resource == Tool::"${kgScopedTool(gsid)}"
) when { principal.role == "director" };`,
  });
  try {
    assert.equal(kgScopedPolicyExists(store.policies, gsid), true);
    assert.equal(authorizeBuild(gsid, "persona-john").allowed, false, "manager must be denied");
    assert.equal(authorizeBuild(gsid, "persona-mary").allowed, true, "director must be allowed");
  } finally {
    store.policies = store.policies.filter((p) => p.id !== "pol-test-kg-scoped");
  }
});

test("an unknown persona can never build", () => {
  const a = authorizeBuild("aura-supplier-graph", "persona-ghost");
  assert.equal(a.allowed, false);
  assert.equal(a.scoped.evaluated, false);
});

// --------------------------------------------------------------------------- //
// Traversal + truncation precision
// --------------------------------------------------------------------------- //

test("traversal depth is validated, not interpolated from caller input", async () => {
  // Cypher cannot parameterise a path bound, so depth is interpolated. It must
  // therefore be proven to be a bounded integer — anything else is refused
  // BEFORE a query is built (so these never touch the network).
  const { readNeighborhood, MAX_DEPTH } = await import("../src/lib/kg/read.ts");
  assert.equal(MAX_DEPTH, 3);
  const backend = { type: "neo4j", uri: "neo4j+s://x.databases.neo4j.io", database: "d", username: "u" } as const;
  for (const bad of [0, -1, 4, 99, 1.5, Number.NaN]) {
    await assert.rejects(
      () => readNeighborhood(backend as never, { nodeId: "n", depth: bad }),
      (e: Error) => /depth must be an integer between 1 and 3/.test(e.message),
      `depth ${bad} must be refused`
    );
  }
  // An injection attempt arrives as a non-integer and is refused the same way.
  await assert.rejects(
    () => readNeighborhood(backend as never, { nodeId: "n", depth: "1] RETURN 1 //" as never }),
    (e: Error) => /depth must be an integer/.test(e.message)
  );
});

test("traversal requires a node id", async () => {
  const { readNeighborhood } = await import("../src/lib/kg/read.ts");
  const backend = { type: "neo4j", uri: "neo4j+s://x.databases.neo4j.io", database: "d", username: "u" } as const;
  await assert.rejects(
    () => readNeighborhood(backend as never, { nodeId: "   " }),
    (e: Error) => /nodeId is required/.test(e.message)
  );
});
