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
- **Every approved class becomes typed nodes**, whether or not any of its
  literal properties were approved. This was a defect: the materializer
  iterated the tables that had DIRECT mappings, so a class approved with none
  of its properties approved emitted no `rdf:type` at all — while the
  relationship pass still minted edges pointing at its IRIs. Measured on the
  ContractIQ fixture: **3 edges to entities the graph never defined, and a
  manifest reporting `skipped=0`, `conflated=[]`.** A typed node with no
  literals is a valid entity; a referenced node that does not exist is not.
- **No edge to an undefined entity.** Every relationship object is checked
  against the build's type triples. `dangling_edges` counts them,
  `dangling_samples` shows the whole edge, and strict mode refuses. With the
  fix above, the only remaining cause is a row cap.
- **Truncation is reported *and reproducible*.** Hitting a row cap names the
  table in `truncated` and sets `complete == False`. Capped queries now carry
  `ORDER BY` on the subject key, because `LIMIT` without one returns an
  arbitrary row set: a capped build was not reproducible, while `write_nquads`
  hashed the bytes and presented that hash as provenance. Verified with a
  control — shuffling the source row order across 5 runs gives **1** artifact
  with the ordering and **5 distinct** artifacts without it.
- **Deterministic output.** Quads are sorted, so the same mappings over the same
  data give a byte-identical artifact; `write_nquads` returns a sha256. Note
  the provenance graph carries `prov:generatedAtTime`, so compare the data
  graph when checking reproducibility.
- **`sound` is separate from `complete`.** Coverage and correctness are
  different risks with different remedies: a graph can be complete and unsound
  (conflated entities) or sound and incomplete (capped). Both are reported, and
  both are recorded *in* the provenance graph, because a consumer querying the
  data months later has the manifest nowhere else.
- **Identifier quoting is per-dialect and validated.** Databricks parses `"x"` as
  a *string literal*, so double-quoted identifiers are a parse error there —
  verified against a live warehouse. `SqlDialect` makes this an input, and an
  identifier containing a quote, newline or semicolon is refused rather than
  escaped.
- **No inference.** Only asserted triples are read. A blank-node domain (the
  usual shape of `owl:unionOf`) is reported in `warnings` and left unset, never
  collapsed to the first class in the union. This matches Neptune, which has no
  reasoner either.

## One governed build (`build.py`)

`build_graph()` is the supported entry point: materialize → entail → validate
constraints → gate → serialize all three graphs.

It exists because the gates used to live in `integration/build_graph_live.py`,
which meant the demo runner was safe and every other caller — the control
plane, a Databricks job — inherited nothing, and would have had to
re-implement the same sequence and remember the same checks. **A guarantee
belongs to the function, not to one script.**

In `strict` mode it refuses four things, reporting all of them together so
fixing one is not how you discover the next:

| gate | why it is a refusal rather than a warning |
|---|---|
| `conflation` | two source rows merged onto one subject: the graph asserts something **false** |
| `dangling-edges` | a relationship to an entity the graph never defines |
| `truncation` | a prefix of the data presented as the whole; every count is wrong |
| `constraint-violations` | the data breaks a declared axiom, so the **mapping** is wrong |

Each is separately waivable (`allow_truncation=True`, …), because they are not
equally severe and a reviewer getting past one must not silently waive the
rest. **A waiver is written into the provenance graph** (`vocab/waived`), since
someone querying the data later has no access to the build log.

### Labels

Nothing emitted `rdfs:label` before, so a traversal returned bare IRIs — close
to useless for an agent composing an answer. Labels are now opt-in and
explicit: `label_candidates()` *proposes* the approved string properties per
class, and `label_properties=` names the chosen one. Picking by name shape
would be the exact guess the mapping pipeline refuses to make, and a label is
derived from triples already in the set, so it can never disagree with the
property it came from. A designated property that is not an approved mapping
raises rather than quietly emitting nothing.

### Build-to-build diff

`diff_graphs(before, after)` reports added/removed by predicate and by class,
plus subjects gained and lost. Cheap, because each build owns its named graph
and both versions are present at once.

The point is that a mapping regression is otherwise invisible at build time:
totals look plausible and the artifact hashes fine. On the fixture, dropping
one mapping shows as `removed_by_predicate {feesAmount: 6}` against
`removed_by_class {Contract: 6}`. Changing the subject IRI scheme shows as
`+76/-76` with 23 subjects replaced and **zero** unchanged — the
add-instead-of-replace signature that silently accumulates in a store.

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

- **Reasoning is batch, deliberately.** Incremental maintenance was researched
  and rejected on measurement, not taste. A correct implementation needs an
  algorithm sound under *cyclic* derivation — `prepare_tbox` folds
  `equivalentClass` into mutual `subClassOf`, so reference counting is provably
  wrong here — plus persisted state across what are separate job invocations.
  Measured against this rule set, correct DRed gives ~1.2-1.5x at the median
  re-publish delta (~8.6%, because withdrawing one mapping removes one triple
  per row) and *loses* at 30%. Batch `entail` is now semi-naive instead:
  ~1.1-1.2x on the non-recursive rules and ~3.3x on short transitive chains,
  with provably identical output. Re-open this above ~1M asserted triples with
  deltas under 10%, and prefer FBF with shallow backward chaining (what RDFox
  actually ships) over DRed or counting.
  Caveat: the semi-naive form is ~0.78x on a deep transitive chain (120 hops),
  where both join directions must each scan the known edge set. SCC-condensing
  transitive properties out of the fixpoint would fix that and is not done.
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
