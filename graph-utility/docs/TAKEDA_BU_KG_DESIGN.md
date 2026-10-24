# Ontology-driven knowledge graphs for Takeda BUs and BFs

**Goal.** A BU or business function (BF) supplies an ontology and points at its
data. Graph Utility builds the knowledge graph from the ontology automatically,
with no hand-written mappings, under Takeda's governance (tenancy, GxP, audit).
The graph is then queryable by that tenant's agents.

This document says what the module does today, where it falls short of that
goal, and the approach adopted. Section 6 lists what is built now.

---

## 1. Where the module is today

graph-utility is already **ontology-first** (`docs/ONTOLOGY_FIRST.md`):

```
ontology.ttl ─► propose_mappings ─► profile (keys, joins) ─► auto_approve ─► publish
            ─► materialize ─► entail + validate ─► 4 soundness gates ─► N-Quads
```

Its discipline is the right one for regulated data, and it is kept:

- **Name similarity may propose, never approve.** Only *measured* evidence
  (declared or measured keys, 100% containment, type agreement) can auto-approve.
- **Fail closed.** Conflation, dangling edges, truncation and constraint
  violations refuse the build. Each waiver is recorded in the provenance graph.
- **One named graph per build.** Teardown is exact, and builds can be diffed.

Measured on the live clinical demo (`workspace.graph_demo`), the build is sound
and complete. But only **15 of 32** proposals auto-approved. **17 waited for a
human.**

## 2. Why it is not "automatic" yet

| Gap | Effect on a real Takeda dataset |
|---|---|
| **Lexical matching only.** Jaccard tokens; no stemming, no synonyms, no column comments. `Supplier` ≠ `suppliers`. | Real UC schemas use BU vocabulary (`subj_id`, `inv_nm`, `ae_pt`), so almost everything defers to a human. |
| **Ontology labels ignored.** `rdfs:label`, `skos:prefLabel` and `skos:altLabel` are never read. | Synonyms written by the ontology owner, the cheapest curated evidence there is, are thrown away. |
| **One global approval policy** (module constants). | A GxP clinical BU and a low-risk BF get the same thresholds. |
| **No tenant on the descriptor.** `bu` is a free string. | The build cannot be attributed to, or isolated by, the Takeda tenant tree. |
| **Neptune-only output.** No cluster exists, and the load path has never run. | Builds are files nobody can query. |
| **Two disconnected builders.** The control plane's `lib/kg` derives the ontology *from* the tables (backwards) and writes to Neo4j. | Two answers to one question, and the ontology-first one is not the one in use. |
| **Agents cannot query graphs.** The tools are UC-only, and Bedrock has no tool loop. | The graph never reaches an agent. |

## 3. Takeda shape: hub-and-spoke ontologies on the tenant tree

```
takeda-core.ttl          enterprise concepts shared by every BU/BF
 │                       Product, Substance, Study, Site, Organisation, Person,
 │                       Indication, AdverseEvent, Material, Batch, Supplier, Contract
 │                       aligned to public standards (IDMP for products, CDISC
 │                       for studies, MONDO/MeSH for disease, MedDRA for events)
 ├── rnd-clinical.ttl     owl:imports core  (fn-rnd, bu-oncology ...)   GxP · silo
 ├── plasma-donor.ttl     owl:imports core  (bu-plasma-biolife)         GxP · silo
 ├── supply.ttl           owl:imports core  (fn-supply)                 GxP · silo
 └── procurement.ttl      owl:imports core  (fn-procurement)            non-GxP · pool
```

- **The core is owned centrally; spokes are owned by the BU/BF.** This follows
  the tenant tree: a spoke inherits the core the way a sub-unit inherits a model
  allowlist (`lib/tenancy.ts`). Two BUs that share core classes produce graphs
  that join on the same IRIs, so cross-BU questions become possible without
  merging data.
