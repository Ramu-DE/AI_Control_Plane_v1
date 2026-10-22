# Running this locally

Three independent projects live here. Each runs on its own; none needs the
others to start.

| Folder | What it is | Runtime |
|---|---|---|
| `Agents_Express/control-plane` | The governed agent control plane (UI + API) | Node / Next.js |
| `graph-utility` | Ontology-first knowledge-graph builder and precision query path | Python |
| `a2a-demo` | Reference A2A peer agents — **reference only**, not wired into the control plane | Python |

Verified on Node **24.21.0** / npm **11.19.0** and Python **3.13.15**. The
control plane needs Node 20+; `graph-utility` declares `requires-python >=3.10`.

---

## 1. Control plane (the UI)

```bash
cd Agents_Express/control-plane
npm install
npm run dev            # http://localhost:3000
```

Other scripts: `npm test` (node:test over `tests/**/*.test.ts`),
`npm run typecheck`, `npm run build`, `npm run lint`.

**It starts with no credentials at all.** Pages render, the seeded tenants /
personas / policies / Cedar policies are all in memory, and anything that would
reach a live service reports a clear error instead of pretending. Add
credentials only for the paths you want to exercise (§3).

### Behind a path prefix

Only needed if you serve it under a sub-path (as the workshop box does via
nginx + CloudFront):

```bash
BASE_PATH=/proxy/3000 npm run dev     # then http://localhost:3000/proxy/3000
```

Leave `BASE_PATH` unset for a normal local run.

### State is in memory

`src/lib/store.ts` is a module-level store. Everything you create through the
UI — agents, workflows, registry records, audit entries — **disappears when the
dev server restarts.** That is deliberate for a demo, and worth knowing before
you wonder where your agent went.

---

## 2. graph-utility (Python)

```bash
cd graph-utility
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/pip install 'rdflib>=7.0'      # only for reading an ontology FILE
```

`rdflib` is an optional extra (`pip install -e '.[ontology]'`) because the rest
of the module — mapping, approval, materialisation — is stdlib-only. Writing
N-Quads does not depend on it.

Run the whole suite, no network required:

```bash
for t in tests/test_*.py; do .venv/bin/python -I "$t"; done
```

Expect all seven to pass. Two of them (`test_ontology_first_offline.py`,
`test_reasoning_offline.py`) need `rdflib`, so use the venv's Python, not the
system one. The randomised differential test in `test_reasoning_offline.py` is
worth running under a few hash seeds, because set iteration order is exactly
where an entailment bug would hide:

```bash
for s in 0 1 2 7; do PYTHONHASHSEED=$s .venv/bin/python tests/test_reasoning_offline.py; done
```

### Building a real graph from an ontology

Needs Databricks (§3). Reads an ontology file, discovers a dataset, and writes
N-Quads:

```bash
.venv/bin/python -I integration/build_graph_live.py \
    --ontology tests/fixtures/clinical_ontology.ttl \
    --namespace 'http://example.org/ontology/ct#' \
    --catalog workspace --schema graph_demo \
    --profile-keys --profile-joins --reason \
    --out /tmp/graph.nq
```

- `--profile-keys` measures column uniqueness, so a table with no declared
  primary key can still be keyed.
- `--profile-joins` measures referential containment, so an undeclared foreign
  key can still be justified.
- `--reason` materialises entailments into a separate `:inferred` named graph
  and validates the constraining axioms.

To create a dataset to point it at:

```bash
.venv/bin/python -I integration/provision_uc_clinical.py --schema graph_demo
```

That creates four tables with real PK/FK constraints (including a composite
key) in their own schema, touching nothing else.

---

## 3. Credentials

All read from the **environment**, by name. Nothing is read from a file in the
repo, and no credential is ever written to a record — registry entries store an
env var *name* (`tokenEnvVar`), never a value.

