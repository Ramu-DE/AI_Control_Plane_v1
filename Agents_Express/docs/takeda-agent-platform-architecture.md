# Takeda Agent Platform — Reference Architecture (For Review)

**Status:** Draft for review · **Owner:** Platform Engineering · **Audience:** Enterprise architects, AI governance, BU platform leads, security/compliance
**Scope:** A multi-tenant (multi-BU/BFBF) SaaS platform that lets business users build AI agents that connect to **Amazon S3, Databricks, and Informatica IDMC** — safely, at scale, in a regulated (GxP/GDPR/PHI) pharma environment.

> This document is analysis and design for review. It does not change any code. The
> `control-plane/` app in this repo is the working blueprint of the control plane
> described here (registry, declarative agents, Cedar policy at a gateway, audit).

---

## 0. Guiding recommendation (the thesis)

Build a **shared, multi-tenant control plane** where:

- **Informatica IDMC** provides **governed discovery, data quality, cataloging, and lineage**,
- **Databricks Unity Catalog + Amazon S3/Lake Formation** serve **governed data**,
- **AWS Bedrock AgentCore** runs **on-behalf-of-user agents**,

and **business users compose agents from an approved catalog of governed tools — never touching credentials** — with **Cedar policy at the gateway as a defense-in-depth perimeter on top of each platform's native governance.**

Division of responsibility in one line:
**IDMC governs and moves the data → Databricks/S3 hold and serve the governed data → AWS AgentCore runs the agents that query it under propagated identity.**

---

## 1. Design principles

1. **Governed self-service.** Freedom within guardrails: business users compose from pre-approved building blocks; they never see a connection string, key, or token.
2. **Native governance stays source of truth.** Unity Catalog governs lakehouse data; Lake Formation / S3 Access Grants govern S3; IDMC governs catalog/quality/lineage. The agent gateway adds a perimeter — it does **not** replace them. Defense in depth.
3. **Identity propagates end-to-end.** The real human identity flows from SSO → control plane → gateway → tool → data platform, so every access is attributable and enforced at the source. Agents act **on-behalf-of** users, never as a shared service principal.
4. **Everything is versioned, reviewed, audited.** Agent configs and policies move through Draft → Review → Published lifecycles — the evidence trail needed for GxP/CSV.
5. **Tenant is first-class.** Every object (tool, agent, policy, model, budget) is scoped to `Takeda → BU → BFBF/team → workspace`.
6. **Least privilege by default; human-in-the-loop for mutations.** Read is broad, write/approve is gated and often requires human confirmation.

---

## 2. SaaS tenancy model

```
Takeda (org)
└── Business Unit (e.g., R&D, Commercial, Manufacturing, Global Functions)
    └── BFBF / Team (business-facing function)
        └── Workspace (a bounded set of agents, tools, policies, budgets)
```

- **Control plane = shared** (one multi-tenant deployment).
- **Data plane = isolated per sensitivity.**

| Isolation model | When to use | Mechanism |
|---|---|---|
| **Silo** | GxP / high-sensitivity BUs (R&D clinical, Manufacturing) | Dedicated AWS account + dedicated Databricks workspace per BU |
| **Pool** | Lower-sensitivity BUs / internal productivity | Shared infra; tenant tag + Cedar + row/column security |
| **Hybrid (recommended default)** | Most of Takeda | Pooled control plane; siloed data planes for regulated BUs |

**Tenant as first-class entity** (the gap to close vs. the current demo app): add `Tenant/BU` and `Connection` objects so every registry record, agent, policy, model route, and budget carries a `tenantId`.

---

## 3. Logical architecture

