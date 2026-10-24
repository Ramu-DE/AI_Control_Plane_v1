# Control plane — UI, HTTP API, tests and live scripts

The control plane is a Next.js 15 (App Router, React 19) app. Its shape is:

- **Pages** (`src/app/**/page.tsx`) are client components, apart from the Dashboard, which is a server component that reads `store` directly. They call the HTTP API with `getJSON` / `sendJSON` / `deleteJSON` from `src/lib/api.ts`. That module puts `NEXT_PUBLIC_BASE_PATH` in front of every URL. `next.config.mjs` derives `NEXT_PUBLIC_BASE_PATH` from `BASE_PATH`, so setting `BASE_PATH` on its own is enough to serve the app behind a prefix such as `/proxy/3000`. Every failed call is also passed to `onApiFailure` listeners, and `ApiErrorToast` (mounted once in `layout.tsx`) shows those refusals even on pages that never catch them.
- **Routes** (`src/app/api/**/route.ts`) are thin. They validate input, map typed errors to status codes (400/403/404/409/412) and hand everything else to `src/lib/*`: `store`/`logAudit`, `approvals` (maker-checker), `evaluator` (Cedar), `personas` (tenant membership), `graph/*`, `kg/*`, `kb/*`, `memory/*`, `a2a/*`, `modelBroker`, `workflow/*`, `tenancy`, `tiers` and `aws/*`.
- **Who is acting.** Lifecycle actions name the persona taking them. On Registry, Graph Sources, Knowledge Graph, Settings and Tenants that persona comes from the shared `ActingAsSelect` picker (`src/components/ActingAs.tsx`), which is remembered in `localStorage` under `cp.actingPersonaId`. Workflows has its own persona and reviewer selectors.

## User journeys

### (a) Tool/KB → approval → agent → workflow with a review gate
1. **Registry** (`/registry`): create a registry, then a record (`POST /api/registry {kind:"record"}`) of type MCP (auto-discovered from an HTTPS endpoint, or defined manually from a pasted schema) or Knowledge Base (Bedrock KB / Qdrant connection). Records start as **Draft**, unless the registry has `autoApproval`.
2. Pick an **Acting as** persona and choose *Submit for Approval*. This sends `PATCH /api/registry {status:"Pending approval", personaId}`. `lib/approvals.authorizeTransition` requires a named submitter who is **analyst or higher** in the record's tenant.
3. Switch **Acting as** to a different persona and choose *Approve* or *Reject*. The decider must be **approver or higher**, must pass Cedar, and must not be the submitter (`SELF_REVIEW`, four-eyes rule). Allowed transitions are Draft→Pending, Pending→Approved/Rejected, Approved→Deprecated and Rejected→Draft.
4. **Agents** (`/agents`): create an agent (`POST /api/agents`) with a tenant, a catalog model, `toolRefs` and `knowledgeRefs`. The server accepts only **Approved** records, rejects records owned by a sibling tenant, enforces the tier limits (agents per tenant, tools per agent, KBs and memories per agent), and checks that the model runtime agrees with the model's plane (`planeMismatch`).
5. **Workflows** (`/workflows`): create a workflow (`op:"create"`). Every step is validated with `resolveStep` when the workflow is saved. Start a run with `op:"start"` and a `personaId`. The persona must be a member of the workflow's tenant (`PERSONA_NOT_IN_TENANT`). The run returns at once with status *running*, and the page polls every 2 s.
6. At a review gate the run **pauses**. A reviewer then sends `op:"decision"` (approve / revise / deny) with `reviewerPersonaId`. The reviewer must not be the persona who started the run (`SELF_REVIEW`), and must pass Cedar `approveReviewGate` as approver or admin in the run's tenant, with GxP and residency rules applied (`REVIEWER_NOT_PERMITTED`). Interrupted runs can be resumed with `op:"resume"`, and runs can be restarted from a step with `op:"rerun"`.
   - The **Approval Inbox** (`/approvals`) has its own **Acting as** picker and sends `personaId` on every registry PATCH. A Draft can only be *submitted* there. Approving or rejecting a Draft is refused in the page ("submit it first; a different approver decides"), because doing both in one click would be one person acting as maker and checker.

