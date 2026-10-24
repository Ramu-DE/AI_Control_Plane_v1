# Running the AI Control Plane on your laptop

There are three processes. Only the control plane is opened in the browser.

| Process | Repo / branch | Port |
|---|---|---|
| Control plane (UI + API) | `Ramu-DE/AI_Control_Plane_v1` `main` → `Agents_Express/control-plane` | 3000 |
| IDP engine (extraction) | `Ramu-DE/IDP_latest` `phase3/schema-guided` | 3001 |
| RAG Factory (corpora, answers) | `Ramu-DE/rag-ai-factory` `phase3/decision-safe` | 8000 |

## 1. Prerequisites

| What | Notes |
|---|---|
| Node.js 22+, npm | |
| Python 3.11+ | |
| Git | |
| AWS credentials | Set up with `aws configure`, or `AWS_PROFILE`. Region **us-east-1**. **Bedrock model access** is needed for: Claude Haiku 4.5, Claude Sonnet 4.5 / 4.6, Amazon Nova Lite, Titan Text Embeddings v2. |
| Qdrant Cloud cluster | URL + API key, for RAG corpora and Knowledge Bases |
| Databricks (optional) | Host, PAT, SQL warehouse id. Needed for the Delta publish, the supplier master-data check and the Unity Catalog tools |
| Neo4j Aura (optional) | Graph Sources and the Knowledge Graph page |

## 2. Clone

```bash
mkdir ai-control && cd ai-control
git clone https://github.com/Ramu-DE/AI_Control_Plane_v1.git
git clone -b phase3/schema-guided https://github.com/Ramu-DE/IDP_latest.git
git clone -b phase3/decision-safe  https://github.com/Ramu-DE/rag-ai-factory.git
```

## 3. Shared service tokens

These are any random strings. Each sidecar and the control plane must use the same one.

```bash
export IDP_TOKEN=$(openssl rand -hex 32)
export RAG_TOKEN=$(openssl rand -hex 32)
```

## 4. IDP engine (port 3001)

```bash
cd IDP_latest
npm ci
(cd packages/shared && npm run build) && (cd packages/backend && npm run build)
cd packages/backend
SERVICE_TOKEN=$IDP_TOKEN USE_LOCAL_STORAGE=true LOCAL_STORAGE_DIR=$HOME/.idp-storage \
AWS_REGION=us-east-1 PORT=3001 AUTH_PROVIDER=none node dist/index.js
```

Check: `curl localhost:3001/api/health` should return 200. Any other route without the token returns 401.

## 5. RAG Factory (port 8000)

```bash
cd rag-ai-factory
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
SERVICE_TOKEN=$RAG_TOKEN QDRANT_URL=https://<cluster>.cloud.qdrant.io QDRANT_API_KEY=<key> \
AWS_DEFAULT_REGION=us-east-1 python -m uvicorn rag_factory.api.main:app --host 127.0.0.1 --port 8000
```

- Check: `curl localhost:8000/health`.
- Offline tests: `python -m pytest -q tests`. 43 should pass.

## 6. Control plane (port 3000)

Create `Agents_Express/control-plane/.env.local`. It is git-ignored; never commit it.

```bash
AWS_REGION=us-east-1
IDP_URL=http://127.0.0.1:3001
IDP_SERVICE_TOKEN=<same as IDP_TOKEN>
RAG_URL=http://127.0.0.1:8000
RAG_SERVICE_TOKEN=<same as RAG_TOKEN>
QDRANT_URL=https://<cluster>.cloud.qdrant.io
QDRANT_API_KEY=<key>
# optional
DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
DATABRICKS_TOKEN=<pat>
DATABRICKS_WAREHOUSE_ID=<warehouse id>
NEO4J_URI=neo4j+s://<id>.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=<password>
```

Then:

```bash
cd AI_Control_Plane_v1/Agents_Express/control-plane
npm ci
npm test            # about 500 offline tests
npm run build
npm start           # http://localhost:3000
```

- Do **not** set `BASE_PATH` locally. It was only needed behind the workshop's CloudFront `/proxy/3000`.
- State is kept in `.data/control-plane.json` and is created from seed data on the first start.

## 7. First run

1. Open **http://localhost:3000**. In any page, set **Acting as**, e.g. *Priya Raman (analyst, fn-rnd)* or *Daniel Okafor (approver, fn-rnd)*.
2. **Document Intelligence** → upload a PDF → Run extraction → review → Submit.
3. Switch Acting as to a second person → Finalize. You can also do this from the **Approval Inbox**.
4. **RAG Factory** → New corpus → pick finalized documents → Submit.
5. A second person → Approve & build → **Ask**.
6. **Document Intelligence → Quality** shows accuracy and calibration.

## 8. Optional: Databricks reference table for the supplier check

```sql
CREATE SCHEMA IF NOT EXISTS workspace.idp_reference;
CREATE TABLE IF NOT EXISTS workspace.idp_reference.suppliers
  (name STRING, status STRING, country STRING, vendor_id STRING) USING DELTA;
INSERT INTO workspace.idp_reference.suppliers VALUES
  ('ACME Lab Supplies','approved','US','V-1001'),
  ('Globex Reagents','approved','DE','V-1002'),
  ('Initech Labware','suspended','US','V-1003');
```

Finalized documents are published to `workspace.idp_gold.finalized_documents`, which is created automatically.

## 9. Live checks (all three services running)

```bash
cd Agents_Express/control-plane
node integration/smoke_control_plane.mjs --base http://localhost:3000
node integration/calibration_batch_live.mjs --n 6 --base http://localhost:3000
node integration/rag_accuracy_eval.mjs integration/golden/rnd-supplier-qa.json --base http://localhost:3000
```

- The calibration batch generates documents with known values and runs them end to end.
- The golden set refers to corpus `corp-12n58srt` from the workshop. On a fresh install, build your own corpus, then edit `corpusId` and the questions to match it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `IDP engine: not configured / unreachable` | `IDP_URL` / `IDP_SERVICE_TOKEN` not set, or the token differs from the sidecar's `SERVICE_TOKEN` |
| Every method fails with access denied | Bedrock model access is not granted in us-east-1 for that model |
| `textract-claude-haiku` fails on multi-page PDFs | Expected with local storage: Textract sync is single-page. Configure an S3 bucket (`S3_BUCKET`) for async Textract |
| RAG Factory refuses to start: "Qdrant is not configured" | Set `QDRANT_URL` and `QDRANT_API_KEY`. `RAG_FACTORY_ALLOW_MEMORY=1` gives a throwaway in-memory store, for tests only |
| Uploads > 1 MB fail with `Unexpected token '<'` | A reverse proxy body limit, e.g. nginx `client_max_body_size 30m;`. It does not happen when you open localhost directly |
