In # Registering Amazon Neptune in the control plane

How to make a Neptune knowledge graph usable by agents: register the graph,
register the governed tool record, attach it to an agent, and test it.

UI: <https://d3ffzlzt3bv3lq.cloudfront.net/proxy/3000>

---

## 0. What gets registered where

Neptune is not a Registry record type. Three objects work together:

| Object | Page | What it is |
|---|---|---|
| **Graph Source** (backend `neptune`) | `/graph` | *Where the data is*: the Neptune endpoint plus the named graphs this source may read. Tenant-owned, needs approval. |
| **Registry record** (type *Custom*) | `/registry` | *What an agent may do*: exposes the tools `graph_schema` and `graph_sparql`. Needs approval. |
| **Agent** | `/agents` | Binds the record. Its tenant decides which Graph Sources it can see. |

Each tool call checks, in order:
1. the Graph Source is **Approved**;
2. it belongs to the agent's tenant or an ancestor (a **sibling BU's graph is refused**);
3. Cedar `queryGraphSource` **permits** this agent and persona;
4. the SPARQL is **read-only** `SELECT`/`ASK`. `FROM`, `GRAPH` and `SERVICE` are refused;
5. the query is **rewritten** to read only this source's named graphs.

Every call is audited.

## 1. Prerequisites

- **Cluster:** `agentcontrol-kg` in account **751885241433**, region **us-east-1**, created by
  `~/neptune-setup/create_neptune.sh`. Its endpoint, bucket and loader role are in
  `~/neptune-setup/neptune.env`.
- **Network:** this code-editor machine is in the same VPC. The security group allows port 8182 from it only.
- **Data loaded** into Neptune. Each build is one named graph `urn:kg:build:<id>`, plus `:inferred` and `:prov`:

```bash
cd ~/AI_Control/graph-utility
set -a; . ~/.config/agentcontrol/env; . ~/neptune-setup/neptune.env; set +a
export DATABRICKS_WAREHOUSE_ID=8e44598052761933
.venv/bin/python integration/build_graph_live.py \
  --ontology ontologies/takeda/supply-chain.ttl --namespace 'http://example.org/takeda/scm#' \
  --catalog workspace --schema scm_demo --profile-keys --profile-joins --reason \
  --tenant fn-supply --approval-profile standard --graph-source-id scm-kg \
  --neptune --register http://localhost:3000/proxy/3000
```

The output ends with `neptune : LOAD_COMPLETED … verified` and the build id (`kgb-…`).

Check the cluster from this machine:

```bash
. ~/neptune-setup/neptune.env
curl -s https://$NEPTUNE_ENDPOINT:8182/status
```

## 2. Register the Neptune Graph Source

The `/graph` **Register** form offers Databricks and Neo4j only, so use one of these.

### 2a. Automatically (recommended)

`--register` in the command above registers **`<graph-source-id>-rdf`** (here
`scm-kg-rdf`) as a **Draft**, owned by `--tenant`. It is scoped to that build's
data graph and `:inferred` graph. Go to step 2c.

### 2b. Manually (any build already in Neptune)

```bash
. ~/neptune-setup/neptune.env
CP=http://localhost:3000/proxy/3000
BUILD=kgb-38c6e7b1          # the build id to expose
curl -s -X POST $CP/api/graph -H 'content-type: application/json' -d @- <<EOF
{ "op": "register",
  "source": {
    "graphSourceId": "scm-kg-rdf",
    "bu": "fn-supply", "tenantId": "fn-supply",
    "displayName": "Supply chain KG on Neptune (RDF)",
    "description": "graph-utility build $BUILD on Neptune",
    "ontology": { "type": "none" },
    "backend": { "type": "neptune",
                 "endpoint": "https://$NEPTUNE_ENDPOINT:8182",
                 "namedGraphs": ["urn:kg:build:$BUILD", "urn:kg:build:$BUILD:inferred"] },
    "llmEndpoint": "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "allowedHosts": ["$NEPTUNE_ENDPOINT"] } }
EOF
```

Rules the server enforces:
- **`endpoint`** must be `https` and match `allowedHosts`.
- **`namedGraphs`** must be non-empty and start with `urn:kg:build:`.
- **`tenantId`** must be a real tenant. List them with `curl -s $CP/api/tenants`.

### 2c. Approve it

