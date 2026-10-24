# graph-utility — module guide

A file-by-file map of `graph-utility/`. Each description comes from reading the code. The design rationale is in `README.md`, `ARCHITECTURE.md`, `docs/ONTOLOGY_FIRST.md` and `docs/TAKEDA_BU_KG_DESIGN.md`.

---

## 1. What the module is for

graph-utility builds knowledge graphs, and runs a governed query engine, for Takeda business units (BUs) and business functions (BFs). The build starts from the ontology and does not depend on the dataset:

- **Input:** an ontology (an RDF file, or a Neptune SPARQL endpoint) plus a dataset: Unity Catalog, a directory of CSV files, or in-memory fixtures. The ontology never names a table or column.
- **Build plane (current):** discover the dataset, *propose* mappings from the ontology to tables and columns, *measure* evidence (declared keys, uniqueness, value containment), *auto-approve* only what is backed by measured evidence under the tenant's approval profile, *publish*, then *materialize* N-Quads (one named graph per build). Optionally it also *entails* inferences, *validates* constraints, and *gates* the build (refusing conflation, dangling edges, truncation or violations). The result can be loaded into Neo4j and/or Neptune, verified, and registered with the AgentControl control plane.
- **Query plane:** two paths.
  - The legacy `OMDAEngine` turns a question into concepts and then SQL over a mapping registry. It is served from Databricks Model Serving.
  - The precision path (`SemanticPlanner` and `SqlCompiler`) compiles fail-closed, parameterised SQL from published mappings only. A separate agentic RAG loop (router, retriever, critic) sits beside it.
- **Invariant across the codebase:** name similarity may *propose*, never *approve* (`NAME_SIMILARITY_MAX_CONFIDENCE = 0.5` < `AUTO_APPROVE_MIN_CONFIDENCE = 0.55`). Machine decisions are stamped with the `auto:` prefix.

Core modules are stdlib-only. `rdflib`, `neo4j`, `boto3`, `requests`, `mlflow`, `pyspark` and `databricks-vectorsearch` are imported lazily.

---

## 2. The build flow, end to end

The entry point is `integration/build_graph_live.py::main()`. The steps below follow the code in order.

0. **Argument checks.**
   - Exactly one of `--schema` or `--csv-dir` must be given. With `--csv-dir`, the catalog becomes `csv` and the schema becomes the directory's basename.
   - `gu.approval_policy(--approval-profile)` resolves the policy. A profile with `require_human_publish` (`gxp-strict`) needs `--publisher`.
   - `--neo4j`, `--neptune` and `--register` need `--tenant`. `--register` also needs `--neo4j` or `--neptune`.
   - `build_id` defaults to `kgb-<8 hex>`. `graph_source_id` defaults to `<catalog>.<schema>`.
1. **Ontology read.**
   - A `GraphSource` is built with `OntologySource(type="rdf-file")`. `gu.make_ontology_client()` (in `ontology.py`) routes it to `RdfFileOntologyClient` (in `ontology_file.py`).
   - The client returns `list_classes()`, `list_properties()` and `list_relationships()`, in the same shape as `NeptuneOntologyClient`.
   - It reads only asserted triples, excludes meta-vocabulary (rdf/rdfs/owl/xsd/skos/shacl/dc/foaf/swrl), and accepts `rdfs:Class` as well as `owl:Class`.
   - Synonyms come from `skos:prefLabel/altLabel/hiddenLabel` (`_synonyms`). `owl:hasKey` lists are read in declared order (`_has_key`).
   - `list_axioms()` is called later, only with `--reason`.
2. **Discover.**
   - `UnityCatalogDataAdapter` (`uc_adapter.py`) reads `information_schema` (declared PK/UNIQUE/FK) over the Databricks SQL Statements API (`/api/2.0/sql/statements`), using `DATABRICKS_HOST/TOKEN/WAREHOUSE_ID`. It uses `DATABRICKS_DIALECT`.
   - Alternatively, `CsvDirectoryAdapter.from_directory()` (`csv_adapter.py`, a subclass of `InMemoryDataAdapter` from `data_adapter.py`) infers types and declares no keys. It uses `ANSI_DIALECT`.
   - `adapter.discover()` returns a `DiscoveryResult` (`discovery.py`). Unkeyed tables are printed.
