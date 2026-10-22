# Ontology-first knowledge-graph build

**The requirement:** given an ontology, build the knowledge graph automatically,
irrespective of the dataset.

Before this, graph-utility could not do that, for two reasons worth stating
plainly:

1. An ontology could only be **read from a live Neptune SPARQL endpoint**. There
   was no file parser, so an ontology could not be *supplied* — only queried
   from one specific, unreachable cluster.
2. Nothing anywhere **built a graph**. Both tracks terminated in SQL;
   `to_r2rml()` emitted a mapping artifact that no code consumed. The ontology
   was a semantic index for text-to-SQL, not a build specification.

Separately, the only materialiser that *did* exist (in the TypeScript control
plane) ran the arrow backwards: it read Unity Catalog table metadata and
*derived* an ontology from it. There, the ontology is an output.

## The chain now

```
ontology.ttl                       the INPUT — mentions no table or column
   │
   ├─ RdfFileOntologyClient        classes / properties / relationships
   │                               (also Neptune, via make_ontology_client)
   │
dataset (Unity Catalog)
   │
   ├─ UnityCatalogDataAdapter      discover() reads DECLARED PK/FK constraints
   │                               from information_schema — never name shape
   │
   ├─ propose_mappings             candidates; ontology rdfs:domain constrains
   │                               which table a property may map to
   │
   ├─ enrich_..._with_overlap      measure referential containment, so an
   │                               UNDECLARED foreign key can be justified
   │
   ├─ auto_approve                 threshold policy: measured evidence only
   │
   ├─ publish_mappings             the existing hard gate (fail-closed)
   │
   ├─ materialize_graph            asserted triples -> urn:kg:build:<id>
   │
   ├─ entail                       ontology axioms -> urn:kg:build:<id>:inferred
   ├─ validate_constraints         disjointWith / functional -> findings
   │
   └─ serialize_quads              N-Quads
                                      │
                                      └─ S3 ─ Neptune bulk loader
```

## Run it

```bash
export DATABRICKS_HOST=...  DATABRICKS_TOKEN=...  DATABRICKS_WAREHOUSE_ID=...

python3 integration/build_graph_live.py \
    --ontology tests/fixtures/clinical_ontology.ttl \
    --namespace 'http://example.org/ontology/ct#' \
    --catalog workspace --schema graph_demo \
    --profile-joins --reason \
    --out /tmp/clinical.nq
```

`--profile-joins` measures undeclared foreign keys; `--reason` materialises
entailments and validates constraining axioms.

`integration/provision_uc_clinical.py` creates a keyed demo schema to run it
against (composite primary key, many-to-many junction, no universal join key).

## Design decisions, and why

**N-Quads, not a direct SPARQL write.** It is what Neptune's bulk loader ingests
fastest; the artifact is verifiable on its own with no cluster; and quads carry
the named graph, which is how a build gets an identity.

**One named graph per build — `urn:kg:build:<build_id>`.** Teardown becomes
`DROP GRAPH`, which is exact and atomic, rather than hunting nodes by a property
stamp. Two builds can also sit side by side for comparison instead of silently
merging — a failure mode we hit for real on the Neo4j side, where `MERGE` on a
URI meant that changing a label option added a second parallel ontology rather
than updating the first.

**RDF, not property graph.** Neptune stores RDF and property-graph data as
separate models in the same cluster; triples are not reachable from openCypher.
Since the ontology is OWL/RDFS read over SPARQL, RDF is the only choice where the
OWL actually means anything. (This rules out Neptune Analytics, which is
openCypher-only.)

**Automation follows evidence.** `auto_approve` clears a proposal only when the
assertion was *measured*, never when it was inferred from name resemblance:

| Kind | Auto-approves when |
|---|---|
| class | exact name match **and** a discovered primary key |
| datatype property | exact name match, ontology range matches the discovered column type, declared `rdfs:domain` agrees |
| relationship | exact endpoint matches **and** a discovered foreign key to join on |

`AUTO_APPROVE_MIN_CONFIDENCE` (0.55) is deliberately above
`NAME_SIMILARITY_MAX_CONFIDENCE` (0.5), so a name-only proposal cannot clear the
bar *by arithmetic*, not merely by policy.