### (b) Graph Sources: register → approve → query
1. On `/graph`, choose **+ Register Graph Source** (`POST /api/graph {op:"register"}`). Backends are Neo4j (Bolt), Neptune (SPARQL) and Databricks (a serving endpoint plus a mapping). The source starts as Draft (201).
2. With **Acting as** set, choose *Submit*, then switch to a different persona and choose *Approve* (`PATCH /api/graph`). This is the same maker-checker rule as the Registry (`authorizeTransition`).
3. For Databricks sources, mapping proposals are decided and published through `/api/graph/mappings`. A decision needs a reviewer and a note. Publish is allowed only if every included proposal is approved and valid (`PUBLISH_GATE`, 409).
4. Query with `POST /api/graph {op:"query", graphSourceId, personaId, question}`:
   - The source must be **Approved** (403 otherwise), and Cedar `queryGraphSource` must allow it (403 with the decision).
   - **Neo4j:** `buildCypher(question, limit, cypher?)` builds the query, which runs read-only over Bolt. Non-read-only explicit Cypher fails with `UNSAFE_CYPHER`.
   - **Neptune:** `planSparql` builds the query and scopes it to the source's named graphs. If no SPARQL is supplied, a default class-inventory query runs. Unsafe SPARQL fails with `UNSAFE_QUERY`.
   - **Databricks:** live queries need a published mapping (`MAPPING_NOT_PUBLISHED`, 409).
   - `preview:true` stops before the backend call.
   - The UI sends only `question`. The explicit `cypher` / `sparql` fields are API-only.

### (c) Knowledge Graph page: the source's `kgSpec` decides
1. `/kg` lists Approved, Draft and Pending sources (`GET /api/kg`). Each comes with a `specSummary` and the flags `canBuild` and `canExplore`.
2. The source's `kgSpec.mode` decides what the page offers:
   - **native:** explore only. Builds are refused with `NATIVE_SOURCE`.
   - **ontology-first:** can be built on any backend.
   - **derived** (legacy, from Unity Catalog): build is Neo4j only.
   - Explore is Neo4j only in every mode. Neptune sources are pointed to SPARQL on `/graph`.
3. Setting a spec (`op:"set-spec"`) requires an acting persona who is **admin** of the source's tenant.
4. `op:"derive"` previews the ontology and proposals from UC metadata. It is read-only.
5. `op:"build"` is Cedar-checked `buildKnowledgeGraph` (`KG_DENIED`, 403).
   - **ontology-first** starts an async job (`startOntologyBuild`, 202). Under the `gxp-strict` profile the publisher must be approver or admin. The page polls `GET ?runs=1` every 4 s.
   - **derived** materialises into Neo4j synchronously.
6. Explore: `GET /api/kg?graphSourceId&personaId` is authorised as `queryGraphSource` in the source's tenant (membership, viewer minimum, GxP/residency). `op:"neighbors"` expands a node, up to `MAX_DEPTH`. `GraphCanvas` renders the graph.

### (d) Settings personas and the Tenants regulatory card
1. **Settings → Personas**: create a persona (`POST /api/personas`) with name, email, region and GxP training, plus memberships.
   - Memberships can be given explicitly, as a tenant + role shorthand, or parsed from IdP groups named `TKD-<TENANT>-<ROLE>`.
   - Roles are `viewer < analyst < approver < admin`. A membership applies to its tenant and every tenant beneath it.
2. **Edit** a persona (`PATCH`, with `actorPersonaId` set from Acting as). The actor must be **admin** of every tenant in both the old and the new memberships, and may not edit their own access (`SELF_ADMIN`).
3. **Remove** a persona (`DELETE ?id&actorPersonaId`). If the persona is referenced by runs or approvals, it is **disabled** rather than deleted, and disabled personas fail every authorisation.
4. **Tenants** (`/tenants`) → **Regulatory** card: set GxP to true, false or inherit, and data region to US, EU, JP or inherit, through `PATCH /api/tenants {id, gxp, dataRegion, personaId}`. `null` means inherit. The acting persona must be admin of that tenant or of an ancestor. The card shows the effective value and where it comes from.