```bash
# Databricks — model serving, Unity Catalog, SQL warehouse
export DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
export DATABRICKS_TOKEN=<personal access token>
export DATABRICKS_WAREHOUSE_ID=<sql warehouse id>

# Neo4j / Aura — the knowledge-graph read and write path
export NEO4J_URI=neo4j+s://<id>.databases.neo4j.io
export NEO4J_USERNAME=neo4j
export NEO4J_PASSWORD=<password>
export NEO4J_DATABASE=neo4j

# Qdrant — RAG retrieval
export QDRANT_URL=https://<cluster>.cloud.qdrant.io
export QDRANT_API_KEY=<key>

# AWS — Bedrock inference, and Verified Permissions if you enable it
export AWS_REGION=us-west-2
export AWS_EXECUTION_MODE=local          # set to 'aws' for live AWS calls
```

What each unlocks:

| Credential | Enables | Without it |
|---|---|---|
| `DATABRICKS_*` | Model Serving inference, Unity Catalog tools, SQL, KG derive | those steps report a config error |
| `NEO4J_*` | `/kg` and `/graph` read, the KG build write path | graph pages load, queries fail clearly |
| `QDRANT_*` | `/api/kb/retrieve` | KB retrieval unavailable |
| `AWS_*` | Bedrock models, Verified Permissions adapter | Bedrock steps fail; local Cedar still works |

Local Cedar authorization — the gate the product actually enforces on agent
runs, A2A calls and KG builds — needs **no** credentials. `AWS_EXECUTION_MODE`
only governs the separate AWS Verified Permissions adapter.

The dev server reads the environment at **startup**, so export before
`npm run dev`.

---

## 4. Checking it works

With the control plane running and Databricks exported:

```bash
cd Agents_Express/control-plane
node integration/smoke_control_plane.mjs
# add --base http://localhost:3000 if you did not set BASE_PATH
```

It walks the full journey through the same HTTP endpoints the UI buttons call:
register a Databricks model, create an agent on it, publish a tool and move it
`Draft → Pending approval → Approved`, bind it, build a workflow, run it for
real, take the review-gate decision, then confirm the audit trail. It also
checks the refusals — plane mismatch, draft tool, unapproved transition, missing
persona, unknown persona on a KG build, unbounded traversal depth, an A2A peer
pointing at the instance metadata service.

Expect **78 pass, 0 fail, 2 skip**. The two skips are Verified Permissions
(needs `AWS_EXECUTION_MODE=aws` and a real policy store) and Qdrant KB retrieval
(needs a registry record you create).

It does not drive a browser — there is no headless Chrome assumed. Page
rendering is asserted as HTTP 200 plus a document marker; everything else hits
the endpoint behind the control.

---

## 5. a2a-demo

```bash
cd a2a-demo
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

`requirements.txt` says `a2a-sdk>=0.2.0`, but the code in `src/` matches the
**0.2.x** API. Version 1.x moved things and will not import against this code:

```bash
.venv/bin/pip install 'a2a-sdk==0.2.16'
```

This folder is a **reference implementation**. The control plane has its own A2A
client under `src/lib/a2a/`; it does not import or run anything from here.

---

## Known limits

Read before judging output:

- `graph-utility/docs/ONTOLOGY_FIRST.md` — candidate selection is still
  name-shaped, composite key discovery probes pairs only, name matching has no
  stemming, reasoning is batch by design (with the measurements behind that
  decision), and the Neptune load step has never run against a cluster.
- `graph-utility/docs/RDFOX_assessment.md` — what RDFox would add, and what is
  config-only today.
- Malformed JSON returns **500** rather than 400 on most control-plane POST
  routes, because `await req.json()` is unguarded. `src/app/api/kg/route.ts`
  shows the one-line fix.
- `planner.SqlCompiler` emits double-quoted identifiers, which Databricks parses
  as string literals — so the text-to-SQL *query* path would fail there.
  `graph-utility/src/graph_utility/materialize.py` (`SqlDialect`) shows the fix.
