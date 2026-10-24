# Control plane — `src/lib` (domain logic)

> **Code:** [`Agents_Express/control-plane/src/lib/`](../../../Agents_Express/control-plane/src/lib) · **All modules:** [`docs/modules/`](../README.md)


`src/lib/` holds all of the control plane's domain logic: authorization, tenancy, registry and approval rules, workflow execution, model invocation, tool execution, graph and knowledge-base access, memory, A2A, and persistence. The API routes in `src/app/api/**/route.ts` are thin wrappers. They parse the request, call into `lib/`, and map typed errors to HTTP statuses. Many `lib/` modules are deliberately **pure** (no store access, no I/O) so `tests/` can exercise them offline, and some are client-safe so forms can apply the same rules as the server (`plane.ts`, `modelAccess.ts`, `workflow/eligibility.ts`). The server-only modules are the ones that compose those pure rules with the store, the network, and audit.

---

## How the pieces fit

### (a) Authorization

```
caller (persona, tenantId, action, tool)
  └─> evaluator.evaluate(req)
        ├─ persona missing or disabled            -> default-deny
        ├─ Layer 0: personas.personaTenantDecision   (membership covers tenant + descendants;
        │           + personas.roleAllows             nearest membership decides the role;
        │                                             ACTION_MIN_ROLE e.g. runAgent >= analyst)
        ├─ persona attrs := personas.effectiveAttributes (principal.tenantRole for THIS tenant)
        ├─ Layer 1 "gateway" policies (AgentCore Policy at the MCP perimeter) must permit
        │     conditions see tenant attrs from tenancy.tenantPolicyAttributes
        │     and tenant-scoped rules match descendants via tenancy.inTenantSubtree
        │     regulatory.ts forbids (GxP training, data residency) are ordinary
        │     Cedar forbid policies seeded into store.policies; forbid wins
        └─ Layer 2 "avp" (Verified Permissions inside the tool), only if an AVP policy targets the tool
```

Your summary was correct. One addition: layer 0 (tenant membership plus the minimum role) runs inside `evaluate()`, before any policy is checked. `evaluator.ts` is a lightweight, Cedar-*style* parser and not a real Cedar engine. Domain gates call `evaluate` twice with the same shape (a perimeter tool, then a resource-scoped tool). These gates are `a2a/logic`, `kb/service`, `workflow/govern`, `memory/logic`, `kg/materialize` and `graph/query`.

### (b) Workflow run (`app/api/workflows/route.ts`)

```
workflow/resolve.resolveStep      step (+ bound agent) -> model, prompt, toolRefs, knowledgeRefs, executor
   uses tools/registry.selectTools, tools/discover.narrowTools, workflow/eligibility, plane.planeMismatch
workflow/govern.authorizeAgentStep  Cedar `runAgent` (perimeter + agent-scoped)
workflow/govern.groundStep          kb/service.retrieve -> kb/embed (Bedrock) + kb/qdrant; citations
modelBroker.invokeStep              catalog check, modelAccess allowlist, plane check, audit
   ├─ bedrock.runStepOnBedrock[WithTools]           (Converse API)
   └─ databricks.runStepOnDatabricks[WithTools]     (Model Serving, OpenAI-compatible)
         tool loop -> tools/registry.executeToolCall
             uc_list_tables / uc_describe_table / uc_query -> tools/uc (Databricks UC REST + SQL Statements)
             kg_derive_ontology                           -> kg/derive
             graph_schema / graph_query / graph_sparql    -> graph/query.queryGraphAsAgent
                   ├─ neo4j backend   -> graph/cypher guard + graph/neo4j.runReadQuery
                   └─ neptune backend -> graph/sparql.planSparql + runSparql
workflow/recover   marks runs interrupted by a restart (at store boot); planResume
```

`a2a/rpc/route.ts` uses the same path for inbound A2A calls: `resolveStep`, then govern, then `invokeStep`. `modelBroker.ts` is the only allowed caller of `bedrock.ts` and `databricks.ts`, and a test enforces this. The workflows route still imports `newStepRun` from `bedrock.ts`. That is a record helper and does not invoke a model.

### (c) Knowledge graph (`app/api/kg/route.ts`)

```
kg/spec.validateKgSpec         per-source build spec on the Graph Source (native | ontology-first)
ontology-first build:
  kg/jobs.startOntologyBuild   spawn(<graph-utility>/.venv/bin/python -I integration/build_graph_live.py ...)
                               into THIS source's Neo4j (env NEO4J_*) or Neptune (NEPTUNE_*); tracked
                               as a BuildRun in the graph control store; one running build per source; timeout
legacy UC-derived path:
  kg/derive (UC metadata -> ontology + proposals) -> kg/materialize (Cedar buildKnowledgeGraph,
                               MERGE-only writes tagged source:"kg-build"; dropBuild)
explore:
  kg/sourceRead   scoped to ONE source (native: spec labels; ontology-first: latest build kg_source=<id>)
  kg/read         legacy reader over all kg-build nodes (not source-scoped); defines KgGraph shape
  kg/layout       deterministic force layout for the canvas (components/GraphCanvas)
```

