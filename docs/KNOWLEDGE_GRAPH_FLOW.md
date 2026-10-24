# Knowledge Graph flow: one source, its own graph

Page: **Knowledge Graph** (`/kg`). API: `/api/kg`.

## The problem it fixes

The page used to pick only a *target database*. The data came from free-text
Unity Catalog fields (`workspace.default`, prefix `agentexpress_`). Selecting
**BioMedical** therefore wrote a contracts / suppliers graph from UC demo tables
into the BioMedical Aura database (build `kgb-gto7dl5s`). Three defects
compounded it:

- **Load was not scoped to the source.** It showed every derived build in the
  database: Agentexpress\* classes plus Contract/Site/Supplier from older builds.
- **Derived builds collided across sources.** Nodes were MERGEd on `uri` alone.
- **Builds skipped tenant checks.** The build authorization sent no tenant, so
  membership and GxP never applied to the platform's only write path.

## The model: every Graph Source declares where its graph comes from

`kgSpec` on the Graph Source. It can only be set by an **admin of the source's
tenant** (`POST /api/kg {op:"set-spec"}`), and it is validated and audited.

| Mode | Meaning | Build | Explore |
|---|---|---|---|
| `native` | The graph database already holds the data, loaded by its own pipeline (e.g. the BioMedical repo's notebooks). | **Refused**: `NATIVE_SOURCE` | Nodes with the spec's labels only |
| `ontology-first` | graph-utility builds it from an **ontology** over a **dataset** (UC schema or CSV directory) under an **approval profile**. | Runs graph-utility as a tracked job into **this source's own database** | The **latest build** stamped `kg_source = <id>` |
| `derived` | Legacy demo: derive an ontology *from* UC metadata. | The old TS builder, UC location **from the spec** | This source's derived builds only |

Current specs:

| Source | Tenant | Spec |
|---|---|---|
| `biomedical` | fn-rnd | native: ClinicalTrial, Disease, AdverseEventReport, Reaction, Gene, Mention, Identifier |
| `aura-supplier-graph` | fn-supply | native: Supplier, Contract, Site, TherapeuticArea |
| `rnd-clinical-kg`, `rnd-clinical-kg-rdf` | fn-rnd | ontology-first: `takeda/rnd-clinical.ttl` over `workspace.graph_demo`, standard |
| `scm-kg`, `scm-kg-rdf` | fn-supply | ontology-first: `takeda/supply-chain.ttl` over `workspace.scm_demo`, standard |

## Governance on every step

| Step | Check |
|---|---|
| Set spec | admin of the source's tenant |
| Explore / expand | named persona; Cedar `queryGraphSource` in the source's tenant (viewer+, GxP, residency) |
| Build | named persona; Cedar `buildKnowledgeGraph` in the source's tenant (analyst+, GxP, residency); `gxp-strict` also needs an approver, who is recorded as publisher |
| Drop a derived build | named persona with `buildKnowledgeGraph`; scoped to this source |

## How an ontology-first build runs

`lib/kg/jobs.ts` spawns
`graph-utility/.venv/bin/python -I integration/build_graph_live.py …`:

- **Arguments:** a list, never a shell string.
- **Ontology:** must resolve under `graph-utility/ontologies/`.
- **Credentials:** the target's own. A Neo4j source passes its own
  URI / user / database / password. A Neptune source passes its own endpoint,
  plus `NEPTUNE_S3_BUCKET` / `NEPTUNE_LOADER_ROLE_ARN` from the server
  environment (`start.sh` sources `~/neptune-setup/neptune.env`).
- **Limits:** one running build per source, and a 15-minute timeout.
- **Tracking:** a BuildRun (`pending → running → succeeded | failed`) with the
  last 80 log lines (`GET /api/kg?graphSourceId=…&runs=1`). The page polls it
  and loads the new build when it finishes.
- **Neptune:** after success, the source's `namedGraphs` are re-pointed to the
  new build's data and `:inferred` graphs.

## Measured (live)

| Action | Result |
|---|---|
| Build on **BioMedical** | refused: *native graph … Explore it instead* |
| Explore BioMedical as Priya (R&D) | **139/139 nodes, 118/118 edges**: trials, diseases, reactions, genes, mentions, identifiers. No contracts. |
| Explore BioMedical as Lena (Supply) | refused: not a member of fn-rnd |
| Explore `rnd-clinical-kg` | 13/13 nodes from build `kgb-13fdddb4` |
| Explore `scm-kg` | 44/44 nodes |
| Build `scm-kg` from the page, as Lena | job succeeded: `kgb-4c93e9dd`, 44 entities, 51 edges, 32 mappings auto-approved, Neo4j load verified; Explore switched to it |
| Second build while running | `BUILD_RUNNING` |
| Priya builds `scm-kg` | `KG_DENIED` (not a member of fn-supply) |
| Build `scm-kg-rdf` (Neptune) from the page | `kgb-85f4dda1`, 183/183 quads verified; source re-pointed; SPARQL reads the new build |
| Spec with `../../etc/passwd` as ontology | `BAD_SPEC` |
| Priya sets a spec | refused (not an admin) |

Tests: 453/453 (7 spec/job tests). Smoke test: 100 pass / 0 fail / 2 skip.

## A production-build pitfall found on the way

Computing a node label in Cypher with a dynamic-key comprehension
(`toString(n[k])` inside a template literal) was **mangled by the Next.js
production minifier**: the bundle contained `toString(nhead(…`. It worked under
the test loader and failed only in the built app. Labels are now chosen in
TypeScript from `properties(n)`.

## Still in the database

Two derived builds predate the per-source stamp: `kgb-gto7dl5s` (contracts /
suppliers, written into the BioMedical database from the old page) and
`kgb-cptm9prs`. They are **hidden from every source's view** but still stored.
Remove them with `POST /api/kg {op:"drop", graphSourceId:"biomedical",
buildId:…, personaId:…}`. Unstamped legacy builds may be dropped through any
source.
