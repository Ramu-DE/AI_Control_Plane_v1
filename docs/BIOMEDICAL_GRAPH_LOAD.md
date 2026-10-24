# Loading the BioMedical graph into Neo4j and registering it as a Graph Source

Source repo: <https://github.com/Ramu-DE/BioMedicalGraph-neurosymbolic-governance->

The repo ships no data files. Notebook `03` pulls a slice from public APIs
(ClinicalTrials.gov, openFDA, RxNorm, HGNC) and writes it to Neo4j; notebook `04`
resolves entities. Both only `MERGE`/`CREATE` — neither deletes anything.

> **Shared database.** This loads into the same Aura instance as the supplier
> graph (`aura-supplier-graph`). Labels do not collide, but a Neo4j Graph Source
> covers the whole database, so the two sources are not isolated from each other.

Run every command from a terminal on the workshop box. In Claude Code, prefix
each with `! ` to run it in the session.

---

## 0. Prerequisites (already done on this box)

- Credentials env file: `~/.config/agentcontrol/env` (mode 600, outside the repo)
- Control plane running: `~/.config/agentcontrol/start.sh`
- Backup of the current graph: `~/neo4j-backup/aura-backup-2026-10-23.json`

## 1. Clone and install

```bash
mkdir -p ~/external && cd ~/external
git clone https://github.com/Ramu-DE/BioMedicalGraph-neurosymbolic-governance-.git biomedical
cd biomedical
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q          # expect 197 passed
```

## 2. Point the repo at Neo4j

`.env` is gitignored by the repo. The values come from the env file, so no
secret is typed or shown.

```bash
cd ~/external/biomedical
. ~/.config/agentcontrol/env
umask 077
printf "NEO4J_URI=%s\nNEO4J_USERNAME=%s\nNEO4J_PASSWORD=%s\nNEO4J_DATABASE=%s\n" \
  "$NEO4J_URI" "$NEO4J_USERNAME" "$NEO4J_PASSWORD" "$NEO4J_DATABASE" > .env
.venv/bin/python config.py             # expect: neo4j configured=True
```

## 3. Load the graph (notebooks 03 + 04)

```bash
cd ~/external/biomedical
.venv/bin/python ~/external/biomedical-runs/run_notebooks.py
```

Expect `OK` after each notebook (~40 s total). Executed copies are saved to
`~/external/biomedical-runs/`; the repo's notebooks are not modified.

The default slice is small (melanoma, `limit=10`). For a larger graph, edit the
`fetch_trials(...)` / `fetch_adverse_events(...)` calls in
`notebooks/03_multi_source_ingest.ipynb` before running.

## 4. Verify what landed

```bash
cd ~/AI_Control/Agents_Express/control-plane
set -a; . ~/.config/agentcontrol/env; set +a
node -e "
const neo4j=require('neo4j-driver');
const d=neo4j.driver(process.env.NEO4J_URI,neo4j.auth.basic(process.env.NEO4J_USERNAME,process.env.NEO4J_PASSWORD));
d.executeQuery('MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS c ORDER BY c DESC',{},{database:process.env.NEO4J_DATABASE})
 .then(r=>{r.records.forEach(x=>console.log(x.get('l').padEnd(24),x.get('c').toString()));return d.close()})"
```

Expect the biomedical labels (`ClinicalTrial`, `Disease`, `Mention`,
`AdverseEventReport`, `Reaction`, ...) alongside the supplier labels
(`Supplier`, `Contract`, `Site`, ...), which must still be present.

## 5. Register the BioMedical Graph Source in the control plane

Uses the same API as the UI. Only the **name** of the password env var is sent;
the server resolves the value itself.