### (e) Playground: Cedar evaluation
1. `/playground`: pick a tenant, which filters the agents shown. Then pick an agent, a tool, a persona, an amount and optionally a model. This sends `POST /api/playground` with `action:"invokeTool"`.
2. If the model is served by AgentCore Gateway, rate limits are checked **before** Cedar, and a throttled call returns `throttled` (HTTP 429 semantics).
3. Otherwise `evaluate()` runs. The response contains the per-policy decisions, the name of the policy that determined the result and, when `runAgent` is set and the call is allowed, a real agent response. Every evaluation is audited.
4. **`tenantId`**: the route accepts `tenantId` and passes it to `evaluate()`, so membership, role minimums and GxP/residency rules can be simulated. The page does **not** send it: its tenant picker only filters agents. Use the API directly to test tenant-scoped evaluation.

## Pages

| Route | File | What the user does there | API it calls |
|---|---|---|---|
| `/` | `src/app/page.tsx` | Dashboard of counts with links (server component, reads `store` directly) | none |
| `/agents` | `src/app/agents/page.tsx` | Create agents (tenant, model, runtimes, approved tools/KBs, visibility) | `/api/agents`, `/api/catalog`, `/api/registry`, `/api/tenants` |
| `/approvals` | `src/app/approvals/page.tsx` | Approval Inbox for pending registry records and library policies, with an **Acting as** picker. Registry actions are maker-checker governed (see journey a) | `/api/approvals`, `/api/registry` (PATCH), `/api/policy-library` (PATCH `op:"status"`) |
| `/audit` | `src/app/audit/page.tsx` | Browse the audit trail | `/api/audit` |
| `/aws-resources` | `src/app/aws-resources/page.tsx` | Execution mode, STS identity, service probes, live Bedrock KB/agents/AVP discovery, KB Retrieve | `/api/aws/status`, `/api/aws/knowledge-bases`, `/api/aws/agents`, `/api/aws/policy-stores`, `/api/aws/retrieve` |
| `/registry` | `src/app/registry/page.tsx` | Create registries and records (MCP / KB), submit, approve, reject, deprecate, delete, with Acting as | `/api/registry` |
| `/graph` | `src/app/graph/page.tsx` | Register, submit and approve Graph Sources; review and publish mappings; run governed queries | `/api/graph`, `/api/graph/mappings` |
| `/kg` | `src/app/kg/page.tsx` | Set a source's build spec, derive, build, poll runs, explore and expand neighbours | `/api/kg` |
| `/a2a` | `src/app/a2a/page.tsx` | Register A2A peers, discover their Agent Cards, send governed messages, advance peer status | `/api/a2a` |
| `/workflows` | `src/app/workflows/page.tsx` | Build workflows (agent-bound or model-only steps); start, poll, review-gate decide, resume, rerun | `/api/workflows` |
| `/playground` | `src/app/playground/page.tsx` | Simulate persona → agent → tool under Cedar and the gateway rate limits | `/api/playground` |
| `/policies` | `src/app/policies/page.tsx` | Policy Library: create Cedar policies, add versions, change status | `/api/policy-library` |
| `/policy-engines` | `src/app/policy-engines/page.tsx` | Create AgentCore Policy engines; import library policies; attach gateways; sync | `/api/policy-engines` |
| `/policy-stores` | `src/app/policy-stores/page.tsx` | Read-only inspection of the seeded Verified Permissions stores | `/api/policy-stores` |
| `/tenants` | `src/app/tenants/page.tsx` | Tenant tree, live usage and capacity, onboarding a tenant, the Regulatory card | `/api/tenants` |
| `/settings` | `src/app/settings/page.tsx` | Tabs: Models (catalog), Personas (create/edit/remove), Governance | `/api/catalog`, `/api/personas`, `/api/governance` (via `GovernanceTab`) |
| layout | `src/app/layout.tsx`, `globals.css` | Root shell: `Sidebar` + `<main>` + `ApiErrorToast`. The CSS holds Tailwind layers and the shared `.card/.btn/.input/.badge/.nav-*` classes | none |

## API routes