- **In the UI:** open **Graph Sources** (`/graph`), select the source, click **Submit for approval**, then **Approve**.
- **Or with the API:**

```bash
for s in "Pending approval" "Approved"; do
  curl -s -X PATCH $CP/api/graph -H 'content-type: application/json' \
    -d "{\"graphSourceId\":\"scm-kg-rdf\",\"status\":\"$s\"}" | grep -o '"status":"[^"]*"'
done
```

### 2d. Check it answers, and stays in scope

```bash
curl -s -X POST $CP/api/graph -H 'content-type: application/json' \
  -d '{"op":"query","graphSourceId":"scm-kg-rdf","personaId":"persona-john","question":"classes"}'
```

You should see only this source's classes (for supply chain: `Customer`,
`InventoryPosition`, `LanePerformance`, `Location`, `Product`, `SalesOrder`,
`TransportLane`, `Warehouse`). Classes from other builds in the same cluster
must not appear.

## 3. Register the tool record (UI)

1. **Registry** (`/registry`): open an existing registry, or click **Create registry**.
   Name it, for example, `Neptune_Registry`.
2. Click **Create record** and fill in:

| Field | Value |
|---|---|
| Record source | **Define manually** |
| Type | **Custom** |
| Record Name | `Neptune_Graph_Tools` |
| Description | `Governed read-only SPARQL over approved Neptune Graph Sources` |
| MCP schema | paste the JSON below |
| Authentication | **No authorization** (see note) |

```json
{
  "name": "NeptuneGraphTools",
  "version": "1.0.0",
  "toolSchema": [
    {
      "name": "graph_schema",
      "description": "Classes and predicates (with counts) in an approved Graph Source",
      "inputSchema": { "type": "object",
        "properties": { "graph_source_id": { "type": "string" } },
        "required": ["graph_source_id"] }
    },
    {
      "name": "graph_sparql",
      "description": "One read-only SPARQL SELECT/ASK against an approved Neptune Graph Source",
      "inputSchema": { "type": "object",
        "properties": { "graph_source_id": { "type": "string" },
                        "sparql": { "type": "string" },
                        "limit": { "type": "number" } },
        "required": ["graph_source_id", "sparql"] }
    }
  ]
}
```

3. **Create**, then on the record click **Submit for Approval**, then **Approve**.

Notes:
- **Tool names must be exactly** `graph_schema` and `graph_sparql`. Those are
  the names the platform can run. Any other name is listed as "approved but
  not implemented" and never runs.
- **"No authorization" is correct here.** Neptune is reached inside the VPC
  with no credential (the security group is the boundary). Authorization
  happens per call: tenant, Cedar and read-only checks, as in §0. No secret is
  stored on the record.
