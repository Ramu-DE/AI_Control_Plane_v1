# Graph Utility — Architecture & Phased Plan

## 1. Thesis

Build **one generic Graph Utility** (a *product*), where each BU dataset is a
*tenant* described by a **GraphSource descriptor**. The ontology (knowledge
graph) is the semantic map; the data stays in its system of record. The utility
turns NL questions into precise queries, per BU, under central governance.

Contract IQ is tenant #1. Tenant #2 = one more descriptor + one build run.

---

## 2. Target architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  AgentControl (Next.js + Bedrock)  — CONTROL PLANE + ROUTER            │
│  • Graph Source registry (per BU): ontology + dataset + registry +     │
│    serving endpoint                                                    │
│  • User picks a dataset → resolve descriptor → Cedar check → route     │
│  • Workflows / Playground / Audit                                      │
└───────────────┬───────────────────────────────────────────────────────┘
                │ HTTPS {graph_source_id, question}  (on-behalf-of)
                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Databricks Model Serving: generic OMDA engine  (QUERY PLANE)         │
│   load THAT source's registry → concepts → UC SQL (+ Vector Search)   │
│   → grounded answer.  Tenant-agnostic; specifics come from descriptor.│
└───────────────┬───────────────────────────────────────────────────────┘
                │ reads single source of truth
                ▼
      UC Delta: <per-BU> omda_ontology_mapping  ◄── built by ──┐
                                                               │
┌──────────────────────────────────────────────────────────────┴────────┐
│  Databricks Job: registry auto-build  (BUILD PLANE)                   │
│   read Neptune ontology (SPARQL, VPC) → derive mappings → MERGE       │
│   registry → smoke-test → emit descriptor for AgentControl            │
│   (idempotent activities; Temporal-ready)                             │
└───────────────────────────────────────────────────────────────────────┘
        ▲
        │ ontology (schema only)
   AWS Neptune (GraphDB), per-BU graph URI
```

**One line:** generic engine on Databricks Model Serving (one per data
locality); AgentControl registers/governs/routes every BU's Graph Source;
Neptune supplies the ontology; a Databricks Job auto-builds each BU's mapping
registry as Temporal-ready activities.

---

## 3. Query data flow

```
question + graph_source_id
   │
   ▼  ConceptExtractor (keyword match grounded in the registry; LLM fallback)