```
                      ┌─────────────────────────────────────────────┐
  Business users ───► │  CONTROL PLANE  (shared, multi-tenant SaaS)  │
  (Entra ID / Okta)   │  • Agent builder (no/low-code)               │
                      │  • Registry (approved governed tools)        │
                      │  • Policy Library (Cedar) + Model catalog     │
                      │  • Playground • Audit • Tenant/Budget mgmt    │
                      └───────────────┬─────────────────────────────┘
                                      │ publish config (versioned)
                                      ▼
            ┌───────────────── DATA PLANE (per-BU, isolated) ───────────────┐
            │  AWS Bedrock AgentCore Runtime  (agents run on-behalf-of user) │
            │                      │                                         │
            │                      ▼                                         │
            │   AgentCore Gateway (MCP) + Cedar policy (perimeter)           │
            │   + AgentCore Identity (JWT, OBO token vault)                  │
            └───────┬───────────────┬───────────────────┬──────────────────┘
                    │ governed tool │ governed tool     │ governed tool
                    ▼               ▼                   ▼
             ┌────────────┐  ┌────────────────┐  ┌──────────────────┐
             │  Amazon S3 │  │   Databricks   │  │  Informatica     │
             │  + Lake    │  │  Unity Catalog │  │  IDMC            │
             │  Formation │  │  / SQL / Genie │  │  CDGC/CDI/CAI/DQ │
             └────────────┘  └────────────────┘  └──────────────────┘
                    │               │                   │
                    └──────── native governance enforced at source ────────┘
                                      │
                                      ▼
            Audit & lineage: CloudTrail + AgentCore Observability
                           + Unity Catalog audit + IDMC lineage
```

---

## 4. Connecting the three data sources as **governed tools**

Business users never get raw credentials. Each source is wrapped as a **registry tool** fronted by an **AgentCore Gateway (MCP)**, with identity propagated and Cedar at the perimeter.

### 4.1 Amazon S3
- **Wrap:** MCP tool / Lambda target exposing scoped operations over **per-tenant prefixes**; front with **Lake Formation** or **S3 Access Grants** for fine-grained, identity-based access.
- **Identity/gov:** per-tenant IAM role assumed via SigV4; no static keys; LF tag-based access control; access logged in CloudTrail.
- **Use for:** governed object/file access (landed datasets, documents, extracts).

### 4.2 Databricks (the governed query + optional execution layer)
- **Wrap:** expose **Unity Catalog** data via a tool using the **SQL Statement Execution API**, a **Genie / SQL MCP server**, or **Databricks Apps / Model Serving** for richer agents.
- **Identity/gov:** **Unity Catalog is the authorization authority** — propagate end-user identity (OAuth U2M / SCIM-mapped from the IdP) so UC **row filters, column masks, and grants** apply to the agent's queries. UC audit logs capture every access.
- **Use for:** governed lakehouse Q&A, analytics, feature/data retrieval.

### 4.3 Informatica IDMC (the governance + ingestion backbone)
- **Wrap:** expose **CDGC** (catalog, business glossary, lineage) for **discovery**; expose **CDI/CAI** mappings/APIs as tools for governed data movement; apply **IDMC Data Quality + CLAIRE** before data reaches agents.
- **Identity/gov:** IDMC provides lineage, DQ scoring, masking, and the business glossary agents and builders **discover from** — agents discover from the catalog, not from raw buckets.
- **Use for:** trusted discovery, data quality gating, governed pipelines that land data in S3/Databricks.

**Rule of thumb:** IDMC = *what data exists and is it trustworthy*; Unity Catalog / Lake Formation = *who may read which rows/columns*; AgentCore gateway = *which agent/caller may call which tool*.

---

## 4A. Knowledge Bases (vector / retrieval sources for RAG)

Agents ground on governed **Knowledge Bases (KBs)** in addition to tools. A KB is a
**first-class Registry record type** (`type = "Knowledge Base"`) that goes through the
same approval lifecycle, is referenced by agents via `knowledgeRefs` (approved-only,
tier-limited), and is fronted by a **pluggable provider adapter** normalizing retrieval
to `retrieve(query, topK, filters) → {chunks, scores, citations}`.

### Providers (one interface, many back-ends)
| Provider | Connection | Auth | Governance authority |
|---|---|---|---|
| **Amazon Bedrock Knowledge Base** | `knowledgeBaseId`, region | IAM Role (SigV4) | Bedrock KB data-source policies |
| **Databricks Vector Search** | endpoint, index, UC catalog.schema | OAuth / SCIM-mapped | **Unity Catalog** (row/column/masking) |
| **MongoDB Atlas Vector Search** | cluster URI, db, collection, index | API key (Secrets Manager) | index/collection ACLs |
| **OpenSearch** | endpoint, index | IAM / basic | index ACLs |
| **Other vector stores** (Pinecone, pgvector, Weaviate) | endpoint + index | API key | provider ACLs |

