# Phase 2 — AgentControl "Graph Source" Provider (Design)

**Goal:** When a user picks a dataset in the AgentControl panel, the platform
resolves it to the correct **Graph Source** (ontology + dataset + registry +
serving endpoint), applies **Cedar** policy, and routes the natural-language
question to the generic OMDA engine — handling the knowledge graph **with
precision**, for any BU.

**Status:** Implemented in `Agents_Express/control-plane/` with a local routing-preview
mode and live Databricks Model Serving forwarding when an approved source has a
configured endpoint. This document remains the contract and design rationale.

---

## 1. Where it fits

AgentControl is the **control plane + router**. It does NOT run queries. It:

1. stores one **GraphSource descriptor** per selectable dataset,
2. lets a user pick a dataset (Graph Source) in the panel,
3. checks **Cedar** ("may this agent/persona/BU query this graph source?"),
4. **routes** `{graph_source_id, question}` to that source's
   `query_engine_url` (a Databricks Model Serving endpoint),
5. records the call + decision in **Audit**.

```
User picks dataset ──► AgentControl resolves GraphSource ──► Cedar check
                                                               │ allow
                                                               ▼
                         POST query_engine_url {graph_source_id, question}
                                                               │
                                                               ▼
                     Databricks Model Serving (generic OMDA engine)
                                                               │
                                                               ▼
                     grounded answer (SQL + rows [+ passages]) ──► Audit
```

---

## 2. Data model (additive — mirrors existing Registry patterns)

Add a Graph Source as either (a) a new **RecordType** `"Graph Source"` in the
existing Registry, or (b) a dedicated `graphSources` store. Recommended: **new
RecordType** so it inherits the Draft→Approved lifecycle + approval inbox.

Proposed TypeScript type (to add to `src/lib/types.ts`):

```ts
export interface GraphSourceConfig {
  graphSourceId: string;        // "contract-iq"
  bu: string;                   // "market-access"
  displayName: string;
  // Ontology (schema source)
  ontology: {
    type: "neptune";
    sparqlUrl: string;
    graphUri: string;
    namespace: string;
    roleArn?: string;           // referenced, never stored as a secret
    region?: string;
  };
  // Data backend + mapping registry
  backend: {
    type: "databricks-uc";      // seam for future types
    catalog: string;
    schema: string;
    registryTable: string;      // fully-qualified mapping table
    // Legacy single-join-key seam for the databricks-uc engine ONLY. Required
    // for that backend, OPTIONAL otherwise, and has NO default — a source must
    // never inherit another tenant's join key. The precision build/plan path
    // (graph-utility discovery → proposals → publish) derives joins from
    // DISCOVERED keys per relationship and does not use this field.
    universalJoinKey?: string;  // e.g. "contract_key" (this source's own key)
    vectorIndex?: string;
  };
  llmEndpoint: string;
  queryEngineUrl: string;       // Databricks Model Serving invocations URL
  tags?: Record<string, string>;
}
```

This is the **exact 1:1 shape** of the Python `GraphSource` descriptor
(`graph-utility/src/graph_utility/descriptor.py`) — AgentControl stores it and
hands it (or just `graphSourceId`) to the engine. Single source of truth.

---

## 3. API route (additive)

New route `src/app/api/graph/route.ts`:

| Method | Purpose |
|---|---|
| `GET`  | list Graph Sources the caller may see (tenant-scoped) |
| `POST` | register a Graph Source descriptor (Draft) / submit for approval |
| `POST {op:"query"}` | **the router**: `{graphSourceId, question}` → Cedar check → forward to `queryEngineUrl` → return answer + audit |

Routing handler (pseudocode):