The exact-match requirement is not pedantry. `siteName` overlaps `site_id` on one
of two tokens, and both columns being strings makes their types "compatible", so
confidence alone reaches 0.58 — above the floor. Name-plus-type would therefore
auto-approve a mapping of a site's **name onto its ID**. There is a test named
after this case.

Machine decisions are stamped `auto:` and still carry a written justification, so
they never count as human review. Anything deferred leaves the proposal
undecided, which still blocks strict publication: automation shortens the review
queue, it never empties it on your behalf.

## Precision guarantees

- **No fabricated subjects.** A NULL subject key skips the row and increments
  `rows_skipped_null_key`. There is no surrogate key.
- **A table with direct mappings but no published keyed class** cannot mint a
  precise subject, so strict mode raises and lenient mode records the omission.
- **A NULL column value emits no triple.** In RDF the absence of a statement *is*
  "unknown"; writing an empty string would assert something false.
- **A dangling reference emits no edge.** Verified live: the demo row whose
  `investigator_id` is NULL gets `atSite`, `forTrial` and `enrolledCount` but no
  `ledBy`.
- **Truncation is reported.** Hitting a row cap names the table in `truncated`
  and sets `complete == False`.
- **Deterministic output.** Quads are sorted, so the same mappings over the same
  data give a byte-identical artifact; `write_nquads` returns a sha256.
- **Identifier quoting is per-dialect and validated.** Databricks parses `"x"` as
  a *string literal*, so double-quoted identifiers are a parse error there —
  verified against a live warehouse. `SqlDialect` makes this an input, and an
  identifier containing a quote, newline or semicolon is refused rather than
  escaped.
- **No inference.** Only asserted triples are read. A blank-node domain (the
  usual shape of `owl:unionOf`) is reported in `warnings` and left unset, never
  collapsed to the first class in the union. This matches Neptune, which has no
  reasoner either.

## Loading into Neptune

```bash
aws s3 cp /tmp/clinical.nq s3://<bucket>/<prefix>/

curl -X POST https://<neptune-endpoint>:8182/loader \
  -H 'Content-Type: application/json' \
  -d '{"source":"s3://<bucket>/<prefix>/","format":"nquads",
       "iamRoleArn":"arn:aws:iam::<acct>:role/<NeptuneLoadFromS3>",
       "region":"<region>","failOnError":"TRUE"}'
```

Neptune is VPC-only, so this runs from inside the VPC. Reserve SPARQL
`INSERT DATA` for small incremental updates; use the loader for volume.

## Reasoning (`reason.py`)

Neptune has no OWL reasoner, so until the ontology's axioms were read they did
no work: `subClassOf` bought nothing, `inverseOf` left edges one-directional,
and `disjointWith` could not catch a mapping error.

**Two kinds of axiom, treated differently.** Conflating them is how reasoners
assert nonsense:

- **Generating** (`subClassOf`, `subPropertyOf`, `domain`, `range`,
  `inverseOf`, `equivalentClass`/`Property`, `TransitiveProperty`,
  `SymmetricProperty`) produce triples → `entail()`.
- **Constraining** (`disjointWith`, `FunctionalProperty`) cannot produce
  anything; a breach means the **mapping** is wrong → `validate_constraints()`
  returns findings. Reasoning over them would hide the bug.

**Inferred triples land in `urn:kg:build:<id>:inferred`**, never mixed with
asserted ones. That is what makes the result auditable: you can tell derived
from stated, recompute inference with one `DROP GRAPH`, or query asserted-only.
A build therefore owns three graphs — data, `:inferred`, `:prov` — and
`drop_graph_sparql` removes all three.

**Deliberately not implemented, with reasons:** `owl:sameAs`/equality closure
(explodes, and merging identities is dangerous when subject IRIs are minted from
keys — one error would silently fuse two real entities); class expressions
(`unionOf`, restrictions); cardinality (it constrains, so it belongs in
validation).

A literal is **never** made a subject: `siteName rdfs:range xsd:string` plus
`<s> siteName "North"` would naively yield `"North" a xsd:string`, which is not
legal RDF. Those are skipped and counted in `skipped_literal_range`.