- **Synonyms belong in the ontology.** A spoke annotates its classes and
  properties with `skos:altLabel` in its own vocabulary (`"subject"`,
  `"subj_id"`). This is curated, reviewable, versioned evidence. It is the
  single biggest lever on automation, and it keeps the decision with the BU
  that knows the data.
- **Data stays in its system of record.** Each spoke binds to its own Unity
  Catalog scope (`catalog.schema` allowlist). Siloed BUs build inside their own
  workspace (compute follows data). Only the governed graph leaves.

## 4. The approach

### 4.1 Evidence ladder (what may propose, what may approve)

| Evidence | Kind | Can it auto-approve? |
|---|---|---|
| Normalised name equality (case, `_`/camel, plural) | `name-exact` | Yes, with hard evidence (unchanged rule, wider net) |
| Ontology `rdfs:label` / `skos:prefLabel` / `skos:altLabel` equals the asset name | `label-exact` | Yes, with hard evidence: a curated, versioned synonym |
| UC column/table comment names the term | `comment-match` | **Proposes only** |
| Embedding or LLM suggestion | `semantic-suggestion` | **Proposes only, never approves** (phase 2) |
| Declared PK/FK, measured uniqueness, 100% containment, type agreement | hard evidence | Required for every auto-approval |

The invariant does not move: **no auto-approval without measured evidence.** The
change is that the *name* half of the test now uses the vocabulary the BU wrote
down, instead of exact token equality.

### 4.2 Per-tenant policy profiles

`GraphSource` gains `tenant_id` and `approval_profile`:

| Profile | For | Auto-approves | Publish |
|---|---|---|---|
| `gxp-strict` | R&D clinical, Plasma, Manufacturing, Supply | `name-exact` only, plus hard evidence | Human sign-off required for every publication (CSV) |
| `standard` (default) | Most BUs/BFs | `name-exact` or `label-exact`, plus hard evidence | Auto-approved plus human-approved |
| `exploratory` | Sandboxes, non-regulated BFs | Same as standard | Builds may be waived lenient |

Thresholds never drop below the name-similarity cap, so a name-only proposal
still cannot clear *any* profile by arithmetic.

### 4.3 Targets

Keep N-Quads for Neptune (or RDFox) when a cluster exists, and add **Neo4j** as a
first-class target, because that is what this platform can query today:

- `rdf:type` becomes a node label (the class local name).
- Datatype triples become node properties; object triples become relationships.
- Every node and relationship carries `kg_build`, `kg_source` (graph source id)
  and `tenant`, plus a per-build label, so a build is attributable and
  removable, and a query can be scoped to one source.
- `MERGE` on the subject IRI, parameterised, write-only through this path.
- Inferred triples are written with `inferred: true` and never mixed silently
  with asserted ones.

### 4.4 The loop

```
BU registers Graph Source (tenant, ontology, UC scope, profile)   control plane
   │
   ▼  build job (in the BU's workspace — compute follows data)    graph-utility
ontology ─► propose (labels/stemming) ─► measure ─► auto-approve by profile
   │                                                      │ deferred
   │                                                      ▼
   │                                        review queue in /graph (human)
   ▼
publish ─► materialize ─► reason ─► gates ─► Neo4j (and/or N-Quads)
   │
   ▼
Graph Source Approved ─► agents query it with `graph_query`
                         (Cedar as the AGENT + tenant subtree + read-only Cypher)
```

### 4.5 Agents use graphs through one governed tool

`graph_query(graph_source_id, cypher)`, offered only when an approved registry
record exposes it. Each call:

1. requires an Approved graph source **visible to the caller's tenant** (own
   subtree or ancestor; never a sibling);
2. passes Cedar `queryGraphSource` evaluated as the **agent and persona**
   (the HTTP route used a generic `graph-router` agent);
3. runs read-only Cypher only (the existing guard), with a row cap;
4. is audited with tenant, persona and agent.