Correction: `kg/read.ts` is not the scoped reader. Scoping by source happens in `kg/sourceRead.ts`. `kg/read.ts` is the older whole-database `kg-build` view, and it also provides the shared `KgGraph` types.

### (d) Approvals

`approvals.authorizeTransition` implements maker-checker for Registry records and Graph Sources (used by `api/registry` and `api/graph`):

- **Submit:** the submitter must be an analyst or above in the resource's tenant.
- **Decide:** the reviewer must be an approver or above, must not be the submitter, and Cedar `approveRecord` must permit the decision.
- **Tenantless resources:** these are platform-provided, and their decisions belong to the org root (`PLATFORM_TENANT`).

### (e) Persistence

- **`persist.ts`:** provides the mechanism.
  - `loadSnapshot` / `writeSnapshot` handle a JSON file at `CONTROL_PLANE_STORE_PATH`.
  - `trackChanges` wraps state in a deep Proxy that marks it dirty on any write.
  - `createPersister`, `flushOnExit` and `durableSingleton` are also here.
  - It explicitly states that it is *not* a migration system.
- **`store.ts`:** owns the main state.
  - `bootStore()` loads the snapshot, or seeds if there is none.
  - It re-seeds any collection the snapshot is missing.
  - It runs the upgrade steps `personas.upgradePersonas`, `tenancy.upgradeTenantRegulatory` and `regulatory.upgradeRegulatoryPolicies`.
  - It calls `workflow/recover.recoverInterruptedRuns` before change tracking starts.
- **Other durable stores:** `graphStore.ts`, `identity/identityStore.ts` and `graph/localStore.ts` each use `persist.durableSingleton` with their own snapshot suffix.

Correction: the persona, tenant and policy upgrade migrations are invoked from `store.ts`, not from `persist.ts`.

---

