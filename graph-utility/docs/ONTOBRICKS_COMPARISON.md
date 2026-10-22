# OntoBricks as a third graph target — and whether its mapping method is better

ContractIQ lives in Unity Catalog, so [OntoBricks](https://ontobricks.org)
(`databrickslabs/ontobricks`, v0.9.0) is the most native option available. This
adds it alongside Neptune and Neo4j, and answers the part that actually
matters: is its mapping approach as good as ours?

## 1. The comparison

Run it:

```bash
python integration/compare_contractiq.py                  # offline fixture
python integration/compare_contractiq.py --catalog C --schema S \
    --ontology ont.ttl --truth truth.json                 # live Unity Catalog
```

### It is an ablation, not a reimplementation

Both arms run the **same** `propose_mappings` and the **same** `auto_approve`.
The only difference is whether `enrich_classes_with_uniqueness` and
`enrich_relationships_with_overlap` run in between. One variable, and the
baseline is our own pipeline with the measurement switched off — not a
strawman built to lose.

It does **not** run OntoBricks. That needs a Databricks App and Lakebase, and
its LLM wizard would add a second uncontrolled variable. The baseline models
the **signals its documentation describes** — table and column names, comments,
types, declared keys — which is the part under test.

### Result on the ContractIQ fixture

| arm | approved | correct | wrong | deferred | precision | recall | profile queries |
|---|---|---|---|---|---|---|---|
| metadata-only | 11 | 11 | **0** | 4 | 100% | 73.3% | 0 |
| measured-evidence | 15 | 15 | **0** | 0 | 100% | **100%** | 11 |

**The honest headline: measurement does not prevent wrong mappings here — it
converts deferrals into automation.** Both arms score 100% precision, because
both are fail-closed: with no key evidence the proposer blocks rather than
guesses. The gap is entirely recall, 73% → 100%.

That is a weaker claim than "measurement stops errors", and it is the one the
data supports. A method that adopts a name-shaped key instead of deferring
would show up as `wrong` rather than `missed` — whether OntoBricks' LLM
auto-map does that is **unverified**, and it is the one thing a live spike
should settle.

### The four cases the metadata arm cannot do

| trap | what it tests | metadata | measured |
|---|---|---|---|
| T1 | no declared PK, but the column *is* unique | missed | correct |
| T2 | no declared key; the `*_id` single column is **not** unique | missed ×2 | correct ×2 |
| T3 | two plausible parents (`site` vs `site_archive`) | missed | correct |
| T4 | declared PK/FK | correct ×4 | correct ×4 |
| T5 | plain name match | correct ×7 | correct ×7 |

T2 is the one worth looking at. `contract_therapeutic_area` has no declared
key, and `contract_id` looks like one — `*_id`, non-null, first column — but a
contract spans several areas. Only `(contract_id, ta_code)` identifies a row.
The measured arm proves the composite; a single-column key there would silently
collapse rows, and every aggregate downstream would be wrong.

T3 is the other: `site` and `site_archive` have the same key column and similar
names. `contract.site_ref` references `site` (every value contained) and only
brushes `site_archive` (2 of 6). Names cannot separate them; containment can.

### What no amount of metadata can fix

An LLM reading good column comments would likely close part of the T4/T5 gap.
It **cannot** close T1, T2 or T3: no reading of names reveals whether a column
is unique, or whether two tables' values actually overlap. Those need the data.
This is stated in `compare.LLM_CAVEAT` so it travels with the numbers.

### Caveats worth stating plainly

- The real ContractIQ catalog (`usdev_corp.corp_us_mart`) is not reachable from
  this workspace, so the offline numbers come from a ContractIQ-**shaped**
  fixture built to carry these traps. The overlap and uniqueness measurements
  are real — `overlap.py` measures through `DataAdapter.execute`, so the
  in-memory adapter is measured exactly the way Unity Catalog is.
- 15 ground-truth terms is a small sample. The per-trap table matters more than
  the aggregate percentages.
- Live mode **requires** `--truth`. Without a labelled schema the arms merely
  disagree, with no basis for calling either one right; `--no-truth` reports
  automation rates and says explicitly that correctness is unknown.

## 2. A bug the comparison found

`_candidate_join` read only `table.keys` and never `DiscoveryResult.joins`.
The same fact has two representations, and the Unity Catalog adapter fills
both — a `FOREIGN` KeyMetadata *and* a JoinMetadata — so reading only the keys
happened to work there. **Any other adapter that populates only `joins`, which
the `DataAdapter` contract allows, had its declared foreign keys silently
ignored**: the relationship was blocked with `no-key-evidence`, and the join
could then only be recovered by profiling — paying a query to rediscover what
the catalog had already said.

Live ContractIQ was unaffected. Fixed anyway: `joins` is consulted first, and a
join declared in the opposite direction is re-oriented to the relationship
rather than read backwards. It removed 4 of the measured arm's 15 probes.

Side effect: joins sourced from `discovery.joins` now carry their true
`origin="declared"` instead of `"discovered"`. `origin` gates no logic —
profiling skips on `join is not None` — so this is a provenance label only. Two
tests that pinned the old string now assert the intent (key evidence, not a
measurement).

## 3. OntoBricks as a target

`graph_target` on a GraphSource: `"neptune" | "neo4j" | "ontobricks"`, or
omitted to emit N-Quads for manual loading. Declared rather than inferred,
because the targets are **not** interchangeable and the differences bite at
build time:

| capability | ontobricks | neptune | neo4j |
|---|---|---|---|
| named graphs / quads | **no** | yes | no |
| full SPARQL 1.1 | **no** | yes | no |
| property paths | **no** | yes | yes |
| aggregation | **no** | yes | yes |
| numeric filters | **no** | yes | yes |
| scoped teardown | **no** | yes | yes |
| reasoning ceiling | **50,000 triples** | none | none |

Verified against v0.9.0 source, not marketing:

- `SparqlCapabilityValidator` is fail-closed and rejects `GROUP BY`, `HAVING`,
  `ORDER BY`, `OFFSET`, property paths, subqueries, `MINUS`, `VALUES`,
  `SERVICE`, `GRAPH`, arbitrary `UNION`, non-literal `BIND`, and numeric
  filters. Supported FILTERs are `CONTAINS`/`STRSTARTS`/`STRENDS`/string
  equality/predicate `IN`.
- `OWLRLReasoner` loads an in-memory `rdflib.Graph` and self-documents
  *"Suitable for small instance datasets (< ~50 000 triples). For large
  datasets, use graph or SQL reasoning instead."*
- Triples are flat `(s,p,o)` in Delta/Postgres tables; there is no quad column,
  and `GRAPH` is rejected in queries anyway.
- Inferences are purged and rebuilt, not incrementally maintained.
- The Neo4j backend's Cypher translation is *scaffolded*, not complete.
- Licensed under the Databricks License — **not** OSI open source; use is tied
  to Databricks Services.

**For ContractIQ this is the deciding section.** "Contracts over 500k expiring
this quarter, by supplier" needs numeric filters, aggregation and ordering;
"every contract under any descendant org unit" needs property paths. None of
those are expressible. And with no named graphs a build cannot be scoped or
dropped as a unit — the same accumulation trap we avoid on Neptune with one
named graph per build.

`unsupported_for(["property_paths", "aggregation"])` lets the build plane refuse
an impossible plan *before* a build, instead of discovering it from a query that
silently returns the wrong rows. A mistyped capability raises rather than
reporting "supported".

## 4. The integration seam: R2RML

`to_r2rml_turtle()` emits W3C R2RML Turtle, which OntoBricks' `R2RMLParser`
ingests. That is the whole argument for using both: our side contributes
mappings justified by measured evidence, OntoBricks contributes
materialization, SHACL and an explorer, and R2RML is a standard on both sides.

It is a separate function from the existing `to_r2rml()` because that one emits
an R2RML-*shaped* dict whose `refObjectMaps` carry **no predicate** — fine for
our planner, which resolves relationships separately, and useless to an
external parser, which has only the document. The Turtle emitter walks the
RELATIONSHIP mappings directly so every join keeps its predicate.

Verified: parses with rdflib (81 triples, 5 TriplesMaps, 3 ref object maps),
and querying the artifact back shows the T3 resolution survived —
`site_ref → site_id` with parent `TriplesMap_site`, not the decoy. Fail-closed
rules carry over: a table with no published keyed class raises in strict mode
and is omitted-with-reason otherwise, never given a fabricated surrogate key.

## 5. Recommendation

Unchanged by the measurement, and now with numbers behind it:

- **Keep the measured mapping pipeline.** It is the part that is ours and
  defensible, and the ablation shows what it buys: 73% → 100% automation on
  exactly the cases a lakehouse actually contains — undeclared keys, composite
  junction keys, and archive tables that shadow live ones.
- **Keep Neptune as the graph target for ContractIQ.** It is the only one of
  the three that can answer ContractIQ's questions.
- **Take OntoBricks' standards, not its engine.** R2RML (done) and SHACL via
  `pyshacl` (worth doing) are real improvements. Its reasoning and query
  surface are weaker than what we have, not stronger.
- **The one open question is its Auto-Map.** Whether an LLM over column
  comments beats name matching on ContractIQ's real tables — and whether it
  *defers* or *guesses* when there is no key — is unresolved, and the only way
  to settle it is to run both on `usdev_corp.corp_us_mart` with a labelled
  truth set.
