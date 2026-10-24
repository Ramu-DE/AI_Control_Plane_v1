# Graph Utility — generic, multi-BU Ontology-Mediated Data Access (OMDA)

> **Module guide (every file explained, flow, connections):** [`docs/modules/graph-utility/`](../docs/modules/graph-utility/README.md)

A **reusable** utility that lets agents answer natural-language questions over a
Business Unit's data **with precision**, by using a knowledge graph (ontology)
as a *semantic map* and keeping the data in its system of record.

Contract IQ (Market Access) is the **first tenant**. Add another BU tomorrow by
adding one **GraphSource descriptor** + building its registry + pointing a
serving endpoint — **no engine code changes**.

> The query/build utility lives in `graph-utility/`; its Graph Source control-plane
> provider is implemented in `Agents_Express/control-plane/` (`/graph` and
> `/api/graph`). Placeholder descriptors work in routing-preview mode until live
> Databricks/Neptune endpoints are configured.

---

## The three planes

| Plane | What | Where it runs |
|---|---|---|
| **Control** | register/govern/route each BU's Graph Source | **AgentControl** (Next.js + Bedrock) — see `docs/PHASE2_agentcontrol_provider.md` |
| **Query** | generic engine: question → concepts → SQL/vector → answer | **Databricks Model Serving** (next to the data) — `serving.py` |
| **Build** | ontology → mapping registry (auto) | **Databricks Job** today, Temporal-ready — `registry_build.py`, `jobs/build_registry_job.py` |

**Rule:** compute follows data; governance is centralized. The engine runs where
each BU's data lives; AgentControl is the single panel/router.

---

## Layout

```
graph-utility/
├── README.md
├── ARCHITECTURE.md
├── requirements.txt
├── pyproject.toml
├── graph_sources/
│   └── contract-iq.json            ← per-BU descriptor (endpoints as placeholders)
├── src/graph_utility/
│   ├── descriptor.py               ← GraphSource descriptor + registry (the seam)
│   ├── backends.py                 ← BackendAdapter seam + Databricks UC adapter
│   ├── engine.py                   ← generic OMDA engine (concepts + SQL)
│   ├── serving.py                  ← MLflow pyfunc for Model Serving (routes by id)
│   ├── ontology.py                 ← Neptune SPARQL client (schema only)
│   └── registry_build.py           ← Temporal-ready build activities
├── jobs/
│   └── build_registry_job.py       ← Databricks Job entrypoint
├── tests/
│   ├── test_engine_offline.py      ← engine end-to-end with a mock backend
│   └── test_registry_build_offline.py ← build activities with a fake ontology
└── docs/
    └── PHASE2_agentcontrol_provider.md
```

---

## The seam: a GraphSource descriptor (per BU)

Everything BU-specific is config. See `graph_sources/contract-iq.json`:

```json
{
  "graph_source_id": "contract-iq",
  "bu": "market-access",
  "ontology": { "type": "neptune", "sparql_url": "…:8182/sparql",
                "graph_uri": "…market_access_…", "namespace": "…/ma#" },
  "backend":  { "type": "databricks-uc", "catalog": "usdev_corp",
                "schema": "corp_us_mart",
                "registry_table": "usdev_corp.corp_us_mart.omda_ontology_mapping",
                "universal_join_key": "contract_key",
                "vector_index": "…dbx_cc_sow_contract_chunk_index" },
  "llm_endpoint": "databricks-meta-llama-3-3-70b-instruct",
  "query_engine_url": "https://…/serving-endpoints/contract_iq_omda/invocations"
}
```

---

## Run the offline tests (no Databricks/Neptune needed)

```bash
cd graph-utility
python3 tests/test_engine_offline.py            # engine: concepts → SQL → (mock) exec
python3 tests/test_registry_build_offline.py    # build: ontology → mapping rows
```

Both make **no network calls** — they use a mock backend and a fake ontology so
the logic is verifiable anywhere.

---

## Query path (once endpoints are set)

1. Fill real values in `graph_sources/contract-iq.json` (Neptune `sparql_url`,
   `role_arn`; Databricks `query_engine_url`).
2. Deploy the engine to **Databricks Model Serving** via the MLflow pyfunc in
   `serving.py` (see its module docstring for the `log_model` snippet).
3. In AgentControl, register the Graph Source and route queries to it
   (`docs/PHASE2_agentcontrol_provider.md`).

A request to the serving endpoint:
```json
{"dataframe_records": [{"graph_source_id": "contract-iq",
                        "question": "therapeutic area for contracts with supplier IQVIA",
                        "limit": 50}]}
```

---

## Build path (auto-registry from the ontology)

```bash
# On Databricks (cluster with Neptune VPC + assume-role):
python jobs/build_registry_job.py --graph-source-id contract-iq \
    --graph-sources-dir /dbfs/FileStore/graph_utility/graph_sources
```
Reads the Neptune ontology → derives mapping rows → idempotent MERGE into the
registry table → smoke-tests → prints the descriptor to register in AgentControl.

Use `--no-merge` to run fetch+derive+emit only (no Spark needed) for a dry check.

---

## Why this is "with precision"

- Registry is **derived from the ontology** (not hand-typed) → faithful mappings.
- Every request carries **`graph_source_id`** → never mixes BUs.
- Concept extraction is **constrained to the registry** → no hallucinated columns.
- **Join keys** come from the descriptor → correct SQL JOINs.
- **Cedar** at AgentControl → only authorized agents/BUs reach a graph.