## Top-level files

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `store.ts` | In-memory singleton holding all control-plane state. It is seeded, made durable through `persist.ts`, upgraded at boot, and is the central audit log. | `store`, `Store`, `flushStore`, `storeDurability`, `newId`, `logAudit` | persist, personas/tenancy/regulatory upgraders, workflow/recover, runtimes; imported by almost every route and service |
| `persist.ts` | Makes the store survive restarts without rewriting mutation sites: a JSON snapshot plus a change-tracking Proxy. It is single-process only and not transactional. | `loadSnapshot`, `writeSnapshot`, `trackChanges`, `createPersister`, `flushOnExit`, `capLog`, `durableSingleton`, `STORE_PATH_VAR` | store, graphStore, identity/identityStore, graph/localStore; local filesystem |
| `types.ts` | Shared domain types: tenants, registry records, agents, catalog models, policies, personas, audit, workflows and runs, graph source config. | `Tenant`, `RegistryRecord`, `AgentConfig`, `CatalogModel`, `Policy`, `Persona`, `TenantMembership`, `EvaluationRequest/Result`, `Workflow`, `WorkflowRun`, `StepRun`, `AuditEvent`, `INFERENCE_PROVIDERS` | runtimes; used across lib, routes and pages |
| `evaluator.ts` | Deterministic Cedar-style authorizer: tenant membership and minimum role, then the gateway layer, then the AVP layer. This is not a full Cedar engine. | `evaluate` | store (policies, personas, tenants), tenancy, personas; used by every governed gate and by `api/playground`, `graph`, `kg`, `workflows` |
| `personas.ts` | Single answer to "may this persona act in this tenant, and as what role". Memberships cover descendant tenants, and the nearest membership wins. Maps memberships to and from `TKD-<TENANT>-<ROLE>` IdP groups. | `personaTenantDecision`, `ACTION_MIN_ROLE`, `roleAllows`, `effectiveAttributes`, `canAdminister`, `membershipsFromGroups`, `groupFor`, `takedaPersonas`, `upgradePersonas` | tenancy; used by evaluator, approvals, store, `api/personas`, `tenants`, `workflows`, `kg` |
| `regulatory.ts` | Expresses GxP and data-residency controls as seeded Cedar forbid policies, not code paths. They join tenant attributes with persona attributes. | `REGULATED_ACTIONS`, `regulatoryPolicies`, `upgradeRegulatoryPolicies`, `REVIEW_GATE_TOOL/ACTION`, `APPROVALS_TOOL`, `APPROVE_RECORD_ACTION` | store (seed and upgrade), approvals, `api/workflows` (review gate) |
| `tenancy.ts` | Pure tenant-tree helpers and live usage and capacity. Provides the visibility rule (own tenant or an ancestor), audit scoping, and the tenant regulatory attributes that policies see. | `inTenantSubtree`, `tenantChain`, `visibleTenantIds`, `resourceAvailableToTenant`, `tenantPolicyAttributes`, `tenantUsage`, `tenantCapacity`, `filterAuditForTenant`, `tenantsInTreeOrder`, `TAKEDA_REGULATORY`, `upgradeTenantRegulatory` | tiers; used by evaluator, personas, graph/query, store, `api/agents`, `audit`, `tenants` |
| `tiers.ts` | Per-tier (basic/pro) feature and limit configuration and the isolation model, adapted from saas-gaming-app. | `TIER_CONFIGS`, `getTierConfig`, `planLabel`, `nextPlan`, `isolationForTier` | tenancy; `api/agents`, `api/tenants` |
| `approvals.ts` | Maker-checker rules for Registry records and Graph Sources: submit as analyst or above, decide as a different approver or above, with Cedar `approveRecord`. | `authorizeTransition`, `DECISION_STATUSES`, `PLATFORM_TENANT` | evaluator, personas, regulatory, store; `api/registry`, `api/graph` |
| `modelAccess.ts` | Pure, inherited per-tenant model allowlist, so a tenant can invoke only approved models. Client-safe, so pickers can narrow themselves. | `effectiveModelAllowlist`, `authorizeModel`, `modelsForTenant` | plane; modelBroker, `api/tenants` |
| `modelBroker.ts` | The one chokepoint where a model is invoked. Checks the catalog, allowlist and plane, dispatches to Bedrock or Databricks, and audits every invocation. | `invokeStep`, `authorize`, `ModelAccessDenied`, `BrokerContext` | store, modelAccess, plane, bedrock, databricks, tools/registry; `api/workflows`, `api/a2a/rpc` |
| `plane.ts` | One rule for whether an agent's declared model runtime agrees with where its model is really served. Client-safe. | `executorFor`, `isDatabricksRuntime`, `planeMismatch`, `modelsForRuntime` | modelAccess, modelBroker, workflow/resolve; `api/agents`, `api/catalog` |
| `bedrock.ts` | Real step execution on Amazon Bedrock through the Converse API. Maps catalog models to inference profiles, runs the tool-use loop, and records tokens, latency and cost. | `runStepOnBedrock`, `runStepOnBedrockWithTools`, `toConverseTools`, `toInferenceProfileId`, `newStepRun`, `UnroutableModelError` | Bedrock Runtime SDK, store, tools/registry; called only by modelBroker (`newStepRun` is also used by `api/workflows`) |
| `databricks.ts` | Real step execution on Databricks Model Serving (OpenAI-compatible `/invocations`) with a tool loop. Host and token come from the environment by reference. | `runStepOnDatabricks`, `runStepOnDatabricksWithTools`, `resolveHost`, `resolveToken`, `endpointNameFor`, `MAX_TOOL_ITERATIONS` | Databricks Model Serving, graph/logic (SSRF), store, tools/registry; called only by modelBroker |
| `runtimes.ts` | Catalog of agent-runtime and model-runtime options on the two compute planes, plus default and normalization helpers for `AgentCompute`. | `RUNTIME_OPTIONS`, `defaultAgentCompute`, `normalizeAgentCompute`, `runtimeOptionsForPlane`, `groupRuntimeOptions`, `DEFAULT_*_RUNTIME_ID` | types, store; `api/agents`, `api/runtimes`, agents page |
| `ratelimits.ts` | Evaluates LLM-gateway rate limits for a request. Every limit must pass, and the most specific entry wins. | `evaluateRateLimits`, `RateContext`, `RateLimitResult` | store; `api/playground` |
| `graphStore.ts` | Durable seed list of legacy `GraphSourceRecord`s (Contract IQ). No current imports in `src`. | `graphSources`, `flushGraphSources` | persist, types |
| `api.ts` | Client-side typed fetch helpers. Apply the base path and report failures centrally, so unhandled write errors surface in the UI. | `getJSON`, `sendJSON`, `deleteJSON`, `withBase`, `onApiFailure`, `ApiFailure` | Client pages and components (not used server-side) |