The fixpoint is capped on iterations and inferred count; hitting either sets
`complete == False` rather than returning a partial closure silently.

Live run over `workspace.graph_demo`: 34 axioms → 13 inferred triples in 2
passes (3 `subClassOf`, 6 `subPropertyOf`, 4 `inverseOf`), 0 violations.

## Value-overlap profiling (`overlap.py`)

Most real datasets declare no foreign keys — the `agentexpress_*` tables in this
workspace have none — so constraint-reading finds no relationships and name
matching is back to guessing. Profiling asks the data instead: of the distinct
non-null values of `left.(cols)`, how many exist in `right.(cols)`, and is the
right side actually unique?

That is a measurement, so it may satisfy the auto-approval gate. **Two things
must both hold:**

1. **Full containment.** Anything less means orphan rows. Real foreign keys have
   referential integrity; 98% is a signal this is not the relationship you think
   it is, and a human should see it.
2. **The parent key is unique.** Joining to a non-unique column fabricates edges
   by fan-out, so without uniqueness it is not a foreign key at all.

**Sampling is never treated as proof.** `JoinOverlap.exhaustive` records whether
the whole relation was examined; a capped probe cannot auto-approve.
`UnityCatalogDataAdapter.join_overlap` answers in aggregate SQL so it is exact at
any table size; the generic fallback pulls keys and is exhaustive only under the
probe limit.

**Verified live.** On `workspace.graph_demo_nofk` (primary keys, no foreign
keys) the build produces **0 edges** without profiling. With profiling it finds
3 joins at 100% containment into unique keys and produces **11 edges** — and the
resulting artifact is **byte-identical** to the build against the schema that
*does* declare those foreign keys. Profiling recovers exactly the declared-key
result: no extra edges, none missing.

A tautological probe is refused: a column joined to itself on the same table is
vacuously 100% contained into a trivially unique key. This was caught in a live
run, where the self-referential `spansRegion` relationship produced
`<site/S1> spansRegion <site/S1>` for every row. A genuine self-reference
(`employee.manager_id -> employee.employee_id`) uses different columns and is
still probed.

## Known limits

- **Reasoning is batch-only.** Re-publishing re-derives the whole closure.
  Incremental maintenance (RDFox's actual differentiator) is under design;
  deletion is the hard half, since an inferred triple must survive if it still
  has an independent derivation.
- **The Neptune axiom reader is written but unverified.**
  `NeptuneOntologyClient.list_axioms()` issues two UNION queries plus a
  blank-node count, and `ontology.assemble_axioms` — the part that can diverge
  silently — is pure and tested for exact parity with the file reader. The
  SPARQL round trip itself has never run against a cluster.
- **Composite key discovery probes PAIRS only.** A three-column natural key is
  not found, and nor is a composite key whose columns are not key-shaped.
- **A measured key expires.** Uniqueness is a point-in-time measurement, so it
  is re-measured every build rather than cached. A Unity Catalog *declared* key
  is no stronger — UC constraints are informational and unenforced — which is
  why `materialize.py` now detects conflation on both paths.
- **Matching is otherwise lexical.** Jaccard token overlap plus declared and
  measured keys, measured containment and `rdfs:domain`. No `skos:altLabel`,
  embedding or LLM-assisted alignment, and no stemming — so an ontology class
  `Supplier` will not match a table named `suppliers`. An ontology whose terms
  differ from the dataset's vocabulary defers most proposals to a human: the
  right failure direction, but a limit.
- **`planner.SqlCompiler` still double-quotes identifiers**, so the *query*
  path would fail on Databricks for the same reason the materialiser did.
  Related: `SemanticPlanner._guard_fanout` only triggers on a `many-to-many`
  cardinality that nothing in the codebase ever emits, so it is effectively
  dead. Both unfixed; `materialize.SqlDialect` shows the shape of the first fix.
- **The Neptune load step is still unexecuted.** No cluster exists in this
  account; `drop_graph_sparql` and the loader invocation are emitted but have
  not been run against a live endpoint.