### Governance (same model as tools)
- **Registry approval:** KB records are Draft → Pending → Approved; only **approved** KBs
  are attachable to agents.
- **Gateway Cedar (perimeter):** a `queryKnowledgeBase` action — e.g. only
  `seniority_director` may query the "Clinical Trials KB".
- **Source-of-truth at the provider:** Unity Catalog / Bedrock KB / index ACLs enforce
  row/column/identity access under the **propagated end-user identity** (on-behalf-of).
- **Tenant isolation:** pool tenants share a KB catalog with row filters; silo tenants
  get dedicated KBs. Tier gates `maxKnowledgeBases` per agent (basic = 1, pro = 20).

### Retrieval config (per agent reference)
`topK`, `scoreThreshold`, `mode` (semantic / hybrid / keyword), `filters` (metadata, e.g.
`region = EU`), `citations` (on for GxP so answers cite sources), optional rerank.

### Compliance (Takeda)
- **Citations/lineage:** every RAG answer records KB + chunk ids → GxP traceability.
- **PII/PHI:** masking at the source (UC masks / IDMC classification), never in the agent.
- **Residency:** pin KB region per BU (EU/JP/US).
- **Audit:** every KB query is an audited event (who, which KB, query).
- **IDMC tie-in:** KBs are discovered from the IDMC catalog (CDGC) with data-quality /
  classification signals — builders pick governed sources, not raw indexes.

### Phasing
1. Model KB record type + agent `knowledgeRefs` + approved-only + tier limit (**done in the control-plane demo**).
2. First real adapter: **Bedrock Knowledge Base** (`Retrieve` API).
3. Add **Databricks Vector Search** (UC governance).
4. Generalize to MongoDB / OpenSearch / others via the same adapter contract.
5. Wire citations + audit + Cedar `queryKnowledgeBase` policies end to end.

## 5. Identity propagation (the make-or-break)

```
User (Entra ID / Okta SSO, OIDC)
  └─► Control plane authenticates (OIDC)
       └─► AgentCore Gateway validates JWT  ── Cedar perimeter check (Part 3 pattern)
            └─► Tool invoked WITH propagated identity (OBO token / SCIM-mapped principal)
                 └─► Unity Catalog / Lake Formation / IDMC enforce at the data layer
                      └─► Access logged: CloudTrail + UC audit + IDMC lineage
```