## `workflow/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `resolve.ts` | Pure join of a workflow step with its bound agent. The step inherits the model, prompt, tools and knowledge, and the agent's runtime picks the executor. Fails closed with typed errors. | `resolveStep`, `composePrompt`, `hasAgentBoundStep`, `StepResolutionError`, `ResolvedStep` | tools/registry, tools/discover, eligibility, plane; `api/workflows`, `api/a2a/rpc` |
| `govern.ts` | Cedar `runAgent` check for agent-bound steps (perimeter, then agent-scoped) and RAG grounding from `knowledgeRefs`, with citations. A grounding failure is noted but does not fail the step. | `authorizeAgentStep`, `groundStep`, `StepDeniedError`, `RUN_AGENT_ACTION`, `WORKFLOW_PERIMETER_TOOL` | evaluator, store, kb/service; `api/workflows`, `api/a2a/rpc` |
| `eligibility.ts` | One client- and server-safe rule for which agents a workflow may bind: agents owned by its tenant or an ancestor. | `agentEligibleForWorkflow`, `isAncestorTenant`, `explainNoEligibleAgents` | resolve; workflows page |
| `recover.ts` | Pure handling of runs left "running" by a restart. They are marked for a human decision and never auto-resumed. | `recoverInterruptedRuns`, `needsRecovery`, `planResume` | store (boot), `api/workflows` |

## `tools/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `registry.ts` | Governance gate for tool execution. A tool is offered only if the platform implements it AND an approved registry record attached to the agent exposes it. | `TOOL_IMPLEMENTATIONS` (uc_list_tables, uc_describe_table, uc_query, kg_derive_ontology, graph_schema, graph_sparql, graph_query), `selectTools`, `toOpenAiTools`, `executeToolCall`, `isImplemented`, `ToolContext` | tools/uc, kg/derive, graph/query; used by bedrock, databricks, modelBroker, workflow/resolve |
| `discover.ts` | Lexical relevance narrowing of the approved tool set before the model sees it. It can only remove tools, never add them. | `narrowTools`, `relevanceScore`, `DEFAULT_MAX_TOOLS` | registry; workflow/resolve |
| `uc.ts` | Real read-only Unity Catalog tools: list tables, describe a table, and SQL limited to read statements, with scope allowlist and row and byte caps. | `ucListTables`, `ucDescribeTable`, `ucQuery`, `isReadOnlySql`, `checkSqlScope`, `allowedScopes`, `UC_SCOPES_VAR`, `UcToolError` | Databricks UC REST and SQL Statements API (`DATABRICKS_HOST/TOKEN/WAREHOUSE_ID`), graph/logic (SSRF); registry, kg/materialize, `api/kg` |

## `graph/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `entities.ts` | Graph control-plane entities for the governance lifecycle in front of graph-utility. Covers GraphSource, its backends (Databricks UC, Neo4j, Neptune), BuildRun, MappingProposal and MappingVersion. Stores only secret references. | `GraphSource`, `Neo4jBackend`, `NeptuneBackend`, `DatabricksUcBackend`, `BuildRun`, `MappingProposal`, `MappingVersion`, `KgSpec`, `SecretRef`, error classes | Used by all graph/ and kg/ modules, `api/graph`, `api/kg` |
| `logic.ts` | Pure shared rules: the source state machine, the publish gate, proposal normalization from graph-utility snake_case, and the outbound-URL SSRF policy that other egress modules reuse. | `GRAPH_TRANSITIONS`, `canTransition`, `evaluatePublishGate`, `normalizeProposal`, `validateDecisionInput`, `validateOutboundUrl`, `isConfiguredServingUrl` | Both stores, service; reused by a2a, kb/qdrant, databricks, tools/uc; `api/graph` |
| `store.ts` | Async persistence interface for the graph control plane, selected at runtime. | `GraphControlStore`, list-query types, `ApprovalMeta` | localStore, dynamoStore, factory |
| `factory.ts` | Fail-closed store selection via `GRAPH_CONTROL_STORE=local\|dynamodb`. Dynamo requires a table name and region. | `getGraphControlStore`, `resolveStoreKind`, `GraphControlConfigError` | localStore, dynamoStore; service, `api/graph`, `api/graph/mappings` |
| `localStore.ts` | In-memory, durable implementation with the same `rev` concurrency and transition guards as Dynamo. | `LocalGraphControlStore`, `flushGraphControl` | persist, logic |
| `dynamoStore.ts` | Single-table DynamoDB adapter with GSIs and conditional writes. The client is created lazily, and the table is never created. | `DynamoDbGraphControlStore`, `DYNAMO_KEY_SCHEMA` | Amazon DynamoDB, logic |
| `service.ts` | Server-side orchestration over the store: registration validation, transitions, build runs, proposals and decisions, publish, backend and kgSpec updates, and lazy seeding. | `controlStore`, `registerGraphSource`, `transitionSource`, `startBuildRun`, `addProposals`, `decideProposals`, `publishMappingVersion`, `updateGraphSourceBackend`, `setGraphSourceKgSpec` | factory, store; graph/query, kg/jobs, `api/graph`, `api/graph/mappings`, `api/kg` |
| `cypher.ts` | Pure read-only Cypher guard, plus a deterministic exploration query when no Cypher is supplied. Defence in depth behind Neo4j READ sessions. | `isReadOnlyCypher`, `buildCypher`, `UnsafeCypherError` | graph/query, `api/graph` |
| `neo4j.ts` | Bolt execution against Neo4j/Aura in an explicit READ transaction with row cap and timeout. Validates the URI host against SSRF rules and resolves the password from a reference. | `runReadQuery`, `verifyNeo4j`, `validateBoltUri`, `isConfiguredBoltUri`, `resolveNeo4jPassword` | neo4j-driver, Neo4j Aura; graph/query, kg/read, kg/sourceRead, kg/materialize, kg/jobs, `api/graph` |
| `sparql.ts` | Governed SPARQL for Neptune: only SELECT/ASK, no SERVICE, and no caller-chosen datasets. Injects `FROM` for the source's own named graphs and caps rows. | `planSparql`, `maskSparql`, `runSparql`, `neptuneEndpointHost`, `UnsafeSparqlError` | Amazon Neptune SPARQL endpoint (plain HTTPS POST, no SigV4 signing in this module); graph/query, `api/graph` |
| `query.ts` | The single governed path for agent-issued graph queries. Checks tenant visibility, Cedar `queryGraphSource` as the agent, Approved status and read guards, then dispatches to Neo4j or Neptune and audits the outcome. | `queryGraphAsAgent`, `GraphQueryError`, `MAX_TOOL_ROWS`, `GraphCaller` | evaluator, store, tenancy, service, cypher, neo4j, sparql, logic; tools/registry (graph_* tools) |