```ts
// 1. resolve descriptor
const gs = store.graphSources.find(g => g.graphSourceId === body.graphSourceId);
if (!gs) return 404;
// 2. Cedar: action "queryGraphSource", resource = graphSourceId
const decision = evaluate({ personaId, action: "queryGraphSource",
                            resource: gs.graphSourceId, tool: "omda" });
if (!decision.allowed) return 403 (default-deny);
// 3. forward to the serving endpoint (on-behalf-of the end user)
const resp = await fetch(gs.queryEngineUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${servingToken}`, "content-type": "application/json" },
  body: JSON.stringify({ dataframe_records: [{ graph_source_id: gs.graphSourceId,
                                               question: body.question, limit: 50 }] }),
});
// 4. audit + return
logAudit({ category: "graph", action: "query", actor, detail: `${gs.graphSourceId}: ${body.question}` });
```

Note: the Model Serving contract is the MLflow pyfunc in
`graph-utility/src/graph_utility/serving.py` (accepts `graph_source_id` +
`question`), so the request body above matches it directly.

---

## 4. UI (additive)

- **New page `/graph`** (or a tab under Registry): list Graph Sources with
  status pills; "Register Graph Source" form capturing the descriptor fields
  (ontology + backend + endpoints), reusing the existing Field/RadioCard/Toggle
  primitives.
- **Dataset picker**: a dropdown of **approved** Graph Sources the user's tenant
  may access; selecting one sets the active `graphSourceId` for the query box.
- **Ask box**: free-text question → calls `POST /api/graph {op:"query"}` → shows
  the generated SQL, the rows, and (optionally) supporting passages + the
  concepts that were matched (so "precision" is visible and auditable).
- **Browse ontology** (optional): a read-only view listing classes/properties
  for the selected source (served by the Phase-3 SPARQL templates), so users see
  what the graph knows before asking.

---

## 5. Governance (Cedar) — "with precision" + least privilege

Two layers, consistent with the existing two-layer model:

- **Perimeter (gateway):** a `queryGraphSource` action scoped by
  `graphSourceId` and tenant. Example intents for the NL→Cedar composer:
  - *"Permit agents in BU market-access to queryGraphSource contract-iq."*
  - *"Forbid any persona outside the owning tenant from querying a graph source."*
  - *"Permit only seniority_director to queryGraphSource for sources tagged
    sensitivity=confidential."*
- **Source-of-truth (data layer):** Unity Catalog row/column security +
  on-behalf-of identity propagation enforce precise data access **inside**
  Databricks, under the end user's identity (not a shared principal).

Precision guarantees (how the design delivers "handle the KG with precision"):
1. **Registry is ontology-built** (Phase 3) → mappings faithful to the graph.
2. **`graphSourceId` on every call** → never mixes BUs' ontologies/datasets.
3. **Concept extraction constrained to the registry** → no hallucinated columns.
4. **Cedar** → only authorized agents/BUs reach a given graph.
5. **Join keys from the descriptor** → correct JOINs, correct rows.

---

## 6. Tenant scoping

Each Graph Source carries `bu` + `tags` (region, sensitivity, tier). AgentControl
scopes list/visibility and Cedar by the caller's tenant — pool tenants share a
catalog with row filters; silo tenants get dedicated sources. This is the same
tenant model the control-plane already implements.

---

## 7. Multi-BU onboarding (the payoff)

Add BU-Y tomorrow with **no engine changes**:
1. Build BU-Y's mapping registry from its Neptune ontology (Phase 3 job).
2. Deploy / point a Model Serving endpoint near BU-Y's data.
3. Register one **Graph Source descriptor** in AgentControl (Draft → Approved).
4. Author Cedar for who may query it.
Done — the dataset appears in the panel's picker and is queryable with precision.

---

## 8. Implementation checklist (when you greenlight touching the app)

- [ ] `types.ts`: add `GraphSourceConfig` (+ `"Graph Source"` RecordType).
- [ ] `store.ts`: seed + CRUD for graph sources (in-memory today; DB later).
- [ ] `api/graph/route.ts`: GET/POST + `op:"query"` router with Cedar + audit.
- [ ] `/graph` page: register form, dataset picker, ask box, results view.
- [ ] Cedar policies: `queryGraphSource` perimeter rules in the Policy Library.
- [ ] Wire `queryEngineUrl` + serving auth (env/secret, never hardcoded).

All additive; the running app is untouched until you approve this step.
