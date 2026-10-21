# Registering a Qdrant RAG Knowledge Base — field-by-field entry guide

**For:** whoever is filling in the Registry UI (you create it; this doc only tells you what to type)
**Platform:** Agent Management Platform → **Registry** (`/registry`)
**Target:** a governed `Knowledge Base` record backed by a Qdrant Cloud cluster

---

## 0. Read this first — the API key does NOT go in the form

The Registry deliberately has **nowhere to paste a Qdrant API key**. The design stores
**references, never secrets** (`src/lib/types.ts` → `KnowledgeConfig`: *"Qdrant (cluster URL
+ collection; API key is referenced, never stored)"*).

So:

| Value | Where it goes |
|---|---|
| Cluster URL | **Connection** field in the record form |
| Collection name | **Collection** field in the record form |
| **API key** | **AWS Secrets Manager** — the form takes only the secret's ARN |

> **Rotate your key.** It was pasted into a chat transcript, so treat it as compromised:
> create a new key in the Qdrant console, store *that* one in Secrets Manager, and revoke
> the old one.

---

## 1. Values for your cluster

Copy these exactly when prompted below.

| Field | Value |
|---|---|
| Cluster URL | `https://7f069704-f6c8-44ae-a916-62878f7e5c7e.sa-east-1-0.aws.cloud.qdrant.io` |
| Cluster ID | `7f069704-f6c8-44ae-a916-62878f7e5c7e` |
| Region | `sa-east-1` (São Paulo) |
| Collection | *your choice* — e.g. `product_docs` (must already exist in Qdrant) |
| API key | **not entered here** — put it in Secrets Manager (§2) |

### Prerequisite: the collection must exist
The platform does not create collections. Create one in Qdrant first, with a vector size
matching the embedding model you intend to use (e.g. `1024` for Amazon Titan Text
Embeddings V2, `1536` for `text-embedding-3-small`), and load your documents into it.
If the collection is empty, the record still registers — it will simply retrieve nothing.

---

## 2. Store the API key in Secrets Manager (before using the UI)

```bash
aws secretsmanager create-secret \
  --name qdrant/7f069704-f6c8-44ae-a916-62878f7e5c7e \
  --description "Qdrant Cloud API key for the Product Docs KB" \
  --secret-string '{"apiKey":"<YOUR-NEW-ROTATED-KEY>"}' \
  --region sa-east-1
```

Note the returned `ARN` — you will paste it into the record form. It looks like:

```
arn:aws:secretsmanager:sa-east-1:123456789012:secret:qdrant/7f069704-…-6LrQp8
```

If you have not set up Secrets Manager yet, you can still enter a *placeholder* ARN to
complete registration; the record is metadata and nothing reads the secret today (see §6).

---

## 3. Create the registry (container)

**Registry → `Create Registry`**

| Field | Enter |
|---|---|
| **Registry Name** *(required)* | `Takeda_Knowledge_Registry` |
| | ⚠️ Must start with a letter; letters, numbers and underscores only. No spaces or hyphens. |
| **Description** *(optional)* | `Catalog of governed retrieval sources (vector / KB) approved for agent use.` |
| **Auto-approve records** | **OFF** (recommended) |

Leaving auto-approve **off** makes new records start in `Draft` and walk the governance
lifecycle, which is the point of the registry. Turn it **on** only if you want records
approved the moment they are submitted.

Click **Create Registry**, then open it.

---

## 4. Create the Knowledge Base record

Inside your registry, click **Create Record**.

### 4.1 Record source — change this FIRST

| Field | Enter |
|---|---|
| **Record source** | **Define manually** |

> **Gotcha:** the form defaults to *Synchronize from endpoint*, which requires an HTTPS
> endpoint and will block submission with *"Enter an HTTPS endpoint, or switch Record
> source to 'Define manually'"* — even for a Knowledge Base. Switch it before anything
> else. (A KB is always stored as define-manually; there is no live introspection for
> vector stores.)

### 4.2 Record details

| Field | Enter |
|---|---|
| **Type** | **Knowledge Base** |
| **Record Name** | `Qdrant_Product_Docs_KB` |
| | ⚠️ Start with a letter; letters, numbers, underscores only; max 64 chars. |
| **Description** *(optional)* | `Product documentation embedded in Qdrant Cloud (sa-east-1), retrieved for RAG grounding.` |

### 4.3 Knowledge Base configuration
*(these fields appear only once Type = Knowledge Base)*

| Field | Enter |
|---|---|
| **Vector / KB provider** | **Qdrant** |
| **Connection** | `https://7f069704-f6c8-44ae-a916-62878f7e5c7e.sa-east-1-0.aws.cloud.qdrant.io` |
| | Hint shown: *"Qdrant cluster URL (API key is vended by AgentCore Identity, never stored)"* |
| **Collection** | `product_docs` *(your collection name)* |
| **Top K (chunks)** | `5` — raise to `8` for broader recall, lower to `3` for tighter precision |