Requirements:
- **One IdP of record** (Entra ID or Okta) federated into **AgentCore Identity/Cognito**, **Databricks (SCIM)**, and **IDMC** — same human = same governed principal everywhere.
- **On-behalf-of only.** The LLM/agent never sees or sets `caller.email`/`caller.group`; the gateway injects verified claims (mirrors the workshop's Part 3-2 principle: the agent cannot impersonate another user).
- **Group/seniority claims** (e.g., Entra groups) drive Cedar at the gateway and grants at the data layer.

---

## 6. Governed self-service — who does what ("giving wings")

| Role | Can do | Cannot do |
|---|---|---|
| **Platform team (central)** | Curate registry; approve S3/Databricks/IDMC tools; write baseline Cedar; set model catalog, budgets, tenants | — |
| **BU builder (business power user)** | Compose agents from **approved** tools; choose catalog models; author prompts; publish within BU | Wire unapproved tools; see credentials; cross-BU access |
| **Business consumer** | Use published agents (chat/playground) scoped to their identity + groups | Change config; bypass policy |

"Wings" = a **no/low-code agent builder** over a **curated catalog** — freedom within guardrails. Only **approved** registry records are attachable to an agent (already enforced in the control-plane app).

---

## 7. Regulated-pharma guardrails (Takeda-specific)

- **GxP / CSV:** versioned, reviewed, published agent + policy configs → ready-made validation evidence and change control.
- **PII/PHI:** masking enforced at source (UC column masks, IDMC masking) + **Amazon Bedrock Guardrails** on prompts/outputs; **data residency per BU/region** (EU/JP/US differ).
- **Audit & lineage:** CloudTrail + AgentCore Observability + Unity Catalog audit + IDMC lineage → one story from prompt → row, auditor-readable.
- **Human-in-the-loop:** mutating/high-risk actions (write-backs, approvals) require explicit confirmation (the `approveExpense`/AVP pattern).
- **Cost & throughput isolation per BU:** real per-tenant model budgets and rate limits (not display-only) via an LLM gateway.

---

## 8. Platform responsibilities (opinionated placement)

| Concern | Platform | Why |
|---|---|---|
| Agent orchestration & runtime | **AWS Bedrock AgentCore** | Unifies control plane + runtime; identity/gateway/policy enforcement; model access |
| Governed data + query + lineage (authz authority for lakehouse) | **Databricks Unity Catalog** | Row/column security, masking, grants, audit next to the data |
| Object storage + file-level access | **Amazon S3 + Lake Formation / Access Grants** | Scoped, identity-based object access |
| Catalog, glossary, data quality, ingestion, lineage | **Informatica IDMC (CDGC/CDI/CAI/DQ)** | Trusted discovery + governed movement; the metadata backbone |
| Model governance (spend, routing, rate limits) | **LLM gateway** (AgentCore Gateway over model providers) | Per-BU budget/throughput isolation |

---

## 9. Decisions required before build (review checklist)

1. **Agent execution locus** — AWS Bedrock AgentCore (recommended for orchestration) vs. Databricks-native agents (if value is mostly lakehouse Q&A). *Pivotal; drives the whole data-plane design.*
2. **Isolation per BU** — silo (accounts/workspaces) vs. pool (tags) vs. hybrid (recommended).
3. **IdP of record** — Entra ID vs. Okta; federation path into AWS, Databricks, IDMC.
4. **Data residency** per BU/region.
5. **Build vs. buy the builder UI** — extend this repo's control plane vs. adopt Databricks/Bedrock native builders.
6. **GxP classification** per use case — which agents are validated systems vs. productivity tools.

---

## 10. Phased rollout (suggested)

- **Phase 0 — Foundations:** IdP federation to all three platforms; tenant model; one pilot BU; one read-only Databricks (UC) tool + one S3 tool in the registry.
- **Phase 1 — Governed self-service MVP:** control-plane builder + registry + Cedar gateway + audit for the pilot BU; read-only agents; human-in-loop for any write.
- **Phase 2 — IDMC integration:** CDGC discovery + DQ gating; governed pipelines landing data; lineage wired into audit.
- **Phase 3 — Multi-BU scale:** per-BU budgets/isolation, model governance, residency controls; onboard additional BUs.
- **Phase 4 — Advanced:** write-back agents with strict HITL + AVP-style resource checks; multi-agent orchestration across BUs.

---

## 11. Mapping to the control-plane app in this repo

The `control-plane/` app already demonstrates the control-plane spine; to realize this architecture it needs:

| Needed for Takeda | In app today | Gap to close |
|---|---|---|
| Registry of governed tools | ✅ Registry (MCP/Custom, approval lifecycle) | Add S3 / Databricks / IDMC connection types |
| Declarative agents from approved tools | ✅ Agents (approved-only tools) | Add tenant scoping |
| Cedar perimeter + in-tool authz | ✅ Policy Library / Engines / Stores | Wire to real UC/LF/IDMC enforcement |
| Identity + groups | ✅ Personas / Cognito groups | Federate real IdP; OBO propagation |
| Audit | ✅ Audit trail | Join with CloudTrail / UC audit / IDMC lineage |
| **Tenant / BU** | ❌ | **Add as first-class entity** |
| **Per-BU budgets / residency** | ⚠️ display-only | **Make enforcement real** |

---

*Prepared for review. Please annotate Section 9 decisions and Section 10 phasing, then we can turn the agreed items into an implementation increment on the control-plane app.*
