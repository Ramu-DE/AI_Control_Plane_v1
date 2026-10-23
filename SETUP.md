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

### State is durable (since the snapshot store landed)

State is written to a JSON snapshot and **survives a restart**. It used to be
in memory only, which cost real work more than once — including a set of
hand-built agents, and then the demo data again when an env var needed a
restart.

```bash
# Where the snapshot lives. Default: .data/control-plane.json (gitignored).
export CONTROL_PLANE_STORE_PATH=/var/lib/agentexpress/control-plane.json
# Audit entries retained before the oldest are dropped. Default 5000.
export CONTROL_PLANE_MAX_AUDIT=5000
```

How it works, and what it is not:

- Reads stay synchronous; **no mutation site changed**. The store is wrapped in
  a change-tracking Proxy, so `store.agents.unshift(a)` and
  `record.status = "Approved"` mark it dirty by themselves. An explicit
  `persist()` at each of ~40 call sites would have been 40 chances to forget,
  and the failure is silent until a restart loses exactly what nobody saved.
- Writes are **debounced** (400 ms) and **atomic** — temp file then rename — so
  a crash mid-write cannot corrupt the snapshot. A stale snapshot loses
  seconds; a corrupt one loses everything.
- A2A peers persist to a **separate** file (`*.a2a.json`), matching their
  separate singleton.
- A corrupt or wrong-schema snapshot is **discarded loudly** and the seed runs.
  Merging an old shape into a new one would produce a half-migrated store that
  looks fine, which is the worst of the three outcomes. Bump `SCHEMA_VERSION`
  in `lib/persist.ts` when the shape changes incompatibly.
- Audit truncation is **recorded** as an audit entry, so the log always
  accounts for its own gaps.
- **Not multi-process safe and not transactional.** Two app instances sharing
  one snapshot file would clobber each other. Said plainly rather than guarded
  against, because pretending otherwise is worse than the limitation.

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

# Unity Catalog reach — how far a TOOL may read.
# Comma-separated catalog.schema prefixes. UNSET = unrestricted, which is the
# pre-existing behaviour; set it to bound what a prompt can reach.
export DATABRICKS_UC_ALLOWED_SCOPES=workspace.default,workspace.graph_demo

# Inbound A2A — lets EXTERNAL agents call this platform's agents.
# Optional, and off until configured.
export A2A_INBOUND_TOKEN="$(openssl rand -hex 24)"
export A2A_INBOUND_PERSONA=persona-john
export A2A_SELF_BASE_URL=https://<public-host>/proxy/3000
```

What each unlocks:

| Credential | Enables | Without it |
|---|---|---|
| `DATABRICKS_*` | Model Serving inference, Unity Catalog tools, SQL, KG derive | those steps report a config error |
| `NEO4J_*` | `/kg` and `/graph` read, the KG build write path | graph pages load, queries fail clearly |
| `QDRANT_*` | `/api/kb/retrieve` | KB retrieval unavailable |
| `AWS_*` | Bedrock models, Verified Permissions adapter | Bedrock steps fail; local Cedar still works |
| `A2A_INBOUND_*` | `POST /api/a2a/rpc` — external agents calling in | the endpoint returns 503; outbound A2A still works |
| `A2A_SELF_BASE_URL` | the public RPC url on the agent card, and the self-pointing seeded peers | the card falls back to request-derived values; the peers stay in `REPLACE-ME` preview mode |
| `DATABRICKS_UC_ALLOWED_SCOPES` | bounds how far `uc_query` / `uc_list_tables` / `uc_describe_table` may read | **unrestricted** — a tool can read any table the credential can see |

### Two controls worth setting before anyone else gets the URL

Both were adopted from the *Secure AI Agents on Amazon EKS* workshop, where the
agent's own IAM role carries three DynamoDB actions on one table ARN and **no
Bedrock permission at all** — model access exists only behind a gateway scoped
to named model ARNs.

**1. Model access is brokered.** Every model call now goes through
`lib/modelBroker.ts`, which checks the model is in the catalog, is on the
invoking tenant's allowlist (inherited down the tenant tree), and that the
declared runtime matches where the model is really served — then audits the
call with tenant, persona, model, plane, tool count and tokens. A refusal never
reaches a provider, so a denied call costs nothing. Set a tenant's allowlist
with `allowedModelIds` on `POST /api/tenants`; omit it to inherit, pass `[]` to
freeze a tenant. The Tenants page shows the effective rule and where it came
from.

The chokepoint is enforced by `tests/model-broker.test.ts`, which fails if any
route imports `lib/databricks` or `lib/bedrock` directly. Credentials cannot be
separated by IAM role inside one Next.js process, so that test *is* the
boundary — delete it and the broker is only a convention.

**2. Tool reach is bounded.** `DATABRICKS_UC_ALLOWED_SCOPES` limits which
`catalog.schema` a tool may touch. Read-only was never the whole question: the
credential can see the entire lakehouse, so a read-only statement could still
read all of it from a prompt. With the allowlist set, an out-of-scope query is
refused before it is sent, a statement that cannot be resolved to a qualified
table is refused rather than guessed at, and the permitted scope is reported
back in the tool result — so when it is *unset*, the model's own output says
the reach was unbounded.

### Inbound A2A, briefly

`GET /.well-known/agent-card.json` is public by design — a peer has to read the
card to learn how to authenticate. `POST /api/a2a/rpc` is not: it requires the
bearer token, and **fails closed**, returning 503 while `A2A_INBOUND_TOKEN` is
unset rather than accepting unauthenticated agent invocations on first deploy.

An inbound caller chooses a *skill* (one per `ready` agent, keyed by agent id)
and nothing else. The persona comes from `A2A_INBOUND_PERSONA`, the call goes
through the same Cedar `runAgent` gate as a workflow step, tools stay limited to
the agent's approved registry records, and every call is audited.

`A2A_SELF_BASE_URL` has to be explicit because request derivation gets it wrong
behind a TLS-terminating CDN: `x-forwarded-proto` is `http` there, so the card
advertised an `http://` endpoint that an HTTPS-only A2A client refuses.

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