## `kg/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `spec.ts` | Per-source build spec that answers where this source's graph comes from. Validates `native` mode (Neo4j labels) and `ontology-first` mode (a graph-utility ontology path, namespace, approval profile, UC or CSV dataset). | `validateKgSpec`, `describeKgSpec` | graph/entities; `api/kg` (set via graph/service) |
| `jobs.ts` | Runs graph-utility's ontology-first build for one source as a tracked background job. Spawns `integration/build_graph_live.py` with an argument list into the source's own Neo4j or Neptune. Allows one build per source and enforces a timeout. | `startOntologyBuild`, `buildCommand`, `parseBuildOutput`, `jobLog`, `graphUtilityDir`, `KgJobError` | graph-utility (Python, `GRAPH_UTILITY_DIR`), graph/service (BuildRun), graph/neo4j, store; `api/kg` |
| `derive.ts` | Pure derivation of an ontology and mapping proposals from live Unity Catalog table metadata. Mirrors graph-utility's `propose_mappings` and caps confidence below auto-approve. | `deriveOntology`, `deriveProposals`, `candidateForeignKey`, `parseColumns`, confidence constants | graph/entities; kg/materialize, tools/registry (`kg_derive_ontology`), `api/kg` |
| `materialize.ts` | Legacy UC-derived write path to Neo4j, and the platform's only one. Gated by Cedar `buildKnowledgeGraph`. Materializes only approved and published mappings, using parameterized MERGE writes tagged `source:"kg-build"`. | `materializeKnowledgeGraph`, `authorizeBuild`, `dropBuild`, `KG_BUILD_ACTION`, `KG_PERIMETER_TOOL` | neo4j-driver (WRITE session), evaluator, store, graph/neo4j, tools/uc, derive; `api/kg` |
| `read.ts` | Reads the materialized `kg-build` graph for visualization, reporting true totals, degrees and truncation. Not scoped to a source. Defines the shared `KgGraph` shape. | `readKnowledgeGraph`, `readNeighborhood`, `KgGraph`, `KgNode`, `KgEdge`, `MAX_DEPTH` | graph/neo4j (`runReadQuery`); sourceRead, `api/kg`, kg page, GraphCanvas |
| `sourceRead.ts` | Source-scoped explore: native sources by spec labels, ontology-first sources by the latest build stamped `kg_source=<id>`. Same honesty guarantees as `read.ts`. | `readSourceGraph`, `readSourceNeighborhood`, `latestBuild`, `SourceScope` | graph/neo4j, read; `api/kg` |
| `layout.ts` | Dependency-free, seeded Fruchterman–Reingold layout, so the graph canvas renders the same picture every time. | `forceLayout`, `ringFor` | components/GraphCanvas |