| Endpoint | File | Methods/ops | What it enforces | lib it uses |
|---|---|---|---|---|
| `/api/agents` | `api/agents/route.ts` | GET; POST create; DELETE `?id` | Tenant required; tier limits; catalog model must exist; only Approved records attached; sibling-tenant records refused; runtime/plane agreement. DELETE refused (409) if a workflow step uses the agent | `store`, `tiers`, `tenancy`, `plane`, `runtimes` |
| `/api/registry` | `api/registry/route.ts` | GET; POST `kind:"registry"`/`"record"`; PATCH status; DELETE `?recordId`/`?registryId` | Unique registry names; HTTPS endpoint for synced records; valid tenant; transition table; maker-checker. DELETE refuses referenced records, deprecates Approved ones, never cascades | `approvals`, `store` |
| `/api/approvals` | `api/approvals/route.ts` | GET | Aggregates Draft/Pending records and Draft/In Review library policies | `store` |
| `/api/graph` | `api/graph/route.ts` | GET; POST `op:"register"`/`"query"`; PATCH status | Unique id; Approved-only query; Cedar `queryGraphSource`; read-only Cypher; SPARQL scoped to named graphs; Databricks needs a published mapping; maker-checker on PATCH; 412 on graph-store config error | `graph/service`, `graph/cypher`, `graph/sparql`, `graph/logic`, `evaluator`, `approvals` |
| `/api/graph/mappings` | `api/graph/mappings/route.ts` | GET `?graphSourceId`; POST `startBuild`/`addProposals`/`decide`/`publish` | A decision needs a reviewer and a note; publish requires every included proposal approved and valid (409 `PUBLISH_GATE`) | `graph/service`, `graph/logic` |
| `/api/kg` | `api/kg/route.ts` | GET (list / graph / `runs=1`); POST `set-spec`/`derive`/`build`/`neighbors`/`drop` | set-spec: admin of the tenant; build: Cedar `buildKnowledgeGraph`, plus approver for `gxp-strict`; read: `queryGraphSource` in the tenant; native sources not built | `kg/spec`, `kg/jobs`, `kg/derive`, `kg/read`, `kg/sourceRead`, `evaluator`, `personas` |
| `/api/kb/retrieve` | `api/kb/retrieve/route.ts` | GET; POST `{recordId, personaId, query}` | Cedar check → embed → provider retrieve → audit; credentials never accepted or returned. No page calls it (used by the smoke script) | `kb/service` |
| `/api/memory` | `api/memory/route.ts` | GET; POST `op:"retrieve"`/`"write"` | Approved-only; scope ceiling; namespace; Cedar; tenant subtree. No page calls it | `memory/service`, `memory/namespace` |
| `/api/a2a` | `api/a2a/route.ts` | GET; POST `register`/`discover`/`send`; PATCH status | Valid tenant; outbound calls Cedar-checked and audited in the service | `a2a/service`, `store` |
| `/api/a2a/rpc` | `api/a2a/rpc/route.ts` | POST JSON-RPC `message/send` | Bearer `A2A_INBOUND_TOKEN` (feature off if unset); READY agent only; Cedar `runAgent` as the service persona; model allowlist through the broker; audited | `workflow/govern`, `workflow/resolve`, `modelBroker` |
| `/api/a2a/card` (also `/.well-known/agent-card.json`, `/.well-known/agent.json`) | `api/a2a/card/route.ts` | GET | Public by design; names and descriptions only; `A2A_SELF_BASE_URL` overrides the derived base URL | `a2a/server` |
| `/api/workflows` | `api/workflows/route.ts` | GET; POST `create`/`start`/`decision`/`resume`/`rerun` | Steps resolved when saved; persona must be in the tenant; async run; reviewer named, not the starter, Cedar `approveReviewGate`; model calls only through the broker | `workflow/resolve`, `workflow/recover`, `modelBroker`, `evaluator`, `personas`, `regulatory` |
| `/api/personas` | `api/personas/route.ts` | GET; POST; PATCH; DELETE `?id&actorPersonaId` | Valid tenants, roles and region; `TKD-*` group mapping; the actor must administer every affected tenant; no self-edit; referenced personas disabled, not deleted | `personas`, `store` |
| `/api/tenants` | `api/tenants/route.ts` | GET (usage, capacity, effective allowlist, regulatory); POST; PATCH regulatory; DELETE `?id` | Allowlist ids must be catalog models; GxP/region changes need an admin of the tenant or an ancestor; DELETE refused if the tenant owns anything | `tiers`, `tenancy`, `personas`, `modelAccess` |
| `/api/playground` | `api/playground/route.ts` | GET; POST evaluate | Gateway rate limits before Cedar; Cedar `evaluate` (optional `tenantId`); audited | `evaluator`, `ratelimits` |
| `/api/audit` | `api/audit/route.ts` | GET (`?tenant`, `&platform=1`, `?usage=1`) | Tenant-subtree filter; per-tenant token/cost rollup | `tenancy` |
| `/api/catalog` | `api/catalog/route.ts` | GET; POST; PATCH | Model catalog. `tokenEnvVar` is a reference only. PATCH reports agents whose runtime no longer matches the model's plane | `plane` |
| `/api/models` | `api/models/route.ts` | GET; POST `type` provider/route | LLM-gateway providers and routes. Separate from the catalog; no page calls it | `store` |
| `/api/governance` | `api/governance/route.ts` | GET; POST `add-target`/`add-ratelimit`/`delete-ratelimit` | Unique names | `store` |
| `/api/policies` | `api/policies/route.ts` | GET; POST; PATCH | Runtime gateway/AVP policies; no page calls it | `store` |
| `/api/policy-library` | `api/policy-library/route.ts` | GET; POST; PATCH `op:"version"`/`"status"` | Name required; status transitions validated | `store` |
| `/api/policy-engines` | `api/policy-engines/route.ts` | GET; POST `create`/`import`/`attach`/`sync` | No duplicate imports or attachments | `store` |
| `/api/policy-stores` | `api/policy-stores/route.ts` | GET | Read-only (seeded) | `store` |
| `/api/runtimes` | `api/runtimes/route.ts` | GET | Runtime options grouped by plane, plus defaults | `runtimes` |
| `/api/aws/status` | `api/aws/status/route.ts` | GET | Mode, region (no hardcoded fallback), STS identity, list/describe probes | `aws/*` |
| `/api/aws/{knowledge-bases,agents,policy-stores}` | `api/aws/*/route.ts` | GET | Read-only discovery; errors mapped by `handle` | `aws/discovery`, `aws/http` |
| `/api/aws/retrieve`, `/api/aws/authorize` | `api/aws/*/route.ts` | POST | Read-only Bedrock KB Retrieve / AVP IsAuthorized with validated ids | `aws/discovery` |