Tool execution now carries this caller context. Bedrock models get a tool loop,
not just Databricks models.

## 5. What this deliberately does not do

- **No LLM approval.** A model may suggest a mapping (phase 2). It never
  decides one. Regulated data needs a reproducible, explainable decision trail.
- **No `owl:sameAs` identity merging** across BUs. Shared core IRIs give
  joinability without fusing entities.
- **No raw values sent to a model.** Profiles stay masked (existing invariant).

## 6. Delivery

| # | Item | Status |
|---|---|---|
| 1 | `graph_query` / `graph_schema` agent tools: caller context, Bedrock tool loop, tenant + Cedar + read-only; tools a step was not offered are refused | ✅ `control-plane/src/lib/graph/query.ts`, `lib/tools/registry.ts`, `lib/bedrock.ts`; `tests/graph-tool.test.ts` |
| 2 | Vocabulary-aware matching: plural folding, `skos:prefLabel/altLabel/hiddenLabel` as `label-exact` evidence | ✅ `mapping.term_match`, `ontology_file._synonyms` |
| 3 | Per-tenant approval profiles and `tenant_id` / `approval_profile` on the descriptor | ✅ `mapping.APPROVAL_PROFILES`, `descriptor.py` |
| 4 | Neo4j writer + `build_graph_live.py --neo4j --register` | ✅ `neo4j_load.py`; `tests/test_takeda_profiles_offline.py` |
| 5 | Embedding/LLM *proposer* (propose-only), column-comment evidence | phase 2 |
| 6 | Build job calls the control plane's `/api/graph/mappings` (review queue in `/graph`) | phase 2 |
| 7 | Retire `lib/kg/derive.ts` in favour of the ontology-first path | phase 2 |
| 8 | Takeda core ontology + first spokes, authored with BU data owners | needs BU input (illustrative spoke: `ontologies/takeda/rnd-clinical.ttl`) |

## 7. Measured (live, `workspace.graph_demo`, 2026-10-24)

The R&D spoke ontology uses enterprise terms (`ClinicalStudy`, `StudySite`,
`PrincipalInvestigator`, `SiteAssignment`) over tables named `trial`, `site`,
`investigator`, `trial_site`. Only `skos:altLabel` connects them.

| Profile | Auto-approved | Wrong | Graph |
|---|---|---|---|
| `gxp-strict` (own names only, the previous behaviour) | 4 / 28 | 0 | **0 entities** (everything waits for a human) |
| `standard` | **15 / 28** (every mappable term) | **0** | 13 entities, 25 literals, 11 edges, 7 inferred; sound and complete |