- **Tenant:** the UI form has no tenant field, so a record created there is
  **platform-provided** (attachable by any tenant's agents). Isolation still
  holds, because the *Graph Source* is tenant-owned and every call checks it.
  To make the record itself tenant-owned, use the API instead (§3a).

### 3a. API equivalent (tenant-owned record)

```bash
CP=http://localhost:3000/proxy/3000
REG=$(curl -s -X POST $CP/api/registry -H 'content-type: application/json' \
  -d '{"kind":"registry","name":"Neptune_Registry","description":"Neptune graph tools"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
REC=$(curl -s -X POST $CP/api/registry -H 'content-type: application/json' -d @- <<EOF | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])"
{ "kind":"record", "registryId":"$REG", "tenantId":"fn-supply",
  "type":"Custom", "recordSource":"define-manually", "credentialType":"No authorization",
  "name":"Neptune_Graph_Tools",
  "description":"Governed read-only SPARQL over approved Neptune Graph Sources",
  "mcpSchema":{"name":"NeptuneGraphTools","version":"1.0.0","toolSchema":[
    {"name":"graph_schema","description":"inventory","inputSchema":{"type":"object","properties":{"graph_source_id":{"type":"string"}},"required":["graph_source_id"]}},
    {"name":"graph_sparql","description":"read-only SPARQL","inputSchema":{"type":"object","properties":{"graph_source_id":{"type":"string"},"sparql":{"type":"string"},"limit":{"type":"number"}},"required":["graph_source_id","sparql"]}}]}}
EOF
)
for s in "Pending approval" "Approved"; do
  curl -s -X PATCH $CP/api/registry -H 'content-type: application/json' \
    -d "{\"id\":\"$REC\",\"status\":\"$s\"}" | grep -o '"status":"[^"]*"' | head -1
done
echo "record: $REC"
```

## 4. Attach it to an agent (UI)

**Agents** (`/agents`): click **Create agent** and fill in:

| Field | Value |
|---|---|
| Tenant | the Graph Source's tenant (`fn-supply` for `scm-kg-rdf`), or a descendant |
| Model | **Claude Sonnet 4.6** (Bedrock). The seeded *Claude Opus 4.6* id is not available in this account. |
| Runtime | agent runtime `aws-agentcore-runtime`, model runtime **`aws-bedrock`** (it must match where the model is served) |
| Tools | **Neptune_Graph_Tools** (only Approved records are listed) |
| Status | **ready** (workflows only run ready agents; agents cannot be edited after creation) |

System prompt template:

```
You are a supply-chain analyst. Graph Source scm-kg-rdf is the ontology-built
knowledge graph on Neptune; query it with graph_sparql (SPARQL SELECT; ontology
namespace http://example.org/takeda/scm#). Call graph_schema first. Do not use
FROM, GRAPH or SERVICE: queries are scoped automatically. Report only facts the
graph returns and show the SPARQL you relied on.
```

## 5. Test end to end

1. **Workflows** (`/workflows`): create a workflow for the same tenant, with one step bound to the agent and the **review gate** on.
2. **Start** it as a persona, for example:
   *"For each product, compare ordered units with free stock (on hand minus reserved). Which are short, and who ordered them?"*
3. **Check the run:**
   - the step shows `graph_schema` and `graph_sparql` calls;
   - the answer cites real IDs (for example SKU-PLA-12 short by 150);
   - it pauses for review. **Approve** it.
4. **Audit** (`/audit`): each call is recorded as `ALLOW tool SPARQL to 'scm-kg-rdf' (… rows) (agent …, workflow)`, with persona and tenant.

Refusals worth trying (each must fail, and run nothing):

| Try | Expected |
|---|---|
| Agent in `fn-rnd` querying `scm-kg-rdf` | `TENANT_DENIED` |
| `SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } }` | `UNSAFE_QUERY`: GRAPH is not permitted |
| `DROP ALL` / `INSERT DATA {…}` | `UNSAFE_QUERY`: read-only only |
| `… SERVICE <http://…> {…}` | `UNSAFE_QUERY`: SERVICE not permitted |
| Cypher sent to a Neptune source | `UNSUPPORTED_BACKEND`: use graph_sparql |

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Knowledge Graph** page: "has backend 'neptune'; the knowledge-graph builder targets a neo4j backend" | That page writes to Neo4j only, and its dropdown now lists Neo4j sources only (reload the page). Neptune builds come from `build_graph_live.py --neptune`. |
| Can't see the cluster in the AWS console | Account **751885241433**, region **us-east-1**, **Neptune → Databases** (not *Graphs*, which is Neptune Analytics). It is also listed under **RDS → Databases**. A limited workshop console role may not be allowed to list it. |
| `NOT_CONFIGURED` | `allowedHosts` does not match the endpoint host, or the endpoint is not `https`. |
| `backend namedGraphs must be graph-utility build graphs` | Use `urn:kg:build:<id>` and `urn:kg:build:<id>:inferred` exactly. |
| Agent never calls the tool | The record is not Approved, it was not attached when the agent was created, or a tool name is misspelled. Check the step's notes: "N executable tool(s) offered". |
| `model identifier is invalid` | Use Claude Sonnet 4.6 / Sonnet 4.5 / Opus 4.5 / Haiku 4.5. |
| Query timeout / connection refused | Run it from this code-editor machine (same VPC). Check `curl https://$NEPTUNE_ENDPOINT:8182/status`. |

## 7. Removing it

- **One build's data** (exact; other builds untouched):
  `DROP GRAPH <urn:kg:build:ID>; DROP GRAPH <urn:kg:build:ID:inferred>; DROP GRAPH <urn:kg:build:ID:prov>`
- **Graph Source:** Deprecate it in `/graph`.
- **Record:** Deprecate it in `/registry`. Approved records are deprecated, never deleted.
- **The cluster and everything created with it** (stops hourly billing):
  `bash ~/neptune-setup/delete_neptune.sh`
