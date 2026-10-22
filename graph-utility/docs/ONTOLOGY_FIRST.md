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
   ├─ auto_approve                 threshold policy: measured evidence only
   │
   ├─ publish_mappings             the existing hard gate (fail-closed)
   │
   └─ materialize_to_nquads        N-Quads, one named graph per build
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
    --out /tmp/clinical.nq
```

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

## Known limits

- **No reasoning.** Neptune has no OWL reasoner, and this reader does none.
  Entailments must be materialised before ingest — that is the RDFox seam
  (`docs/RDFOX_assessment.md`), still config-only.
- **Matching is lexical.** Jaccard token overlap plus declared keys and
  `rdfs:domain`. No synonym, embedding or LLM-assisted alignment, so an ontology
  whose terms differ from the dataset's vocabulary will defer most proposals to a
  human rather than mapping them. That is the correct failure direction, but it
  is a limit.
- **`planner.SqlCompiler` still double-quotes identifiers**, so the *query* path
  would fail on Databricks for the same reason the materialiser did. Unfixed and
  out of scope here; `materialize.SqlDialect` shows the shape of the fix.
- **A table with no declared primary key yields no key**, so its class is blocked
  and nothing is materialised for it. The remedy is to declare the constraint,
  not to loosen the rule.