See `ARCHITECTURE.md` for the full picture and the phased plan.

---

## Precision-first vertical slice (v0.2) — approval-gated, no guessed mappings

The original path above DERIVES a registry from the ontology and treats the
guesses as truth (a universal join key, name-guessed columns, inlined filter
values). The **precision-first** modules replace that with an honest,
review-gated pipeline. **Both layers coexist**; the legacy `OMDAEngine` and its
public API are unchanged.

```
DataAdapter.discover()                → typed metadata + bounded MASKED profiles
        │                               (tables, columns, keys, joins — no PII)
        ▼
propose_mappings(discovery, ontology) → MappingProposal[]  (status=proposed)
        │   name-similarity may PROPOSE but NEVER approve
        │   ontology relationships → relationship/JOIN proposals (from real keys)
        ▼
approve(p) / reject(p)                → explicit, human-gated; approve requires
        │                               a non-blank approver AND note, and fails
        │                               closed on blocking validation issues
        ▼
publish_mappings(...)                 → PublishedMappingSet (runtime registry)
        │   ALL supplied proposals must be decided; rejected rows are excluded;
        │   at least one approved+valid row is required. DIRECT mappings
        │   carry the DISCOVERED logical_type; CLASS mappings carry the class
        │   URI + discovered primary-key subject columns.
        │   + to_r2rml(...) R2RML artifact whose subject templates come from the
        │     published class's discovered subject key + class URI (NO fabricated
        │     __pk__; a direct mapping without a published keyed class for its
        │     table fails closed / is omitted with an explicit error).
        ▼
SemanticPlanner(published).plan(...)  → SemanticQueryPlan (fail-closed on
        │                               unmapped / ambiguous / bad operator /
        │                               many-to-many fanout; NO universal key).
        │   SUM/AVG and ILIKE are validated against the DISCOVERED logical_type
        │   ONLY — never the column name. The plan carries mapping_version +
        │   set_fingerprint provenance.
        ▼
SqlCompiler().compile(plan)           → CompiledQuery(sql, parameters)
        │   quoted+validated identifiers; NAMED params (never inlined);
        │   clamped LIMIT
        ▼
DataAdapter.execute(sql, parameters)  → typed rows
```

Retrieval is a **separate, provider-neutral seam** (`Retriever`): a
`RetrievalRequest` returns normalized `Passage` objects via a **descriptor-driven
`FieldMapping`** (no hardcoded ContractIQ columns). `federate` / `dedupe` /
`rrf_fuse` combine multiple retrievers. The `DatabricksVectorRetriever` is
descriptor-driven and imports its SDK lazily — **never called in tests**.

### What is IMPLEMENTED (offline, verifiable) vs PRODUCTION integrations

| Capability | Offline (in this repo, tested) | Production integration (NOT in tests) |
|---|---|---|
| Ontology ingest (supplied file) | ✅ `RdfFileOntologyClient` (Turtle/RDF-XML/N-Triples/JSON-LD) | `NeptuneOntologyClient` (live SPARQL); `rdfox` still config-only |
| Discovery + profiling | `InMemoryDataAdapter` (fixtures) | ✅ `UnityCatalogDataAdapter` — reads DECLARED PK/FK from `information_schema` |
| Masked bounded profiles | ✅ `discovery.ColumnProfile` (cap + mask) | same contract over live samples (`profile=True`) |
| Mapping proposals | ✅ `propose_mappings` (name sim + type + keys + ontology `rdfs:domain`) | + LLM-assisted evidence (pluggable) |
| Approval / publish gate | ✅ mandatory reviewer/note; undecided blocks; rejected excludes | DynamoDB AgentControl store implemented; Databricks build callback remains |
| Threshold auto-approval | ✅ `auto_approve` — measured evidence only, `auto:` provenance | same policy, tunable per source |
| R2RML artifact | ✅ `to_r2rml` (dict form + provenance) | consumed by `materialize_to_nquads` |
| **Graph materialisation** | ✅ `materialize_to_nquads` — N-Quads, one named graph per build | S3 + Neptune bulk loader (`format: nquads`) |
| Semantic plan + compile | ✅ `SemanticPlanner` + `SqlCompiler` | execute on Databricks SQL — NOTE: `planner._quote_ident` emits double-quoted identifiers, which Databricks parses as string literals (see `materialize.SqlDialect`) |
| Query execution | ✅ `InMemoryDataAdapter.execute` (safe subset) | Spark / JDBC execution |
| Retrieval | ✅ `InMemoryRetriever` (lexical) | `DatabricksVectorRetriever` (lazy SDK) |
| Federation / dedupe / RRF | ✅ pure helpers | same helpers over live retrievers |

**No live AWS/Databricks/Neptune calls** are made by any test. Provider classes
import their SDKs lazily and are exercised only through fixtures.

### Run the precision-first offline tests

```bash
cd graph-utility
python3 tests/test_precision_offline.py   # discovery, proposals, approval gate,
                                           # planner fail-closed, injection,
                                           # joins (composite FK), retrieval
```

A structurally different **clinical-trials** fixture
(`tests/fixtures_clinical.py`) — composite primary key, many-to-many
trial↔investigator via a junction table, and **no universal join key** — proves
the precision path carries **no ContractIQ assumptions** (tests assert the
ContractIQ column/table names never appear in discovery, proposals, or compiled
SQL).