Three retrieval defaults are applied automatically and are **not** editable in this form:

| Setting | Value | Meaning |
|---|---|---|
| `scoreThreshold` | `0.4` | chunks below this similarity are dropped |
| `mode` | `hybrid` | dense + keyword |
| `citations` | `true` | answers cite source chunks — keep on for GxP traceability |

### 4.4 Authentication

| Field | Enter |
|---|---|
| **Credential type** | **API key** — *"Static key stored in AWS Secrets Manager"* |
| **Secrets Manager reference** | the ARN from §2, e.g. `arn:aws:secretsmanager:sa-east-1:123456789012:secret:qdrant/7f069704-…` |
| | Hint shown: *"The key is read from Secrets Manager at invocation; it is never stored in the record."* |

Do **not** choose *No authorization* — Qdrant Cloud requires a key, and that option is for
genuinely public endpoints only.

### 4.5 Submit

| Button | Use when |
|---|---|
| **Create as draft** | you want to review before requesting approval |
| **Create and submit for approval** | ✅ normal path — creates the record and moves it to `Pending approval` |

---

## 5. Approve it, then attach it to an agent

### 5.1 Approve
Either:
- **Approval Inbox** (`/approvals`) → find `Qdrant_Product_Docs_KB` → **Approve**, or
- the record's own page in the Registry.

Lifecycle: `Draft → Pending approval → Approved` (then `Approved → Deprecated` at end of life).
A record cannot jump straight from `Draft` to `Approved`.

### 5.2 Attach
**Agents** → open or create an agent → **Knowledge Bases** tab → tick the KB.

Only **Approved** records of type `Knowledge Base` are attachable — the API rejects anything
else with *"Only approved Knowledge Base records can be attached."*

Tier limits apply per the owning tenant:

| Tier | Max knowledge bases per agent |
|---|---|
| `basic` | 1 |
| `pro` | 20 |

---

## 6. Retrieval is implemented — how to use it

The Qdrant retriever is **built**. Everything listed below is real code with tests:

| Module | Role |
|---|---|
| `lib/kb/types.ts` | provider-neutral contract (`RetrievalRequest → Passage[]`) + injectable transport |
| `lib/kb/secrets.ts` | credential resolution: env var → Secrets Manager → conventional fallback |
| `lib/kb/embed.ts` | Bedrock embedding (Titan V2 / Cohere), dimension verified |
| `lib/kb/qdrant.ts` | the adapter: `/points/query` with `/points/search` fallback |
| `lib/kb/service.ts` | two-stage Cedar check → embed → retrieve → audit |
| `api/kb/retrieve/route.ts` | `GET` lists queryable KBs · `POST` performs governed retrieval |

### Query it

```bash
curl -X POST http://localhost:3000/proxy/3000/api/kb/retrieve \
  -H 'content-type: application/json' \
  -d '{"recordId":"<record-id>","personaId":"persona-john",
       "query":"contract fees for oncology suppliers","topK":5}'
```

Add `"preview": true` to get the policy decision and the retrieval plan **without** reading
the credential or making any outbound call — useful for demonstrating governance.

`GET /api/kb/retrieve` lists every KB record with `queryable`, `hasAuthReference` and
`recordScopedPolicy` flags so you can see at a glance why one is or isn't usable.

### Authorization

Retrieval is gated by a Cedar action `queryKnowledgeBase` in two stages, the same shape as
the A2A gate:

1. **Perimeter** — `Tool::"kb"`, seeded as `pol-gw-kb-perimeter`.
2. **Record-scoped** — `Tool::"kb:<recordId>"`, evaluated *only* if such a policy exists, and
   then authoritative. This is how you restrict one KB to specific personas:

```cedar
permit(
  principal,
  action == Action::"queryKnowledgeBase",
  resource == Tool::"kb:rec-xxxxxxxx"
) when { principal.role == "director" };
```

Every outcome is audited under category `kb`: `retrieve`, `preview-retrieve`,
`deny-retrieve`, `retrieve-error`.

### Fields the UI form does **not** yet collect

The Create Record form captures provider, connection, collection and Top K. Four further
settings exist on the record and are **only settable via the API** today; sensible defaults
apply if you create the record through the UI:

| Field | UI default if unset | Why you may want to set it |
|---|---|---|
| `auth.apiKeyEnvVar` / `auth.apiKeySecretRef` | falls back to the `QDRANT_API_KEY` env var on the server | per-record credential, or Secrets Manager in production |
| `allowedHosts` | unset → HTTPS + anti-private checks only, **no host pinning** | pin egress to `cloud.qdrant.io` |
| `fieldMapping.textField` | probes `text`, `page_content`, `content`, `chunk`, `body`, `document` | your payload uses a different key |
| `embedding.modelId` / `.dimension` | `amazon.titan-embed-text-v2:0` / `1024` | your collection was built with another model or size |

