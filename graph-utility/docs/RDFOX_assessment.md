# RDFox — integration assessment

**Question:** is [RDFox](https://www.oxfordsemantic.tech/) (Oxford Semantic Technologies,
part of Samsung since 2024) worth adding to graph-utility?

**Verdict: yes, for one specific reason — and not as "another graph database".**

---

## 1. The gap it fills

graph-utility's precision path already does the hard, careful part:

```
discover → propose → human approve → publish → to_r2rml()
```

`to_r2rml()` emits a content-addressed, provenance-carrying mapping artifact. And then
**nothing consumes it.** Verified:

```
$ grep -rn "to_r2rml" --include=*.py --include=*.ts .
  src/graph_utility/__init__.py      (export)
  src/graph_utility/mapping.py       (definition)
  tests/test_precision_offline.py    (tests only)
```

There is no engine in either track that turns an approved mapping into an actual knowledge
graph. RDFox is exactly that engine.

## 2. Why RDFox rather than the graph engines already in play

| Capability | Neo4j Aura (live) | Neptune (configured, unreachable) | RDFox |
|---|---|---|---|
| Data model | property graph | RDF | RDF |
| SPARQL | ✗ (Cypher) | ✅ | ✅ |
| OWL / ontology entailment | ✗ | partial | ✅ OWL 2 RL via rules |
| Datalog rules | ✗ | ✗ | ✅ |
| **Incremental materialisation** | ✗ | ✗ | ✅ **its differentiator** |
| Consumes R2RML-style mappings | ✗ | ✗ | ✅ |
| Licence | managed SaaS | AWS service | **commercial, key required** |
| Scale ceiling | disk | cluster | **RAM** (in-memory store) |

The decisive feature is **incremental reasoning**. This platform re-publishes mappings as
reviewers approve more proposals. With a batch materialiser every re-publish means
re-deriving the whole graph; RDFox updates only what the change affects (addition *and*
retraction). For a governed, repeatedly-approved pipeline that is the difference between a
build step you can run on every approval and one you run overnight.

Secondary benefit: **inferred edges**. Today a relationship exists only if a column shape
matches a key. With Datalog/OWL you can state `hasParentCompany` is transitive, or that
`Supplier ⊑ Party`, and the graph gains edges nobody had to enumerate.

## 3. Where it plugs in — two seams, both already present

### Seam 1 — ontology source *(implemented)*

`OntologySource.type = "rdfox"` is now accepted by the descriptor, alongside
`neptune | rdf-file | none`, with three reference-only fields:

```python
OntologySource(
    type="rdfox",
    rdfox_url="https://rdfox.internal:12110",
    rdfox_datastore="market_access",
    rdfox_auth_env_var="RDFOX_API_KEY",   # a REFERENCE, never a key
    namespace="http://ontology.example.com/ma#",
)
```

Validation fails closed when any of `rdfox_url` / `rdfox_datastore` / `namespace` is
missing. RDFox speaks SPARQL, so the client itself is a near-sibling of
`NeptuneOntologyClient` — `list_classes` / `list_properties` / `list_relationships`
against the same templates.

### Seam 2 — materialisation target *(designed, not built)*

The missing step, with an explicit contract:

```python
def materialize(published: PublishedMappingSet, source: GraphSource) -> MaterializeResult:
    """Load an APPROVED mapping set into RDFox and materialise it.

      1. ensure the datastore exists (create if absent)
      2. import the ontology (TBox)
      3. register the relational sources named by the mapping
      4. install the R2RML artifact from to_r2rml(published)
      5. add the Datalog/OWL rules
      6. return counts + the set_fingerprint actually materialised
    """
```

Everything it needs already exists: `to_r2rml()` output, `set_fingerprint` for idempotency
(skip if unchanged), and the approval gate guaranteeing nothing unapproved can be loaded.

## 4. Costs — be clear-eyed

- **Commercial licence.** A key is required; nothing can be demonstrated without one. This
  is the only hard blocker.
- **In-memory.** The graph must fit in RAM. Fine for an ontology plus curated instances,
  wrong for raw fact tables — which argues for keeping the data in Databricks and
  materialising only the governed, mapped subset (exactly what this pipeline produces).
- **A third runtime.** Neo4j and Neptune are already configured. RDFox should be added as
  the *reasoning layer*, not a third place to store graphs.
- **Operational surface.** Its own endpoint, auth, backup/restore story, and the SSRF
  allowlist entry the control plane requires for any outbound host.

## 5. Recommendation

**Add it as the reasoning/materialisation layer, behind the existing seams, when a licence
is available.** The ontology-source seam is in place now, so that step is config. The
materialisation step is the real work and is the piece that finally gives `to_r2rml()` a
consumer.

Until a licence exists, the equivalent flow runs on **Neo4j** — implemented and verified
live in the control plane (`lib/kg/derive.ts` → `lib/kg/materialize.ts`): ontology derived
from Unity Catalog, approved classes materialised as `OntologyClass` / `OntologyProperty` /
`Instance` nodes with real instance-level edges. What that path **cannot** do is entailment
or incremental re-materialisation, which is precisely the gap RDFox closes.

### Phasing

| Phase | Deliverable | Status |
|---|---|---|
| 1 | `OntologySource.type = "rdfox"` + validation | ✅ done |
| 2 | `RdfoxOntologyClient` (SPARQL, lazy deps, key by reference) | ⏳ needs licence |
| 3 | `materialize(PublishedMappingSet)` → RDFox datastore | ⏳ needs licence |
| 4 | Datalog/OWL rule packs per BU; incremental re-materialise on re-publish | ⏳ |
| 5 | Control-plane `/kg` reads RDFox via SPARQL alongside Neo4j | ⏳ |

Phases 2–5 are additive: no existing engine, adapter or test changes.