## `kb/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `types.ts` | Provider-neutral retrieval contract (`retrieve(query, topK, filters)` returning passages and citations), modelled on graph-utility's Retriever seam. | `KbRetriever`, `Passage`, `RetrievalRequest`, `RetrievalResult`, `fetchTransport`, `Kb*Error` | service, qdrant, embed, secrets; `api/kb/retrieve` |
| `service.ts` | The only composed governed RAG retrieval. Checks the record is approved, runs the Cedar two-stage check, returns previews before any credential is read, then resolves the credential, embeds, retrieves and audits. | `retrieve`, `authorizeRetrieval`, `resolveKbRecord`, `KB_ACTION`, `KB_PERIMETER_TOOL` | evaluator, store, embed, qdrant, secrets; workflow/govern, `api/kb/retrieve` |
| `embed.ts` | Embeds the query with the same model and dimension as the collection (Titan v2 by default). Fails loudly on unknown model families. | `embedQuery`, `DEFAULT_EMBED_MODEL`, `DEFAULT_EMBED_DIMENSION` | Bedrock Runtime; service |
| `qdrant.ts` | Qdrant Cloud REST retriever. Uses `/points/query` and falls back to `/points/search`, maps fields from the descriptor, and is SSRF-checked. | `QdrantRetriever`, `buildFilter`, `normalizePoint`, `resolveTextField`, `extractPoints` | Qdrant, graph/logic; service |
| `secrets.ts` | Resolves KB credentials server-side from references, checking a per-record env var first, then Secrets Manager, then `<PROVIDER>_API_KEY`. | `resolveApiKey`, `readSecret` | AWS Secrets Manager (lazy client); service |

## `memory/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `types.ts` | The governed memory binding shape (approved record, tenant, Cedar, audit), not the AWS shape. | `MemoryConfig`, `MemoryAuthorization`, `MemoryRetrieval`, `MemoryWriteResult`, `Memory*Error` | namespace; logic, service, `api/memory` |
| `namespace.ts` | Tenant isolation through namespace design. The tenant is encoded in the actor id (`<tenant>__<persona>`) because templates allow only `{actorId}`/`{sessionId}`. | `actorKey`, `parseActorKey`, `renderNamespace`, `isWithin`, `tenantOf`, `partitionByScope`, `MEMORY_SCOPES` | logic, service, `api/memory` |
| `logic.ts` | Pure memory governance: Cedar `useMemory` two-stage check, record config validation, scope narrowing. | `authorizeMemory`, `readMemoryConfig`, `tenantInSubtree`, `MEMORY_ACTION`, `MEMORY_PERIMETER_TOOL` | evaluator, store; service, `api/memory` |
| `client.ts` | Thin AgentCore Memory client (`CreateEvent`, `RetrieveMemoryRecords`) using the server's own role. Makes no policy decisions. | `createEvent`, `retrieveRecords`, `describeAwsError` | `@aws-sdk/client-bedrock-agentcore`; service |
| `service.ts` | The only composed path to agent recall and writes. Narrows scope, derives the namespace itself, checks Cedar, calls AWS, re-checks results for out-of-scope records, and audits with the namespace. | `retrieveMemory`, `recordTurns` | store, client, logic, namespace; `api/memory` |

## `a2a/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `types.ts` | A2A domain types for peers, cards, exchanges and errors. Peers store only a credential reference (`authEnvVar`). Its header still says the platform hosts no A2A server, but `server.ts` now does. | `A2APeer`, `A2AAgentCard`, `A2ASkill`, `A2AExchange`, `A2A*Error` | All a2a modules |
| `card.ts` | Fetches and strictly normalizes a peer's Agent Card at the trust boundary. Tries `agent-card.json` and then `agent.json`. | `fetchCard`, `normalizeCard`, `WELL_KNOWN_PATHS`, `wellKnownUrl` | graph/logic (SSRF); service |
| `client.ts` | Outbound JSON-RPC `message/send`: a pure envelope builder and reply normalizer, plus one fetch. Credentials are resolved from env and never returned. | `buildSendEnvelope`, `normalizeReply`, `sendMessage`, `resolveAuthHeaders`, `rpcTargetFor` | graph/logic; service |
| `logic.ts` | Pure rules plus the two-stage Cedar gate for A2A calls (perimeter, then peer-scoped), peer validation and the lifecycle. | `authorizeCall`, `validateRegisterPeer`, `isPeerCallable`, `canTransition`, `parseAllowedHosts`, `A2A_ACTION` | evaluator, store, graph/logic; service, store, `api/a2a` |
| `service.ts` | Orchestrates governed outbound A2A (discover, send) with policy, SSRF-checked egress, and audit on every outcome. | `discoverPeer`, `sendToPeer` | card, client, logic, a2a/store, store; `api/a2a` |
| `store.ts` | Durable-singleton-style peer store with `rev` optimistic concurrency and guarded transitions. | `listPeers`, `getPeer`, `requirePeer`, `createPeer`, `setPeerCard`, `transitionPeer`, `A2AVersionConflictError` | store, logic, server; service, `api/a2a` |
| `server.ts` | Inbound A2A. Serves the platform's Agent Card and parses `message/send`. Disabled unless `A2A_INBOUND_TOKEN` is set, compares tokens in constant time, runs as a configured service persona, and exposes only `ready` agents. | `authenticateInbound`, `buildAgentCard`, `exposedAgents`, `parseSendRequest`, `resolveTargetAgent`, `success/errorEnvelope`, `auditInbound` | node:crypto, store; `api/a2a/card`, `api/a2a/rpc` (which then uses workflow/resolve, govern, modelBroker) |