The 13 deferred under `standard` are 12 partial-name traps (for example
`siteName` against a junction table's `site_id`) plus `hostsAssignment`, which
has no domain or range and is produced by reasoning as the inverse of `atSite`.
`Study` has no table and is populated only by `ClinicalStudy subClassOf Study`.

Loaded into Neo4j as Graph Source `rnd-clinical-kg` (tenant `fn-rnd`): 13/13
nodes and 15/15 relationships, verified by count. The BioMedical agent answered
"sites, PIs and enrolment per study" through `graph_query`. Its totals match a
direct SQL aggregate over Unity Catalog: T1 75/120, T2 200/300, T3 12/45 with
no PI. The NULL `investigator_id` produced no edge.

```bash
python integration/build_graph_live.py \
  --ontology ontologies/takeda/rnd-clinical.ttl --namespace 'http://example.org/takeda/rnd#' \
  --catalog workspace --schema graph_demo --profile-keys --profile-joins --reason \
  --tenant fn-rnd --approval-profile standard --graph-source-id rnd-clinical-kg \
  --neo4j --register http://localhost:3000/proxy/3000
```

## 8. Dataset-agnostic: what the engine assumes about data, and what it no longer does

"Dataset-agnostic" means the same engine, unchanged, builds a correct graph
from any dataset the ontology describes. That has four axes. The table lists
what used to tie the build to one particular shape of data.

| Axis | Was tied to | Now |
|---|---|---|
| **Vocabulary** | table/column names spelling the ontology's terms | `skos:*Label` synonyms, plural folding, acronym-safe tokens (`SKU` stays one token) |
| **Identity** | a declared PK, or a `*_id`-shaped column | declared key, **or** measured uniqueness, **or** `owl:hasKey` declared in the ontology and **confirmed by measurement**; a key the data contradicts is never used |
| **Shape** | one class = one keyed table | **value entities**: a class with no table is minted from a column's distinct values, scoped by class, so `sku` on orders and on inventory is ONE Product; edges come from the referencing row and cannot dangle; two candidate columns are disambiguated by the relationship's own name, or the proposal is blocked |
| **Source system** | Unity Catalog | Unity Catalog, or a **directory of CSV files** (`--csv-dir`; types inferred, no keys or joins declared, so identity is measured) |

Identity that is inferred rather than declared (value entities) is governed
by one switch, `automate_inferred_identity`: on for `standard`, off for
`gxp-strict`.

### Measured

| Dataset | Domain | Source | Declared metadata | Result (`standard`) |
|---|---|---|---|---|
| `graph_demo` | clinical | Unity Catalog | PK + FK | 15/28 auto, 0 wrong; 13 entities, 11 edges, 7 inferred |
| `graph_demo` → CSV | clinical | **CSV files** | **none** | 8/8 keys measured, 3 joins profiled; graph **triple-for-triple identical** to the UC build (49/49 asserted, 7/7 inferred) |
| `scm_demo` | **supply chain** | Unity Catalog | PK, one FK; products/customers/warehouses/locations have **no tables** | 32/50 auto, 0 wrong; 44 entities, 51 edges; Product unified across orders and inventory |

Under `gxp-strict` the same supply-chain build automates 12/50 and produces 8
entities and **0 edges**. Inferred identity waits for a human.

The supply-chain agent (`fn-supply`, Neptune SPARQL) answered "which products
are short against orders, and who ordered them" by joining orders to
inventory **through the value-entity Product**. Every figure matches a direct
SQL aggregate (SKU-PLA-12: 5,300 ordered vs 5,150 free, short 150).

### Targets: Neo4j and Neptune

`build_graph_live.py --neo4j --neptune --register` loads one gated build into
both and verifies each by count. Neo4j: nodes and relationships. Neptune: quads
per named graph via SPARQL. It then registers `<id>` (Neo4j) and `<id>-rdf`
(Neptune) as Draft Graph Sources.

**Neptune isolates sources; a shared Neo4j database does not.** Every SPARQL
query from an agent or the console is rewritten with `FROM <build>` and
`FROM <build:inferred>`, and queries that name their own dataset (`FROM`,
`GRAPH`) or federate (`SERVICE`, an SSRF route through the database) are
refused. Measured: two sources in one cluster each see only their own classes.
On Neo4j, separation is the `kg_source` stamp, which a query must filter on.

### Still not handled

- **Multi-valued attributes in child tables** (`trial_conditions(nct_id,
  condition)` where `condition` should be a Disease linked to the trial): the
  value column must be on the domain's own table today.
- **Value normalisation.** `Atlanta` and `atlanta ` are different entities;
  folding them is a data-quality decision left to the source.
- **Other sources.** JDBC/Postgres, Parquet on S3 and APIs need adapters. The
  `DataAdapter` seam is the same one the CSV adapter uses.
- **Semantic proposals** (embedding/LLM, propose-only) for ontologies with no
  synonyms are still phase 2.

**Known limit.** Graph Sources that share one Neo4j database are separated by
the `kg_source` stamp, which a query must filter on. Cypher from a model is not
rewritten to enforce that. For siloed (GxP) BUs, use a database or instance per
tenant. Tenant visibility and Cedar are enforced per source; isolation inside a
shared database is not.