So the **UI path works** provided `QDRANT_API_KEY` is set in the server's environment and
your collection is 1024-dim Titan V2 with text under one of the probed keys. Otherwise create
the record via the API payload in §8. (Ask and I'll add these four to the form.)

### ⚠️ Your cluster is not reachable yet

I verified this repeatedly: DNS resolves to three IPs, **TCP connects on 443/6333/6334, but
TLS is reset immediately after the Client Hello** (`ECONNRESET`, `errno=104`) — while other
HTTPS hosts work fine from this box. That is the signature of an AWS NLB with no healthy
targets: the cluster is **still provisioning, suspended, or deleted**.

Consequently the retriever is verified in two halves:

- **Embedding: verified live.** Real Bedrock call, `amazon.titan-embed-text-v2:0`, 1024 dims,
  L2 norm 1.0000.
- **Qdrant hop: verified against faithful wire shapes offline** (32 tests covering both
  endpoint shapes, auth failures, 404 fallback, field mapping, filters, dimension pre-flight)
  — but **not yet against your live cluster**.

Check the cluster at <https://cloud.qdrant.io>, then run:

```bash
cd control-plane
QDRANT_URL=https://7f069704-f6c8-44ae-a916-62878f7e5c7e.sa-east-1-0.aws.cloud.qdrant.io \
QDRANT_API_KEY=<your-rotated-key> QDRANT_COLLECTION=product_docs AWS_REGION=us-west-2 \
node --import ./tests/register.mjs integration/qdrant_live_check.mjs
```

It reports four stages independently — reachability, collection shape (vector size vs. the
record's declared dimension), embedding, retrieval — so you immediately see which half is at
fault. It exits non-zero if any stage fails.

### Still missing for a full RAG answer

Retrieval works, but **nothing yet injects passages into an agent's prompt**: `knowledgeRefs`
is stored and displayed but not read at inference time. Grounding an agent answer on these
passages (and emitting citations) is the next increment.

---

## 7. Verification checklist

| Check | Expected |
|---|---|
| Registry appears in `/registry` | ✅ with your name |
| Record type pill | `Knowledge Base` |
| Record status after submit | `Pending approval` → `Approved` once approved |
| Record detail → Connection | your cluster URL, collection `product_docs` |
| Record detail → Credential | `API key` with the Secrets Manager ARN |
| **The API key itself anywhere in the UI or API response** | ❌ must be absent |
| Audit trail (`/audit`, filter `registry`) | `create-record` and `update-status` events |
| Agent → Knowledge Bases tab | KB selectable only after approval |

---

## 8. Appendix — equivalent API payload

For scripting later. The UI sends exactly this to `POST /api/registry`:

```json
{
  "kind": "record",
  "registryId": "<your-registry-id>",
  "name": "Qdrant_Product_Docs_KB",
  "description": "Product documentation embedded in Qdrant Cloud (sa-east-1), retrieved for RAG grounding.",
  "recordSource": "define-manually",
  "type": "Knowledge Base",
  "credentialType": "API key",
  "knowledgeConfig": {
    "provider": "Qdrant",
    "connection": {
      "qdrantUrl": "https://7f069704-f6c8-44ae-a916-62878f7e5c7e.sa-east-1-0.aws.cloud.qdrant.io",
      "qdrantClusterId": "7f069704-f6c8-44ae-a916-62878f7e5c7e",
      "qdrantCollection": "product_docs"
    },
    "retrieval": { "topK": 5, "scoreThreshold": 0.4, "mode": "hybrid", "citations": true },

    "auth": { "apiKeyEnvVar": "QDRANT_API_KEY" },
    "allowedHosts": ["cloud.qdrant.io"],
    "fieldMapping": { "textField": "text", "metadataFields": ["doc", "page"] },
    "embedding": { "modelId": "amazon.titan-embed-text-v2:0", "dimension": 1024 }
  }
}
```

The last four blocks are the retrieval-critical ones the UI does not collect (§6). For
production use `"auth": { "apiKeySecretRef": "arn:aws:secretsmanager:…", "secretJsonKey": "apiKey" }`
instead of an env var.

Then advance it:

```json
PATCH /api/registry   { "id": "<record-id>", "status": "Pending approval" }
PATCH /api/registry   { "id": "<record-id>", "status": "Approved" }
```

Note the payload carries **no credential** — only `credentialType`. That is by design.

> Reminder: with `GRAPH_CONTROL_STORE=local` (and the registry's in-memory store) these
> records do not survive a server restart. Re-run the steps, or move to a persistent store,
> before treating this as durable configuration.