3. **Propose.** `gu.propose_mappings(discovery, schema)` (in `mapping.py`) produces four kinds of proposal:
   - **CLASS to table:** `term_match` returns `name-exact` (the term's own name or `rdfs:label`), `label-exact` (a skos synonym), or a partial match. Confidence is capped at 0.5.
     - The subject key comes from the table's declared PK or UNIQUE key (`key-metadata`). Without one, the proposal gets a blocking `no-subject-key` issue.
     - If the class has `owl:hasKey`, and each key property resolves to exactly one column, the result is stored as `key_candidate`. It is unverified at this point (`ontology-haskey` evidence).
   - **VALUE_CLASS:** a class that did not match a table exactly is matched against string or integer columns, including names with `_id`/`_code` suffixes stripped. Instances are minted from the column's distinct values. These proposals carry `categorical-column` evidence and an `inferred-identity` warning.
   - **DIRECT (property to column):** name similarity plus `type-compatibility` with the ontology range. `rdfs:domain` restricts which table a property may map to.
   - **RELATIONSHIP:** an edge is built from the ontology's domain and range plus a declared FK (`key-metadata`).
     - A *value relationship* points at a value entity (`value-reference`).
     - With no FK, the proposal is blocked with `no-key-evidence`.
4. **Measure (opt-in).** These steps live in `overlap.py`.
   - `--profile-keys` runs `enrich_classes_with_uniqueness`.
     - **Pass 0:** verify the `owl:hasKey` candidate. If it fails, record `haskey-not-unique`.
     - **Pass 1:** single key-shaped columns.
     - **Pass 2:** composite pairs, in table column order.
     - **Pass 3:** non-key-shaped columns. These are only reported, never adopted.
     - A proof sets `subject_columns`, removes `no-subject-key`, and adds `uniqueness-verified`. If more than one candidate qualifies, the class gets `uniqueness-ambiguous`.
   - `--profile-joins` runs `enrich_relationships_with_overlap`. It measures containment into the parent's subject key.
     - Only full containment, into a unique parent, measured exhaustively, unblocks the relationship (join `origin="profiled"`, plus `key-metadata`).
     - If several columns qualify, the result is `overlap-ambiguous`. The probe budget is per proposal.
5. **Auto-approve.** `gu.auto_approve(proposals, policy=policy)` applies `auto_approval_verdict` to each proposal.
   - Every approval requires: no blocking issue, at least one `HARD_EVIDENCE_KINDS` evidence item, an exact name match (`label-exact` counts only if `accept_label_match`), and no `domain-mismatch`.
   - Value entities and value edges also require `automate_inferred_identity`.
   - Per kind:

     | Kind | Extra requirement |
     |---|---|
     | DIRECT | type-compatibility and confidence ≥ 0.55 |
     | CLASS | subject-key evidence |
     | RELATIONSHIP | `key-metadata` and confidence ≥ 0.55 |

   - `APPROVAL_PROFILES`:

     | Profile | Policy | Approver |
     |---|---|---|
     | `gxp-strict` | `accept_label_match=False`, `require_human_publish=True`, `automate_inferred_identity=False` | `auto:gxp-strict` |
     | `standard` | default policy | `auto:standard` |
     | `exploratory` | currently the same policy as `standard` | `auto:exploratory` |

   - `--approve-deferred-as NAME` lets a person approve whatever remains approvable.
6. **Publish.** `gu.publish_mappings(id, proposals, strict=False)` keeps only APPROVED proposals with no blocking issue, and computes a `set_fingerprint`. The script calls it with `strict=False`, so deferred proposals are left out rather than blocking publication.
7. **Governed build.** `gu.build_graph(...)` in `build.py`:
   - `materialize_graph` (in `materialize.py`) runs with its own gates off. It mints subject IRIs from keys only, emits typed literals, `rdfs:label`, edges, value entities (`mint_value_iri`) and value edges, and sorts output for determinism. It counts null-key rows, nulls, conflation, dangling edges and truncation.
   - With `--reason`, `entail` (in `reason.py`: a semi-naive RDFS-plus-safe-OWL subset that never applies `owl:sameAs`) produces inferred triples, and `validate_constraints` checks `disjointWith` and `FunctionalProperty`.
   - Gates: `conflation`, `dangling-edges`, `truncation` and `constraint-violations`. Under `strict` (the default) these raise `BuildRefused`. Each gate can be waived with `allow_*`.
   - Output is N-Quads in three graphs: `urn:kg:build:<id>` (data), `:inferred`, and `:prov` (from `provenance_quads`, including the axioms fingerprint and any waivers).
   - `--force` waives each gate explicitly (`allow_conflation`, `allow_dangling`, `allow_violations`, `allow_truncation`) with `strict=True`. `--max-rows-per-table` also sets `allow_truncation=True`.
8. **Artifact.**
   - `--out` runs `gu.write_nquads`, which writes the lines and prints the sha256.
   - The script prints `aws s3 cp` and loader `curl` hints, and the teardown command (`drop_graph_sparql`).
9. **Neptune.** `--neptune` runs `neptune_load.load_build_into_neptune`.
   - It uploads `builds/<id>/<id>.nq` to S3 with boto3, then POSTs to `/loader` (`format: nquads`, `failOnError: TRUE`) and polls.
   - On `LOAD_COMPLETED`, it counts quads per named graph with SPARQL and compares them with `graph_counts_from_nquads`. `verified` requires equal counts.
   - With `--register`, `_register_neptune` registers `<id>-rdf`, scoped to `[graph, graph:inferred]`.
10. **Neo4j.** `--neo4j` loads the build into Neo4j (`neo4j_load.py`).
    - `plan_property_graph(lines)` parses the N-Quads with rdflib:
      - `rdf:type` becomes a node label plus `:KGEntity`.
      - Literals become node properties.
      - Object triples become UPPER_SNAKE relationships.
      - Inferred triples are flagged.
      - The `:prov` graph is summarised on a `:KGBuild` node.
    - `write_property_graph` runs MERGE-only, parameterised Cypher, stamping `kg_build/kg_source/tenant` on everything.
    - `LoadReport.verified` compares node and relationship counts.
    - With `--register`, `_register` registers `<id>` with a `neo4j` backend.
11. **Register.**
    - `_post_register` POSTs `{"op":"register","source":{…}}` to `<CONTROL_PLANE_URL>/api/graph`. The source is registered as a DRAFT.
    - A 409 means the id already exists. It is treated as success: the build is loaded alongside earlier builds.
    - Approval stays with a person in `/graph`.
12. **Exit code.** Non-zero on a refusal, a failed load or verification, or a failed registration, and also when no triples were produced. `--json` prints the manifest, the auto-approval record, the entailment report and the violations.

Things the code does, worth knowing:

- `--force` is recorded. It passes every `allow_*` waiver explicitly, so each gate it overrides lands in `report.waived` and in the `:prov` graph (`vocab/waived`). It previously set `strict=False`, which hid forced builds from provenance; fixed 2026-10-24.
- `--publisher` is printed and stored on the Neo4j `:KGBuild` node. It is not passed to `publish_mappings` or written to the N-Quads provenance.

---

## 3. The query flow (legacy and precision query plane)

**Legacy OMDA path (how a question becomes SQL today):**

```
request {graph_source_id, question, limit, dry_run}
  └─ serving.OMDAServingModel.predict          (MLflow pyfunc on Databricks Model Serving)
       ├─ load_context: GraphSourceRegistry.from_dir(GRAPH_SOURCES_DIR | artifacts)   descriptor.py
       └─ _engine_for(id): make_adapter(source) -> DatabricksUCAdapter               backends.py
                           OMDAEngine(source, adapter, llm_fn)                        engine.py
            OMDAEngine.answer(question)
              ├─ ConceptExtractor.extract     whole-alias keyword match on the registry
              │                               (registry = adapter.load_registry(): Spark SELECT on
              │                               backend.registry_table); LLM fallback if < 2 hits
              ├─ _detect_filters              regex: "with supplier X" -> filter value
              ├─ _detect_aggregate_intent     average/count/total -> AVG/COUNT/SUM
              ├─ SqlGenerator.generate        base table + LEFT JOINs on backend.universal_join_key;
              │                               filters inlined as ILIKE '%…%' (quotes doubled)
              └─ adapter.execute_sql          spark.sql(sql) -> {columns, rows, row_count}
```

**Registry build for that path:** `registry_build.run_build` reads the schema through `fetch_ontology_schema` (Neptune SPARQL), then runs `derive_mappings` (snake-cased guesses), `merge_registry` (idempotent MERGE), `smoke_test` and `emit_descriptor`. ARCHITECTURE §8.1 calls this path "false precision". It is kept for compatibility.

**Precision path:**

1. `SemanticPlanner(published).plan(select, filters, aggregate, group_by, limit)` resolves labels against a `PublishedMappingSet` only.
   - It raises `UnmappedConceptError`, `AmbiguousConceptError`, or `PlanningError` (for a non-numeric aggregate or many-to-many fan-out).
2. `SqlCompiler.compile(plan)` produces a `CompiledQuery(sql, parameters)`: validated, double-quoted identifiers, named `:pN` parameters, and a clamped LIMIT.
3. `DataAdapter.execute(sql, parameters)` runs the query.

README notes that the double-quoted identifiers are not Databricks-safe. `materialize.SqlDialect` handles quoting for the build.

**Agentic hybrid RAG (`pipeline.run`):**

1. `router.classify` labels the question `semantic`, `relationship` or `computational`. The default retrievers are `vector`, `graph` and `structured`. An optional LLM is used only to break ties.
2. `RetrieverRegistry.get(name).retrieve(RetrievalRequest)` returns `Passage[]`.
3. `synthesize` (injected; a deterministic stub by default) drafts the answer.
4. `critic.evaluate` checks that the draft is grounded and answers the question, and detects abstention.
5. If the critic fails the draft, `router.reroute` moves to an untried kind. The loop is bounded by `max_reroutes`, and the best attempt is returned.

Retrievers are pluggable. `InMemoryRetriever` works offline. `DatabricksVectorRetriever` loads its SDK lazily. `federate`, `dedupe` and `rrf_fuse` combine results.

---

## 4. Files by folder

### `src/graph_utility/`

| File | What it is for (why it exists) | Key functions/classes | Connects to |
|---|---|---|---|
| `__init__.py` | Public API that re-exports both layers (legacy OMDA and precision-first) | `__all__` (incl. `APPROVAL_PROFILES`, `build_graph`, `propose_mappings`…) | every module |
| `descriptor.py` | Per-BU config seam: everything BU-specific lives in a `GraphSource` | `OntologySource`, `BackendSource`, `GraphSource` (`tenant_id`, `approval_profile`, `validate`), `GraphSourceRegistry.from_dir` | serving, engine, ontology, build_graph_live |
| `discovery.py` | Typed, dataset-agnostic metadata and bounded, *masked* profiles | `LogicalType`, `KeyType`, `ColumnMetadata`, `KeyMetadata`, `JoinMetadata`, `TableMetadata.subject_key`, `DiscoveryResult`, `mask_value`, `profile_samples` | adapters, mapping, overlap |
| `data_adapter.py` | Structured data-plane seam (discover + execute compiled SQL); offline in-memory engine for tests | `DataAdapter`, `QueryResult`, `InMemoryTable`, `InMemoryDataAdapter` (safe parameterised SELECT subset) | csv_adapter, uc_adapter, tests |
| `uc_adapter.py` | Live Unity Catalog over REST (no Spark): keys come from declared constraints | `UnityCatalogDataAdapter` (`discover`, `execute`, `verify_uniqueness`, `join_overlap` via aggregate SQL, `table_qualifier`), `MAX_ROWS=10000` | Databricks SQL Statements API, overlap, materialize |
| `csv_adapter.py` | A directory of CSVs as a source: types inferred, no keys or joins declared | `infer_type`, `CsvDirectoryAdapter.from_directory` | data_adapter, `--csv-dir` |
| `ontology.py` | Reads ontology *schema* from Neptune SPARQL (SigV4, optional STS assume-role); client factory | `NeptuneOntologyClient`, `make_ontology_client` (`neptune`/`rdf-file`; `rdfox`/`none` raise), `assemble_axioms` | descriptor, registry_build, build_graph_live |
| `ontology_file.py` | Ontology-first entry: reads a *supplied* RDF file in the same shape as the Neptune client | `RdfFileOntologyClient` (`list_classes/properties/relationships/axioms`, `_synonyms`, `_has_key`), `infer_format`, `is_meta_term` | rdflib, mapping, reason |
| `mapping.py` | Proposals, the evidence-gated approval policy and the publication hard gate | `MappingProposal`, `ProposalKind` (direct/class/relationship/value-class), `term_match`, `propose_mappings`, `approve`/`reject`, `AutoApprovalPolicy`, `APPROVAL_PROFILES`, `auto_approve`, `publish_mappings`, `to_r2rml` | overlap, materialize, planner, compare |
| `overlap.py` | Measures joins and identity instead of guessing them | `verify_uniqueness`/`UniquenessProof`, `measure_join_overlap`/`JoinOverlap`, `candidate_column_sets`, `enrich_classes_with_uniqueness` (Pass 0 = `owl:hasKey`), `enrich_relationships_with_overlap` | mapping, adapters |
| `materialize.py` | Published mappings to N-Quads, one named graph per build | `materialize_graph`, `mint_subject_iri`, `mint_value_iri`, `serialize_quads`, `provenance_quads`, `write_nquads`, `diff_graphs`, `label_candidates`, `SqlDialect` (`ANSI`/`DATABRICKS`), `drop_graph_sparql` | build, neptune_load, neo4j_load |
| `reason.py` | Narrow entailment and constraint validation (Neptune has no OWL reasoner) | `prepare_tbox`, `entail` (semi-naive, capped), `validate_constraints`, `axioms_fingerprint`, `EntailmentReport`, `Violation` | build |
| `build.py` | The single governed build entry point, so every caller inherits the gates | `build_graph`, `BuildReport`, `BuildRefused`, `describe_build` | materialize, reason, build_graph_live |
| `neptune_load.py` | Upload to S3, Neptune bulk load, SPARQL quad-count verification | `load_build_into_neptune`, `NeptuneClient`, `graph_counts_from_nquads`, `NeptuneLoadReport` | boto3/S3, Neptune `/loader` and `/sparql` |
| `neo4j_load.py` | Loads the gated N-Quads artifact into Neo4j as a property graph | `plan_property_graph`, `PropertyGraphPlan`, `write_property_graph`, `LoadReport`, `rel_type`, `drop_build_cypher` (never run) | neo4j driver, rdflib |
| `ontobricks.py` | OntoBricks as a third graph target: hands off R2RML Turtle | `GraphTargetCapabilities`, `target_capabilities` (ontobricks/neptune/neo4j), `to_r2rml_turtle`, `R2RMLDocument` | mapping, compare tests |
| `compare.py` | Ablation: metadata-only versus measured-evidence mapping on the same data | `run_metadata_arm`, `run_measured_arm`, `score_arm`, `compare`, `Comparison`, `ArmResult` | mapping, overlap, compare_contractiq |
| `registry_build.py` | Legacy build plane: ontology to mapping-registry rows, as Temporal-ready activities | `fetch_ontology_schema`, `derive_mappings`, `merge_registry`, `smoke_test`, `emit_descriptor`, `run_build` | ontology, engine, jobs/ |
| `backends.py` | Legacy data-plane seam (registry, SQL, vector search) | `BackendAdapter`, `DatabricksUCAdapter` (Spark, Vector Search), `make_adapter` | engine, serving |
| `engine.py` | Legacy generic OMDA engine: question to concepts to SQL | `ConceptExtractor`, `SqlGenerator`, `OMDAEngine.answer` | backends, descriptor |
| `serving.py` | MLflow pyfunc that routes requests by `graph_source_id` | `OMDAServingModel` (`load_context`, `predict`) | Databricks Model Serving, engine |
| `planner.py` | Precision query: typed plan and safe SQL compile, fail-closed | `SemanticPlanner.plan`, `SqlCompiler.compile`, `SemanticQueryPlan`, `CompiledQuery`, error classes | mapping (`PublishedMappingSet`), data_adapter |
| `retriever.py` | Provider-neutral passage retrieval seam | `Retriever`, `RetrievalRequest`, `Passage`, `FieldMapping`, `InMemoryRetriever`, `DatabricksVectorRetriever`, `federate`, `dedupe`, `rrf_fuse` | pipeline |
| `router.py` | Classifies a question and picks a retriever; bounded escalation | `QuestionKind`, `classify`, `reroute`, `Route`, `DEFAULT_RETRIEVER` | pipeline |
| `critic.py` | Deterministic grounding and answer check (optional LLM override) | `evaluate`, `Verdict`, `CriticThresholds` | pipeline |
| `pipeline.py` | Agentic loop: classify, retrieve, synthesize, critique, reroute | `run`, `RetrieverRegistry`, `PipelineResult`, `Attempt` | router, retriever, critic |

### `integration/`

| File | What it is for | Key functions | Connects to |
|---|---|---|---|
| `build_graph_live.py` | The ontology-first build CLI (section 2); also what the control plane spawns | `main`, `_load_neptune`, `_load_neo4j`, `_register`, `_register_neptune`, `_post_register` | UC/CSV, Neo4j, Neptune+S3, control plane `/api/graph` |
| `provision_uc_clinical.py` | Creates a keyed demo schema (`graph_demo`: trial, investigator, site, trial_site with a composite PK and FKs); re-runnable | `run_sql`, `statements`, `main` (`--catalog`, `--schema`) | Databricks SQL Statements API |
| `compare_contractiq.py` | Runs the `compare.py` ablation offline (ContractIQ fixture) or live (refuses to run without `--truth` unless `--no-truth` is given) | `main` | compare, fixtures_contractiq, uc_adapter |

### `jobs/`

| File | What it is for | Key functions | Connects to |
|---|---|---|---|
| `build_registry_job.py` | Databricks Job entry point for the legacy registry build (fetch, derive, MERGE, smoke); prints a JSON summary and the descriptor | `main` (`--graph-source-id`, `--graph-sources-dir`, `--no-merge`) | registry_build, Neptune, Spark |

### Docs and packaging

| File | What it is |
|---|---|
| `README.md` | Three planes (control/query/build), the descriptor seam, the precision-first slice, offline test commands |
| `ARCHITECTURE.md` | Target architecture, query data flow, phased plan, the "false precision" problem and precision invariants |
| `docs/ONTOLOGY_FIRST.md` | The ontology-first chain, run command, design decisions, build gates, Neptune load, reasoning, overlap, known limits |
| `docs/TAKEDA_BU_KG_DESIGN.md` | Hub-and-spoke Takeda ontologies, evidence ladder, approval profiles, Neo4j/Neptune targets, `graph_query` tool, live measurements, dataset-agnostic axes |
| `docs/PHASE2_agentcontrol_provider.md` | Contract for the control plane's Graph Source provider (data model, `/api/graph`, UI, Cedar, tenant scoping) |
| `docs/ONTOBRICKS_COMPARISON.md` | Result of the metadata-versus-measured ablation, and OntoBricks as a target over R2RML |
| `docs/RDFOX_assessment.md` | Whether to add RDFox (incremental OWL materialisation); the seams it would plug into |
| `pyproject.toml` | Package `graph-utility` 0.1.0, Python ≥3.10; deps `boto3`, `requests`; extras `serving` (mlflow, pandas), `ontology` (rdflib), `neo4j` (neo4j, rdflib) |
| `requirements.txt` | boto3, requests, mlflow, pandas (pyspark and vectorsearch are commented out; the Databricks runtime provides them) |

---

## 5. Tests

All tests are offline: no network, no Spark. Each file runs as a script and prints `ALL … PASSED`.

| File | What it pins |
|---|---|
| `tests/test_precision_offline.py` | Discovery and masked profiling; name similarity never approves; joins without a universal key; approval and publish gate; R2RML provenance; planner fail-closed (unmapped, ambiguous, type, fan-out); compiler injection safety and limit clamp; composite FK joins; retrieval federation, dedupe and RRF; no ContractIQ assumptions |
| `tests/test_ontology_first_offline.py` | `RdfFileOntologyClient` reading rules (meta-vocabulary, blank-node domains, loud failures, named-graph scope); domain-restricted mapping; auto-approve threshold above the name cap; `auto:` provenance; end to end to a graph; key-only IRIs, composite keys, typed and escaped literals, nulls, conflation, truncation, determinism, `:prov` graph, teardown, content hash, dialect quoting |
| `tests/test_build_gates_offline.py` | Classes with no properties are still typed; dangling-edge detection; capped builds are reproducible (ORDER BY on the subject key); `build_graph` reports every gate at once; each gate waivable separately; waiver recorded in `:prov`; label designation rules; `diff_graphs` signatures |
| `tests/test_overlap_offline.py` | Containment must be full, exhaustive and into a unique parent; nulls and empty sides; candidate selection and ranking; profiling unblocks or leaves blocked; failing probes do not fail the build; ambiguity blocks; per-proposal budget; uniqueness rules (nullable, small, sampled and measure columns never become identity); canonical composite order |
| `tests/test_reasoning_offline.py` | Axioms read from the file and Neptune readers alike; subClass, subProperty, inverse, domain/range and transitive entailment; no literal subjects; no equality closure; inferred kept separate; caps reported; disjoint and functional violations; semi-naive equals naive; TBox fingerprint |
| `tests/test_takeda_profiles_offline.py` | Plural folding; `term_match` reports how it matched; skos synonyms read; `standard` automates synonyms with hard evidence; `gxp-strict` defers them; no profile approves name-only; unknown profile fails; descriptor tenant and profile; Neo4j plan (labels, props, edges, stamp protection, `rel_type`, teardown) |
| `tests/test_dataset_agnostic_offline.py` | Acronym-safe tokens; identifier-suffix stripping; value entities (one entity across tables, non-dangling edges, disambiguation by relationship name); `owl:hasKey` adopted only after measurement and rejected when contradicted; `gxp-strict` automates no inferred identity; a CSV directory builds the same graph |
| `tests/test_compare_offline.py` | The ablation is fair; scoring is honest (undefined precision, deferral is not success, wrong is worse than deferral); declared-join orientation; OntoBricks capabilities; R2RML Turtle well-formed and fail-closed |
| `tests/test_agentic_offline.py` | Router classification, tie-break and fallback; reroute terminates without repeats; critic grounding and abstention; pipeline reroutes to the graph retriever; Neptune/Neo4j swap is a registry change |
| `tests/test_engine_offline.py` | Legacy `OMDAEngine` with a `MockAdapter`: descriptor loading, concept extraction, filter detection, SQL generation |
| `tests/test_registry_build_offline.py` | `derive_mappings` rows and `run_build` sequencing with a `FakeOntologyClient` |
| `tests/fixtures_clinical.py` | Clinical-trials fixture: composite PK (`trial_site`), many-to-many, no universal key; ontology schema; abstract retriever fixture |
| `tests/fixtures_contractiq.py` | ContractIQ-shaped fixture with metadata "traps" (T1…) and ground truth, used by the comparison |
| `tests/fixtures/clinical_ontology.ttl` | Supplied clinical ontology with deliberately awkward cases (`rdfs:Class`, a foaf term, a `unionOf` domain, a plain `rdf:Property`, `xsd:dateTime`) plus axioms (`subClassOf`, `inverseOf`, `disjointWith`, `TransitiveProperty`, `FunctionalProperty`) |

---

## 6. Ontologies and descriptors

| File | What it is |
|---|---|
| `ontologies/takeda/rnd-clinical.ttl` | Illustrative R&D clinical spoke ontology (`tk:` = `http://example.org/takeda/rnd#`). Enterprise terms (ClinicalStudy, StudySite, PrincipalInvestigator, SiteAssignment…) with BU vocabulary as `skos:altLabel`, plus one `subClassOf` and one `inverseOf`. It only mentions `owl:imports` of a core in a comment. |
| `ontologies/takeda/supply-chain.ttl` | Illustrative `fn-supply` spoke (`scm:`) for the keyless, denormalised `workspace.scm_demo`. Classes (SalesOrder, Product, Customer, Warehouse, Location, TransportLane, InventoryPosition, LanePerformance), three `owl:hasKey`, and 14 `skos:altLabel`. |
| `tests/fixtures/clinical_ontology.ttl` | Test and demo ontology (`ct:`); the default `--ontology` in docs and examples (see section 5). |
| `graph_sources/contract-iq.json` | Legacy `GraphSource` descriptor for Contract IQ (Market Access). Neptune ontology (SigV4 assume-role), UC `usdev_corp.corp_us_mart` with `registry_table` and `universal_join_key=contract_key`, vector index, Databricks LLM endpoint, serving URL. Endpoints are `REPLACE-ME` placeholders. |

The control plane only builds from ontologies under `graph-utility/ontologies/`. `jobs.ts` rejects paths outside that directory.

---

## 7. Connections to other modules

- **AgentControl control plane** (`Agents_Express/control-plane`):
  - `src/lib/kg/jobs.ts::buildCommand` builds an argument list from the Graph Source's `kgSpec`:
    - always: `-I integration/build_graph_live.py --ontology ontologies/<f> --namespace … --profile-keys --profile-joins --reason --tenant … --approval-profile … --graph-source-id …`;
    - `--publisher <persona>` for `gxp-strict`;
    - `--catalog/--schema[/--table-filter]` or `--csv-dir`;
    - `--neo4j` (with the source's own `NEO4J_*` env) or `--neptune` (`NEPTUNE_ENDPOINT/PORT` from the source, and `NEPTUNE_S3_BUCKET` and `NEPTUNE_LOADER_ROLE_ARN` from the control plane's environment).
  - `startOntologyBuild` spawns `graph-utility/.venv/bin/python` (directory from `GRAPH_UTILITY_DIR`, default `../../graph-utility`) with a 15-minute timeout and one build per source. It tracks a `BuildRun`, parses `instances/edges/auto` and `urn:kg:build:kgb-…` from stdout, and audits the result.
  - On a successful Neptune build it updates the source's `namedGraphs` to `[graph, graph:inferred]`.
  - `jobs.ts` does not pass `--register`. Registration of a *new* draft source happens when an operator runs `build_graph_live.py --register <url>`, which POSTs to `/api/graph`.
  - Agents then query approved sources through `graph_query` (Cypher; Neo4j) and `graph_sparql` (SPARQL; Neptune), defined in `src/lib/tools/registry.ts` and `src/lib/graph/query.ts`.
  - On Neptune, SPARQL is scoped to the build's graphs. On a shared Neo4j database, separation relies on the `kg_source` stamp (TAKEDA design §8).
- **Databricks Unity Catalog:**
  - The `uc_adapter.py` and `provision_uc_clinical.py` scripts use the SQL Statements API over HTTPS (`DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`).
  - The legacy path uses Spark (`backends.py`), Vector Search, and Model Serving (`serving.py`).
- **Neo4j (Aura):** the `neo4j` Python driver in `neo4j_load.write_property_graph`, configured by `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` and `NEO4J_DATABASE` (default `neo4j`).
- **Amazon Neptune and S3:**
  - `neptune_load.py` uses boto3 S3 `put_object`, the loader `/loader`, and SPARQL `/sparql` on port 8182. Inside the VPC, no IAM DB auth is used.
  - `ontology.py` reads the ontology schema over SigV4 `neptune-db`.
- **Bedrock (optional):**
  - graph-utility makes no Bedrock calls itself. LLMs are injected callables (`llm_fn` in the engine, and the `llm` hooks in router and critic).
  - Registered sources carry `llmEndpoint: bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0`. The control plane uses that value.

---

## 8. How to run

Set up the environment from `graph-utility/`. `jobs.ts` expects `.venv/bin/python`; the extras come from `pyproject.toml`.

```bash
cd graph-utility
python3 -m venv .venv
.venv/bin/pip install -e '.[ontology,neo4j]'
```

Run every offline test (no network):

```bash
for t in tests/test_*_offline.py; do .venv/bin/python -I "$t" || break; done
```

Ontology-first build against Unity Catalog, writing N-Quads (from the `build_graph_live.py` docstring and `docs/ONTOLOGY_FIRST.md`):

```bash
export DATABRICKS_HOST=... DATABRICKS_TOKEN=... DATABRICKS_WAREHOUSE_ID=...
.venv/bin/python integration/build_graph_live.py \
    --ontology tests/fixtures/clinical_ontology.ttl \
    --namespace 'http://example.org/ontology/ct#' \
    --catalog workspace --schema graph_demo \
    --profile-joins --reason --out /tmp/clinical.nq
```

Per-tenant build loaded into Neo4j and Neptune, registered as drafts (`<id>` and `<id>-rdf`):

```bash
export NEO4J_URI=... NEO4J_USERNAME=... NEO4J_PASSWORD=... NEO4J_DATABASE=neo4j
export NEPTUNE_ENDPOINT=... NEPTUNE_S3_BUCKET=... NEPTUNE_LOADER_ROLE_ARN=... AWS_REGION=us-east-1
.venv/bin/python integration/build_graph_live.py \
    --ontology ontologies/takeda/rnd-clinical.ttl \
    --namespace 'http://example.org/takeda/rnd#' \
    --catalog workspace --schema graph_demo \
    --profile-keys --profile-joins --reason \
    --tenant fn-rnd --approval-profile gxp-strict --publisher "Jane Doe" \
    --neo4j --neptune --register http://localhost:3000/proxy/3000
```

Build from a CSV directory (no declared keys, so measure identity and joins):

```bash
.venv/bin/python integration/build_graph_live.py \
    --ontology ontologies/takeda/supply-chain.ttl \
    --namespace 'http://example.org/takeda/scm#' \
    --csv-dir /path/to/csvs --profile-keys --profile-joins --reason \
    --approval-profile standard --out /tmp/scm.nq
```

Other flags:

| Flag | Effect |
|---|---|
| `--table-filter` | Restrict discovery to matching tables |
| `--build-id` | Set the build id instead of a random `kgb-…` |
| `--base-uri` | Base URI for minted IRIs |
| `--max-rows-per-table` | Cap rows per table; truncation allowed, `complete=False` |
| `--approve-deferred-as NAME` | A named person approves the remaining approvable proposals |
| `--force` | Waive every gate, recorded in `:prov` |
| `--graph-source-id` | Set the Graph Source id instead of `<catalog>.<schema>` |
| `--json` | Print the manifest as JSON |

Other entry points:

```bash
python3 integration/provision_uc_clinical.py --catalog workspace --schema graph_demo   # keyed demo schema
python integration/compare_contractiq.py                                              # offline ablation
python integration/compare_contractiq.py --catalog C --schema S --ontology ont.ttl --truth truth.json
python jobs/build_registry_job.py --graph-source-id contract-iq \
    --graph-sources-dir /dbfs/FileStore/graph_utility/graph_sources [--no-merge]       # legacy, on Databricks
```

Teardown commands are printed by each build but never run by it:

- Neptune: `DROP GRAPH` for each of the build's graphs (`drop_graph_sparql`).
- Neo4j: `MATCH (n:KGEntity {kg_build:'<id>'}) DETACH DELETE n; …` (`drop_build_cypher`).