## `aws/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `config.ts` | Central AWS config: `AWS_EXECUTION_MODE=local\|aws`, strict region resolution with no fallback, default credential chain, read-only client factories. | `getExecutionMode`, `isAwsMode`, `resolveRegion`, `requireAwsConfig`, `stsClient`, `bedrockAgentClient`, `bedrockAgentRuntimeClient`, `verifiedPermissionsClient` | STS, Bedrock Agent and Agent Runtime, Verified Permissions SDKs; discovery, http, `api/aws/status` |
| `discovery.ts` | Real read-only AWS calls with errors classified honestly: caller identity, list KBs, agents and policy stores, KB retrieve, AVP `isAuthorized`. | `getCallerIdentity`, `listKnowledgeBases`, `listBedrockAgents`, `listPolicyStores`, `retrieveFromKnowledgeBase`, `isAuthorized` | config, normalize; `api/aws/*` |
| `normalize.ts` | Pure mapping of SDK responses to compact UI types, plus AWS error classification. | `normalize*`, `classifyAwsError`, summary types | discovery, http, `api/aws/status` |
| `http.ts` | Shared route helper that maps mode, config and SDK errors to stable JSON without secrets. | `handle`, `configErrorResponse`, `awsErrorResponse` | config, normalize; `api/aws/*` |

## `identity/`

An offline Agent Identity simulation (autonomy levels, inbound and outbound auth, token vault, delegation, interceptors, audit). Simulated tokens are unsigned and marked `SIMULATED`. No `src/app` route imports these modules today. They are exercised by `tests/` (autonomy, vault, delegation, inbound-outbound, invariants).

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `types.ts` | IdP- and framework-neutral types for every identity control. | `SIMULATED`, `AutonomyLevel`, `WorkloadIdentity`, `VaultEntry`, `DelegationChain`, `AgentIdentityProfile`, `IdentityAuditEvent`, ... | All identity modules |
| `autonomy.ts` | Pure L0–L3 autonomy mapping to the acts-as model and required controls, plus profile validation. | `actsAsForLevel`, `requiredControls`, `autonomyMatrix`, `validateProfile` | types |
| `inbound.ts` | Simulated inbound auth: SigV4 principal pattern matching and OIDC claim checks. Signatures and JWKS are never verified. | `simulateSigV4`, `validateOidcJwt`, `validateInbound` | util |
| `outbound.ts` | Plans outbound patterns (IAM, M2M, 3LO, OBO) as simulated claims plus vault issuance inputs. | `planOutbound`, `hasConsent` | types, scopes |
| `scopes.ts` | Scope algebra: subset, excess, minimum-viable and drift detection. | `normalizeScopes`, `isSubset`, `excessScopes`, `minimumScopes`, `detectDrift` | delegation, outbound |
| `delegation.ts` | Delegation chains where scope shrinks at every hop and is capped by the root user. Cross-agent hops require explicit policy. | `authorizeDelegation`, `validateChain`, `effectiveScopes` | scopes, util |
| `interceptors.ts` | Gateway interceptor pipeline in order: FGAC, tool filter, PII masking, token exchange. | `runInterceptors`, `maskPii` | util |
| `vault.ts` | Metadata-only token vault: composite-key isolation, TTL and session binding, one-time refresh with replay revocation. | `issue`, `getActive`, `rotateRefresh`, `revokeByEvent`, `redactEntry`, `keyString` | util |
| `workloadIdentity.ts` | Per-agent workload identity: an opaque client_id plus an ARN-shaped secret reference, rotated and revoked independently. | `createWorkloadIdentity`, `rotateWorkloadIdentity`, `revokeWorkloadIdentity` | types, util |
| `audit.ts` | Append-only identity audit with a SHA-256 hash chain, plus chain verification. | `appendIdentityAudit`, `verifyChain` | util |
| `util.ts` | Local hashing, opaque handles, secret-reference strings, canonical JSON, glob matching. | `sha256`, `opaqueHandle`, `secretReference`, `canonicalJson`, `globMatch` | node:crypto |
| `seed.ts` | Seed scenarios: compliance scanner, dev-productivity agent, email summarizer, and the Expense Assistant profile. | `seedIdentity`, `IdentityState` | workloadIdentity, audit |
| `identityStore.ts` | Durable identity state singleton, kept separate from the main store. | `identityStore`, `flushIdentityStore`, `identityId` | persist, seed |