## Components

| File | Purpose |
|---|---|
| `src/components/ActingAs.tsx` | `useActingPersona()` (loads `/api/personas` and persists the choice in localStorage) and `ActingAsSelect`, which shows each persona with its `role@tenant` memberships |
| `src/components/GraphCanvas.tsx` | Dependency-free SVG graph with zoom, pan, drag-to-pin and traversal. Seeded deterministic layout (`kg/layout`); nodes with hidden edges are ringed. Used by `/kg` |
| `src/components/GovernanceTab.tsx` | Settings → Governance: inference targets and gateway rate limits through `/api/governance` |
| `src/components/Sidebar.tsx` | Grouped navigation for every page route |
| `src/components/ui.tsx` | Shared primitives: `PageHeader`, `DetailHeader`, `Pill`/`StatusBadge`, `Field`, `RadioCard`, `Modal`, `Toggle`, `SubNav`, `EmptyState` |
| `src/components/ApiErrorToast.tsx` | Global, non-auto-dismissing toast for API failures (subscribes to `onApiFailure`) |
| `src/components/AwsModeBadge.tsx` | Badge showing local or AWS mode from `/api/aws/status`, linking to `/aws-resources`; shows "local" on error |

## Tests

Run with `npm test`. This is `node --test` over `tests/**/*.test.ts`, with `--import ./tests/register.mjs`. All tests are offline.