concepts ─► _detect_filters (regex: "with supplier IQVIA" → filter)
   │
   ▼  SqlGenerator (base table + LEFT JOINs on the descriptor's join key)
SQL ─► BackendAdapter.execute_sql (Databricks UC)   [+ vector_search optional]
   │
   ▼
{ sql, concepts, filters, columns, rows, row_count }
```

All thresholds/schema/join-keys come from the descriptor + registry — the engine
has **zero** Contract-IQ-specific constants.

---

## 4. The seam that makes it reusable

`GraphSource` (descriptor.py) + the mapping **registry** are the only
per-BU artifacts. Two pluggable axes:

- **Ontology adapter** — `neptune` today (`ontology.py`); `rdf-file`/other later.
- **Backend adapter** — `databricks-uc` today (`backends.py`); `qdrant` /
  `bedrock-kb` / `warehouse` later via a new `BackendAdapter` subclass registered
  in `make_adapter()`. The engine never changes.

---

## 5. Governance & precision

- Cedar `queryGraphSource` (perimeter) + Unity Catalog row/column security
  (source of truth) under propagated end-user identity.
- Precision comes from: ontology-derived registry, `graph_source_id` isolation,
  registry-constrained concept extraction, descriptor-driven join keys.

---

## 6. Phased plan & status

| Phase | Deliverable | Status |
|---|---|---|
| **1a** | GraphSource descriptor + registry/loader/validator | ✅ `descriptor.py` (+ offline-validated) |
| **1b** | Generic engine + backend-adapter seam (UC) | ✅ `engine.py`, `backends.py` (+ offline test PASS) |
| **1c** | MLflow pyfunc serving wrapper (routes by id) | ✅ `serving.py` (+ routing test PASS) |
| **2**  | AgentControl Graph Source provider: lifecycle, Cedar preview, live router, `/graph` UI | ✅ `Agents_Express/control-plane/src/app/{graph,api/graph}` |
| **3**  | Registry auto-build (Neptune → MERGE), Temporal-ready | ✅ `ontology.py`, `registry_build.py`, `jobs/…` (+ offline test PASS) |
| **4**  | Identity propagation + audit join; adopt Temporal when onboarding is multi-system | ⏳ planned |

### Phase 4 (next, when you provide endpoints)
1. Fill real endpoints in the descriptor; deploy the serving endpoint.
2. Run the build job against the live Neptune ontology; verify the registry.
3. Implement the AgentControl provider (additive; per the Phase-2 design).
4. Wire end-user identity propagation so UC security applies under the caller.
5. If onboarding spans multiple systems/accounts, lift build activities into a
   Temporal workflow (activity bodies already idempotent — mechanical change).

---

## 7. What I did NOT do (by design)

- Did not modify the running control-plane app (Phase 2 is design-only).
- Did not hardcode endpoints/secrets (descriptor placeholders; STS/role at
  runtime; keys never stored).
- Did not add other backends yet (seam is ready; UC only, per your stack).

---

## 8. Precision-first vertical slice (v0.2)

### 8.1 The problem it fixes — "false precision"

The v0.1 build plane produced a registry by GUESSING and then treated the
guesses as authoritative:

- `derive_mappings` snake-cased ontology local names into column names and
  emitted them as real mappings (no validation against the actual schema);
- a single `universal_join_key` (`contract_key`) was assumed for every join;
- `SqlGenerator` inlined filter values into the SQL string (`ILIKE '%…%'`);
- the Databricks vector path hardcoded ContractIQ columns.

Each of these is *confident but unverified* — "false precision". The v0.2 slice
removes it without deleting the legacy path (OMDAEngine stays for compatibility).

### 8.2 Modules

| Module | Responsibility |
|---|---|
| `discovery.py` | Typed, data-agnostic metadata (`TableMetadata`, `ColumnMetadata`, `KeyMetadata`, `JoinMetadata`) + bounded **masked** profiles (`ColumnProfile`, `TableProfile`). Composite keys supported. |
| `data_adapter.py` | `DataAdapter` seam (discover + execute a **compiled** query). `InMemoryDataAdapter` is an offline fixture backend with a safe parameterized SELECT engine. |
| `retriever.py` | Provider-neutral `Retriever` seam: `RetrievalRequest` → `Passage[]` via a descriptor-driven `FieldMapping`. `federate`/`dedupe`/`rrf_fuse`. `DatabricksVectorRetriever` (lazy SDK, never live in tests). |
| `mapping.py` | `MappingProposal` (id, ontology URI/label/type, target asset/column, evidence[], confidence, validation issues, status, version, fingerprints). `propose_mappings`, `approve`/`reject`, `publish_mappings`, `to_r2rml`. |
| `planner.py` | `SemanticQueryPlan` (`Projection`/`Filter`/`Aggregation`/`JoinPath`), `SemanticPlanner` (resolves only published mappings; fails closed), `SqlCompiler` → `CompiledQuery(sql, parameters)`. |

### 8.3 Precision invariants (enforced + tested)

1. **Name similarity may propose, never approve.** Name-only proposals are
   confidence-capped (`NAME_SIMILARITY_MAX_CONFIDENCE`) and carry a
   `name-similarity-only` review warning.
2. **No universal join key in the new path.** Joins come only from discovered
   keys or ontology relationships; the planner refuses to connect tables it
   can't join and never assumes a shared key.
3. **Approval + publish gate.** Every proposal in the publication scope must
   have a human decision with reviewer + note. Undecided rows block; rejected
   rows are excluded; approved rows with blocking issues block; at least one
   approved+valid mapping is required.
4. **Fail closed in planning.** Unmapped concept → `UnmappedConceptError`;
   multiple target columns for one concept → `AmbiguousConceptError`; aggregate
   on a non-numeric column → `PlanningError`; many-to-many fanout → `PlanningError`.
5. **Safe compilation.** Identifiers validated against `^[A-Za-z_]\w*$` and
   double-quoted; all values bound to **named parameters** (`:p0`…), never
   inlined; `LIMIT` clamped to `[1, MAX_LIMIT]`.
6. **Bounded, masked profiling.** A profile never carries more than
   `MAX_SAMPLE_VALUES` samples, and every sample is a non-reversible masked
   token — no raw PII/business value is ever stored or logged.
7. **Provenance.** Proposals and published mappings carry source + proposal
   fingerprints, approver, and decision time; the R2RML artifact propagates them.

### 8.4 Implemented offline vs production

Everything above is implemented and **verified entirely offline** with
`InMemoryDataAdapter` / `InMemoryRetriever` and two structurally different
fixtures (ContractIQ-style and a clinical-trials schema with a composite PK and
a many-to-many relationship). AgentControl persistence is implemented through
local and lazy DynamoDB stores. Remaining production integrations are a live
UC/warehouse `DataAdapter`, Databricks build callbacks, live
`DatabricksVectorRetriever`, and Turtle publication/loading. No live calls are
made by the test suite. See the README table.