## `registry/`

| File | What it is for | Key exports | Connects to |
|---|---|---|---|
| `validate.ts` | Pure registry rules: name uniqueness and referential integrity. A Draft record is hard-deleted, but an Approved or referenced record must be deprecated instead. | `assertName`, `assertRegistryNameFree`, `assertRecordNameFree`, `findRecordUsage`, `describeUsage`, `decideRecordDeletion`, `assertRegistryRemovable`, `RegistryValidationError` | `api/registry` |

---

## Cross-module connections

- **graph-utility (Python, sibling repo `../graph-utility` or `GRAPH_UTILITY_DIR`)**
  - `kg/jobs.ts` spawns `<graph-utility>/.venv/bin/python -I integration/build_graph_live.py`. It passes `--ontology`, `--namespace`, `--tenant`, `--approval-profile`, `--graph-source-id`, the UC or CSV dataset, and `--neo4j` or `--neptune`, and supplies the target DB through `NEO4J_*` / `NEPTUNE_*` env vars.
  - The script stamps nodes with `kg_source=<id>`, which `kg/sourceRead.ts` reads.
  - `build_graph_live.py` has its own `--register <control-plane>` option, which POSTs to `/api/graph` to register loaded copies as **Draft** Graph Sources. `kg/jobs.ts` does not pass `--register`.
  - Other modules only mirror graph-utility's shapes and conventions without calling it: `kg/spec.ts` (ontology path under `graph-utility/ontologies/`), `graph/logic.ts` (snake_case proposal normalization), `graph/entities.ts`, `kg/derive.ts` and `kb/types.ts`.
- **Neo4j Aura**
  - `graph/neo4j.ts` handles read-only Bolt sessions. Its callers are `graph/query.ts`, `kg/read.ts`, `kg/sourceRead.ts` and `api/graph`.
  - `kg/materialize.ts` is the only write session.
  - `kg/jobs.ts` passes credentials to the Python build.
- **Amazon Neptune**
  - `graph/sparql.ts` sends governed, named-graph-scoped SPARQL as a plain HTTPS POST to `<endpoint>/sparql`.
  - `kg/jobs.ts` drives the graph-utility bulk load and needs `NEPTUNE_S3_BUCKET` and `NEPTUNE_LOADER_ROLE_ARN`.
  - The legacy `graphStore.ts` seed references a Neptune ontology placeholder.
- **Amazon Bedrock**
  - `bedrock.ts` uses the Converse API for step execution, through `modelBroker.ts`.
  - `kb/embed.ts` generates Titan embeddings.
  - `aws/discovery.ts` reads Bedrock Agents and Knowledge Bases.
  - `memory/client.ts` calls AgentCore Memory (`client-bedrock-agentcore`).
- **Databricks**
  - **Model Serving:** `databricks.ts`, through `modelBroker.ts`.
  - **Unity Catalog REST and SQL Statements API:** `tools/uc.ts`, which serves the agent tools and `kg/materialize.ts`.
  - **UC-backed GraphSource backend type:** defined in `graph/entities.ts`.
  - Host and token are always read from `DATABRICKS_*` env vars.
- **Qdrant**
  - `kb/qdrant.ts`, composed by `kb/service.ts`.
- **AWS Secrets Manager**
  - `kb/secrets.ts` (lazy client) for KB API keys.
  - Elsewhere, `graph/entities.ts` and `identity/*` store only ARN-shaped references.
- **Amazon Verified Permissions and STS**
  - `aws/config.ts` and `aws/discovery.ts` (`listPolicyStores`, `isAuthorized`, `getCallerIdentity`) for the `/api/aws/*` routes.
  - The in-process `evaluator.ts` *simulates* the AVP layer, and its header says to replace it with the real Cedar engine or AVP when wiring to AWS.
- **DynamoDB**
  - `graph/dynamoStore.ts`, selected by `GRAPH_CONTROL_STORE=dynamodb`.
- **SSRF policy reuse**
  - `graph/logic.validateOutboundUrl` is shared by `a2a/card`, `a2a/client`, `kb/qdrant`, `databricks.ts` and `tools/uc`.
  - `graph/neo4j.ts` applies the same denylist to Bolt hosts.