| File | What it pins (1 sentence) |
|---|---|
| `register.mjs` | Points `CONTROL_PLANE_STORE_PATH` at a fresh temp directory, so tests never read the dev server's `.data`, and registers the resolver hook. |
| `resolver.mjs` | ESM resolve hook that maps extensionless relative imports to `.ts`, and only when resolution fails. |
| `a2a.test.ts` | Outbound A2A: card normalisation, JSON-RPC envelopes, two-stage Cedar with peer-scoped deny, SSRF pinning, lifecycle, credential references only. |
| `a2a-inbound.test.ts` | Inbound A2A fails closed: token (constant-time), strict JSON-RPC, skill routing, ready-only agents, card URL behind proxies. |
| `approvals.test.ts` | Maker-checker on records and Graph Sources: analyst+ submitter, a different approver+ decider who passes Cedar, platform resources decided at the root. |
| `autonomy.test.ts` | Autonomy classification/validation and scope algebra. |
| `cypher.test.ts` | The Cypher write guard rejects writes but allows legitimate read-only Cypher. |
| `delegation-interceptors-audit.test.ts` | Delegation subsetting and confused-deputy denial, interceptors (FGAC/filter/mask/exchange), and the tamper-evident audit hash chain. |
| `graph-control.test.ts` | Graph control store: transitions, optimistic concurrency, publish gate, tenant/status queries, fail-closed config, no DynamoDB in local mode. |
| `graph-tool.test.ts` | Ordered checks for the model-facing `graph_query` / `graph_schema` tools against the seeded tenants and policies. |
| `inbound-outbound.test.ts` | Inbound SigV4/OIDC validation and outbound pattern planning. |
| `invariants.test.ts` | Identity modules import no AWS/Bedrock code, the seed encodes the three PDF scenarios, and vault entries hold no raw secrets. |
| `kb.test.ts` | KB retrieval: Qdrant wire shapes, SSRF, field mapping, filters, dimension preflight, credential references, Cedar, lifecycle gate. |
| `kg-spec.test.ts` | A source's `kgSpec` decides what is built and where; the ontology-first job writes only into the source's own database. |
| `kg.test.ts` | KG derivation (no invented joins, keyless classes blocked, name-only confidence capped), deterministic layout, write gate. |
| `memory.test.ts` | Memory refusals: tenant namespace isolation, approval gate, scope ceiling, cross-tenant boundary. |
| `model-broker.test.ts` | Model calls go only through the broker, plus the tenant model allowlist and the UC scope allowlist; fails if a route imports a provider module. |
| `persist.test.ts` | The durable store's change-tracking Proxy behaves like a plain object, plus the debounced atomic write. |
| `personas.test.ts` | Tenant membership (own subtree, never a sibling or parent), nearest-membership role, IdP group convention, enforcement points. |
| `registry.test.ts` | Registry validation (no duplicates) and referential integrity for removal. |
| `regulatory.test.ts` | GxP and residency forbid policies read tenant and persona attributes, forbid beats permit, inheritance, and the rules bind review gates. |
| `runtimes.test.ts` | Runtime option catalogue, grouping by plane and default agent compute. |
| `sparql.test.ts` | SPARQL is read-only, with no FROM/GRAPH/SERVICE escape and an injected FROM per source graph. |
| `tenancy.test.ts` | Usage and capacity bars appear only for limits the server enforces at tenant scope. |
| `tenant-scope.test.ts` | Tenant boundaries for telemetry (`AuditEvent.tenantId`), authorisation (`EvaluationRequest.tenantId`) and tools (record tenant). |
| `tools.test.ts` | Read-only SQL guard, tool selection gate and call recorder for executable tools. |
| `vault.test.ts` | Token vault (TTL, JIT/session binding, one-time refresh and replay, revocation, key isolation) and workload identity lifecycle. |
| `workflow-agent.test.ts` | Agent-bound steps: inheritance, tenancy, plane agreement, fail-closed resolution. |
| `workflow-recover.test.ts` | Interrupted versus paused runs after a restart, and resume planning that re-runs only the interrupted step. |

## Live integration scripts