```bash
CP=http://localhost:3000/proxy/3000
. ~/.config/agentcontrol/env
HOST=$(node -e "const h=new URL(process.argv[1]).hostname.split('.');console.log(h.length>3?h.slice(1).join('.'):h.join('.'))" "$NEO4J_URI")

# Register (starts as Draft)
curl -s -X POST $CP/api/graph -H 'content-type: application/json' -d @- <<EOF
{ "op": "register",
  "source": {
    "graphSourceId": "biomedical",
    "bu": "fn-rnd",
    "tenantId": "fn-rnd",
    "displayName": "BioMedical Graph (Neo4j Aura)",
    "description": "Clinical trials, diseases, drugs, adverse events and genes from ClinicalTrials.gov, openFDA, RxNorm and HGNC.",
    "ontology": { "type": "none" },
    "backend": { "type": "neo4j", "uri": "$NEO4J_URI", "database": "$NEO4J_DATABASE",
                 "username": "$NEO4J_USERNAME", "authSecret": { "envVar": "NEO4J_PASSWORD" } },
    "llmEndpoint": "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "allowedHosts": ["$HOST"] } }
EOF
echo

# Approve: Draft -> Pending approval -> Approved
for s in "Pending approval" "Approved"; do
  curl -s -X PATCH $CP/api/graph -H 'content-type: application/json' \
    -d "{\"graphSourceId\":\"biomedical\",\"status\":\"$s\"}" | grep -o '"status":"[^"]*"'
done
```

The tenant `fn-rnd` (R&D) must be a real tenant id — list them with
`curl -s $CP/api/tenants`. Use `fn-medical` instead if preferred.

## 6. Query it through the governed path

```bash
CP=http://localhost:3000/proxy/3000

# Label inventory
curl -s -X POST $CP/api/graph -H 'content-type: application/json' \
  -d '{"op":"query","graphSourceId":"biomedical","personaId":"persona-john","question":"what labels exist in this graph","preview":false}'
echo

# Trials and the diseases they study
curl -s -X POST $CP/api/graph -H 'content-type: application/json' \
  -d '{"op":"query","graphSourceId":"biomedical","personaId":"persona-john","question":"trials and diseases","cypher":"MATCH (t:ClinicalTrial)-[:STUDIES]->(d:Disease) RETURN t.nct_id AS trial, d.entity_id AS disease LIMIT $limit","preview":false}'
echo
```

If a query returns a Cedar denial, the persona has no `queryGraphSource`
permit for tenant `fn-rnd` — add one under **Policies**.

## 7. Confirm nothing else broke

```bash
cd ~/AI_Control/Agents_Express/control-plane
node integration/smoke_control_plane.mjs     # last run: 97 pass, 0 fail, 2 skip
```

The source is then visible at
<https://d3ffzlzt3bv3lq.cloudfront.net/proxy/3000/graph>.

## 8. Index the graph into Qdrant and register it as a Knowledge Base

Reads Neo4j (read-only), builds one chunk per ClinicalTrial and per
AdverseEventReport tagged with graph `entity_ids`, embeds with
`amazon.titan-embed-text-v2:0` (1024 dims — the model the control plane queries
with) and upserts into `biomedv2__amazon-titan-embed-text-v2-0__chunk-v1`.
Re-running is safe: point ids are derived from `chunk_id`.

```bash
set -a; . ~/.config/agentcontrol/env; set +a
AWS_REGION=us-east-1 ~/external/biomedical/.venv/bin/python -I ~/external/biomedical-runs/index_qdrant.py
```

The control plane reads `QDRANT_URL` / `QDRANT_API_KEY` at startup, so restart it
after a key change (`~/.config/agentcontrol/start.sh`). The record references
the key by env var name only (`auth.apiKeyEnvVar`).

Registered as `BioMedical_Qdrant_KB` in `BioMedical_Registry` (tenant `fn-rnd`,
Approved). Query it:

```bash
CP=http://localhost:3000/proxy/3000
REC=$(curl -s $CP/api/registry | python3 -c "import json,sys;print(next(r['id'] for r in json.load(sys.stdin)['records'] if r['name']=='BioMedical_Qdrant_KB'))")
curl -s -X POST $CP/api/kb/retrieve -H 'content-type: application/json' \
  -d "{\"recordId\":\"$REC\",\"personaId\":\"persona-john\",\"query\":\"immune checkpoint inhibitor liver toxicity trials\",\"topK\":3}"
```

Live check of the cluster itself:

```bash
cd ~/AI_Control/Agents_Express/control-plane
set -a; . ~/.config/agentcontrol/env; set +a
QDRANT_COLLECTION=biomedv2__amazon-titan-embed-text-v2-0__chunk-v1 AWS_REGION=us-east-1 \
  node --import ./tests/register.mjs integration/qdrant_live_check.mjs
```

## Restore (only if something went wrong)

The graph as it was before this load is in
`~/neo4j-backup/aura-backup-2026-10-23.json` (nodes with labels and properties,
relationships by element id).
