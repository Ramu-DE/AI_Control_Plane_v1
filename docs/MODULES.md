# AI Control Plane — modules and how they connect

This repository is a governed, multi-tenant **agent control plane** for a
regulated pharma organisation (Takeda BUs and business functions), plus the
**knowledge-graph builder** it relies on, and reference material it was built
from.

| Module | What it is | Language | Guide |
|---|---|---|---|
| `Agents_Express/control-plane` | **The control plane**: UI + HTTP API. Registry, agents, workflows, Cedar policy, tenants, personas, graph sources, knowledge bases, A2A, memory. | TypeScript / Next.js 15 | [`guide/`](../Agents_Express/control-plane/docs/guide/README.md) |
| `graph-utility` | **Ontology-first, dataset-agnostic knowledge-graph builder** (+ legacy OMDA query engine). Builds a graph from an ontology over any dataset; loads it into Neo4j and/or Neptune. | Python | [`MODULE_GUIDE.md`](../graph-utility/MODULE_GUIDE.md) |
| `a2a-demo` | Reference A2A peer agents (Sales ⇄ Supply Chain) on Bedrock with shared memory. Reference only: not imported by the control plane. | Python | [`MODULE_GUIDE.md`](../a2a-demo/MODULE_GUIDE.md) |
| `saas-gaming-app` | SaaS reference app: the source of the tenant-tier / middleware patterns the control plane's tenancy adopted. | TypeScript / Express | [`MODULE_GUIDE.md`](../saas-gaming-app/MODULE_GUIDE.md) |
| `saas-platform-configs` | KRO ResourceGraphDefinitions + ArgoCD ApplicationSets for per-tenant provisioning (reference). | YAML | [`MODULE_GUIDE.md`](../saas-platform-configs/MODULE_GUIDE.md) |
| `saas-workloads` | ArgoCD tenant ApplicationSets, KRO tenant instances, ACK examples, cluster policies (reference). | YAML | [`MODULE_GUIDE.md`](../saas-workloads/MODULE_GUIDE.md) |
| `Agents_Express` (other) | AWS audit script, Python config stub, design docs, workshop screenshots. | Bash / Python / MD | [`OTHER_FILES_GUIDE.md`](../Agents_Express/OTHER_FILES_GUIDE.md) |
| `docs/` | Cross-cutting runbooks and designs (this file, personas, KG flow, Neptune, BioMedical load, A2A runbook). | MD | — |

## The big picture

```
                         ┌──────────────────────── control plane (Next.js) ────────────────────────┐
  people (personas,      │  Settings/Tenants   Registry     Agents    Workflows   Graph Sources  KG  │
  tenant memberships) ──►│      │                │            │          │            │         │   │
                         │      ▼                ▼            ▼          ▼            ▼         ▼   │
                         │  personas.ts ─► evaluator.ts (Cedar: membership → role → policy →     │
                         │  tenancy.ts      gateway/AVP layers; GxP + residency forbids)         │
                         │  approvals.ts (maker-checker)      modelBroker ─► Bedrock / Databricks│
                         │                                    tools: uc_* · graph_query/sparql   │
                         │  kg/spec.ts ─► kg/jobs.ts ──spawn──┐                    │             │
                         └────────────────────────────────────┼────────────────────┼─────────────┘
                                                              ▼                    │
                        graph-utility: ontology + dataset (UC / CSV)               │
                        → propose → measure → auto-approve (profile) → publish     │
                        → materialize + reason + gates → N-Quads                   │
                              │                         │                          │
                              ▼                         ▼                          ▼
                       Neo4j Aura (property graph)   Amazon Neptune (RDF, named graphs)
                              ▲                         ▲
                              └── agents query them via graph_query (Cypher) / graph_sparql
```

## Cross-module flows

1. **Identity and authorization.**
   - **Who:** personas carry tenant memberships and roles (`TKD-<TENANT>-<ROLE>`), a region and GxP training.
   - **Order of checks, on every tenant-scoped request:** membership, then the role minimum, then Cedar policy, including the GxP / data-residency forbids over attributes inherited down the tenant tree.
   - **Approvals:** Registry records, Graph Sources and workflow review gates are maker-checker (a named approver who is not the submitter).
2. **Agents and workflows.**
   - A workflow step bound to an agent is authorized (`runAgent`), grounded in its knowledge bases (Qdrant / Bedrock KB), and run through the **model broker** on Bedrock or Databricks with a governed tool loop.
   - **Tools offered:** only approved and implemented ones, and a tool the step was not offered is refused.
3. **Knowledge graphs.**
   - **Spec:** each Graph Source declares a **build spec**: `native` (data loaded by its own pipeline, e.g. BioMedical), `ontology-first` (graph-utility builds it) or `derived` (legacy).
   - **Build:** the Knowledge Graph page follows the spec. Ontology-first builds run graph-utility as a tracked job into **that source's own** Neo4j database or Neptune graphs.
   - **Query:** agents query sources with `graph_query` (Cypher, read-only) or `graph_sparql` (SELECT/ASK, scoped to the source's named graphs).
4. **Data sources.**
   - Databricks Unity Catalog (SQL warehouse, Model Serving), CSV exports, Neo4j Aura, Amazon Neptune (+ S3 bulk loader), Qdrant, Amazon Bedrock.
   - Credentials are referenced by environment variable name, never stored on records.

## Where to start reading

| If you want to… | Read |
|---|---|
| run everything locally | [`../SETUP.md`](../SETUP.md) |
| understand tenants, personas, approvals, GxP | [`TENANT_PERSONAS.md`](TENANT_PERSONAS.md) |
| understand how a graph is built and explored | [`KNOWLEDGE_GRAPH_FLOW.md`](KNOWLEDGE_GRAPH_FLOW.md), [`../graph-utility/docs/TAKEDA_BU_KG_DESIGN.md`](../graph-utility/docs/TAKEDA_BU_KG_DESIGN.md) |
| register Neptune for agents | [`NEPTUNE_REGISTRY_SETUP.md`](NEPTUNE_REGISTRY_SETUP.md) |
| load the BioMedical dataset | [`BIOMEDICAL_GRAPH_LOAD.md`](BIOMEDICAL_GRAPH_LOAD.md) |
| the control plane, file by file | [`../Agents_Express/control-plane/docs/guide/`](../Agents_Express/control-plane/docs/guide/README.md) |

## What is real and what is a test harness

- **Real:**
  - Bedrock and Databricks model calls and tool loops;
  - Unity Catalog reads;
  - Neo4j and Neptune loads and queries;
  - Qdrant retrieval;
  - every authorization decision described above.
- **Test harness:**
  - personas are declared identities (no Entra ID sign-in yet);
  - "Acting as" in the console stands in for the signed-in user;
  - the Cedar engine is a deterministic evaluator, not AgentCore Policy or Amazon Verified Permissions.