| File | What it does | Needs (env/services) |
|---|---|---|
| `integration/smoke_control_plane.mjs` | End-to-end check over HTTP: model → agent → workflow run → approval decision → audit, plus Cedar, Neo4j read, KG derive, A2A, playground and KB. Skips steps whose prerequisites are missing. Checks pages only for HTTP 200 plus a marker string (no browser) | A running app (`--base`, default `http://127.0.0.1:3000/proxy/3000`); optional `SUBMITTER_PERSONA_ID`/`REVIEWER_PERSONA_ID`; Databricks for the real run |
| `integration/provision_databricks.mjs` | Idempotently recreates the Databricks demo path (catalog models, agents, workflow) and runs a workflow on real Model Serving endpoints | `DATABRICKS_HOST`, `DATABRICKS_TOKEN` (the server resolves it by reference), `CONTROL_PLANE_URL`, `DBX_TENANT`, submitter/reviewer persona ids |
| `integration/provision_uc_agent.mjs` | Record → Approved, catalog model, `UC_Catalog_Explorer` agent, bound workflow, then a run in which the model calls `uc_list_tables` | `DATABRICKS_HOST`/`TOKEN`/`WAREHOUSE_ID`, `CONTROL_PLANE_URL`, `UC_CATALOG`, `UC_SCHEMA`, `UC_TENANT`, `UC_PERSONA`, submitter/reviewer ids |
| `integration/provision_neo4j_source.mjs` | Idempotently registers, submits and approves the Neo4j Graph Source; stores only the name of the secret's env var | `NEO4J_URI`/`USERNAME`/`DATABASE`, `NEO4J_SECRET_ENV_VAR`, `CONTROL_PLANE_URL`, `GRAPH_SOURCE_ID`, `GRAPH_SOURCE_BU`, submitter/reviewer ids |
| `integration/seed_supplier_graph.mjs` | MERGE-seeds the demo supplier graph (`source:"agentexpress-demo"`); `--remove` deletes it. The only script that writes to Neo4j | `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE` (live Aura) |
| `integration/neo4j_app_path.mjs` | Seeds a tiny graph, proves the app's `buildCypher` + `runReadQuery` path returns rows, then cleans up | `NEO4J_*`; run with `node --import ./tests/register.mjs` |
| `integration/qdrant_live_check.mjs` | Four-stage check (reachability, collection, Bedrock embedding, retrieval) using the app's adapter | `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`, `AWS_REGION`, optional `KB_EMBED_MODEL`/`KB_EMBED_DIMENSION`; run with the register hook |

## Config files

| File | What it sets |
|---|---|
| `package.json` | Scripts `dev`/`build`/`start`/`lint`/`typecheck`/`test`. Dependencies: Next 15.5, React 19, AWS SDK v3 clients (Bedrock, AgentCore, DynamoDB, Secrets Manager, STS, Verified Permissions), `neo4j-driver` |
| `next.config.mjs` | `reactStrictMode`; `basePath`/`assetPrefix` from `BASE_PATH`; `NEXT_PUBLIC_BASE_PATH` derived from it; rewrites `/.well-known/agent-card.json` and `/.well-known/agent.json` → `/api/a2a/card` |
| `tsconfig.json` | Strict, ES2022, `moduleResolution: bundler`, `allowImportingTsExtensions`, alias `@/*` → `./src/*` |
| `tailwind.config.ts` | Content `./src/**/*.{ts,tsx}`; `brand` palette anchored on Takeda red `#e1242a` |
| `postcss.config.mjs` | `tailwindcss` + `autoprefixer` |
| `Dockerfile` | Two-stage `node:20-alpine` build; `BASE_PATH` build arg (also sets `NEXT_PUBLIC_BASE_PATH`); runner defaults to `AWS_REGION=us-east-1`, exposes 3000, runs `npm run start` |
| `.env.example` | `AWS_EXECUTION_MODE` (local/aws), `AWS_REGION`/`AWS_DEFAULT_REGION` (no fallback), `BASE_PATH`/`NEXT_PUBLIC_BASE_PATH`, `GRAPH_CONTROL_STORE` (local/dynamodb) + `GRAPH_CONTROL_TABLE`, `GRAPH_SERVING_TOKEN`, `DATABRICKS_TOKEN`; no credentials |
