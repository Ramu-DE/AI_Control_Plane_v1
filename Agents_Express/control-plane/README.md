# AgentExpress Control Plane

> **Module guide (every file explained, flow, connections):** [`docs/modules/control-plane/`](../../docs/modules/control-plane/README.md)

A modern, full-stack **control plane UI** that unifies the two AWS agentic workshops
into one application you can run yourself:

- **AgentExpress** (build & run multi-agent workflows) — the *data plane*.
- **Agentic AI Authorization & Governance** (secure & govern agents as "digital
  employees") — the *control plane*.

It reproduces all five workshop parts plus an audit trail, in your own UI, with a
modern stack. It runs **locally with an in-memory store** (no AWS account or cost),
and is structured so each data source can be swapped for real Amazon Bedrock
AgentCore APIs later.

## Tech stack

- **Next.js 15** (App Router) + **React 19**
- **TypeScript** (strict)
- **Tailwind CSS 3**
- Next.js **Route Handlers** as the control-plane API
- In-memory singleton store + a small deterministic Cedar-style policy evaluator

## What it covers

| Area | Workshop part | Route | What you can do |
|---|---|---|---|
| Dashboard | — | `/` | Overview, counts, recent activity |
| Registry | Part 1 | `/registry` | Catalog MCP servers & Lambda tools; register new entries |
| Agents | Part 2 | `/agents` | Declarative agent builder (model, prompt, tools, compute) |
| Policies | Part 3 | `/policies` | Cedar editor in **two layers**: AgentCore Policy (gateway) + Verified Permissions (in-tool) |
| Playground | Part 4 | `/playground` | Simulate a **persona** invoking a tool; see both layers decide |
| Graph Sources | Extension | `/graph` | Register/govern OMDA datasets; preview Cedar routing; forward configured queries to Databricks Model Serving |
| Model Governance | Part 5 | `/settings` | LLM gateway **routes**, **providers**, rate limits & token budgets |
| Audit | — | `/audit` | Filterable trail of every control-plane action |

## Runtime catalog

Agent configurations select two independent runtime planes. The **agentic
workload** plane runs the agent process and orchestration; the **model inference
and fine-tuning** plane serves or customizes models. `GET /api/runtimes` exposes
the same provider/family catalog used by the Create Agent UI and the Agents API
validates both runtime IDs.

- **AWS agent workloads:** Bedrock AgentCore Runtime, Lambda, ECS, and EKS.
- **AWS model compute:** Bedrock, SageMaker AI, and EKS.
- **Databricks agent workloads:** Agent Runtime on Databricks Apps, custom Apps
  hosting, and Lakeflow Jobs for scheduled/batch agents.
- **Databricks model compute:** grouped managed Model Serving, serverless GPU AI
  Runtime (Standard and AI environments), classic Databricks Runtime ML, and
  data/feature-engineering runtimes (Standard, Photon, and LTS).

Runtime entries deliberately track durable families rather than release numbers
or accelerator SKUs, which can evolve independently of saved agent definitions.

## Run it

Requires Node.js 20+.

```bash
cd control-plane
npm install
npm run dev       # http://localhost:3000
```

Other scripts:

```bash
npm run build     # production build
npm run start     # run the production build
npm run typecheck # tsc --noEmit
```

## Real-AWS execution slice (read-only)

By default the app runs **entirely locally** against the in-memory store. An
optional, **read-only** AWS slice can be enabled to inspect real resources in
your account — it never creates, updates, or deletes anything.

### Enable it

```bash
export AWS_EXECUTION_MODE=aws       # default is "local"
export AWS_REGION=us-east-1         # or AWS_DEFAULT_REGION; no hardcoded fallback
# credentials: provided by the default AWS SDK credential chain only
#   (env / SSO / shared config / instance|ECS|Pod role) — never set in code.
npm run dev
```

Then open **AWS Resources** in the sidebar (`/aws-resources`). Registry, Agents,
and Policies pages also show an **AWS / Local** badge that links there.

### What it does

| Endpoint | AWS API (read-only) | Purpose |
|---|---|---|
| `GET /api/aws/status` | STS `GetCallerIdentity` + light probes | Mode, region, account, per-service probes |
| `GET /api/aws/knowledge-bases` | Bedrock Agent `ListKnowledgeBases` | Live KB discovery |
| `GET /api/aws/agents` | Bedrock Agent `ListAgents` | Live agent discovery |
| `GET /api/aws/policy-stores` | Verified Permissions `ListPolicyStores` | Live policy-store discovery |
| `POST /api/aws/retrieve` | Bedrock Agent Runtime `Retrieve` | KB semantic retrieval (no generation) |
| `POST /api/aws/authorize` | Verified Permissions `IsAuthorized` | Authorization check adapter (minimal, validated ids) |

### Guarantees

- **No credentials** in code, logs, or files — the SDK default credential chain
  is the only source. No access-key env var is read or written by the app.
- **Mode** is `AWS_EXECUTION_MODE=local|aws`, defaulting to `local`. In local
  mode the AWS endpoints return a `412` with a clear message and run no AWS calls.
- **Region** comes only from `AWS_REGION` / `AWS_DEFAULT_REGION`; a missing
  region in `aws` mode yields a clear `REGION_UNSET` configuration error.
- **Read-only**: only `List*` / `Get*` / `Retrieve` / `IsAuthorized` are called.
  No create/update/delete API is used anywhere in this slice.
- **Honest responses**: empty accounts return empty lists; access-denied is
  reported distinctly (`403`, amber in the UI) rather than masked as an error.
- New `@aws-sdk/*` packages are pinned to the exact version of the installed
  `@aws-sdk/client-bedrock-runtime` (`3.1152.0`).

See `.env.example` for all variables. Base-path (`/agent-control`) compatibility
is preserved — set `BASE_PATH` and `NEXT_PUBLIC_BASE_PATH` together.

## Graph control plane (sources, build runs, mappings, approvals)

The **Graph Sources** page (`/graph`) and its API (`/api/graph`,
`/api/graph/mappings`) govern ontology-mediated data access. A GraphSource is
registered, walks the approval lifecycle, and can be queried (policy-checked)
through an OMDA serving endpoint. On top of that, the **build plane**
(`graph-utility`) derives ontology→backend mappings; those arrive here as
**MappingProposals** with confidence, evidence, and validation issues, are
approved/rejected by a reviewer (mandatory reviewer + note). Publication
requires every proposal to be decided, excludes rejected proposals, blocks
approved-invalid proposals, and requires at least one approved-valid proposal
before an immutable **MappingVersion** can be published.

### Store selection (fail-closed)

Persistence is behind the async `GraphControlStore` interface with two
back-ends, selected by `GRAPH_CONTROL_STORE`:

| Value | Store | Notes |
|---|---|---|
| `local` (default) | `LocalGraphControlStore` | In-memory, no AWS, no network — offline + tests. |
| `dynamodb` | `DynamoDbGraphControlStore` | Single-table adapter with conditional writes. |

Misconfiguration **fails closed** — the app never silently falls back to a
different store. No table is created and **no network call is made at module
import**; the DynamoDB client is built lazily on first use.

### DynamoDB deployment prerequisites

Provision these out-of-band (the app does not create them):

- A DynamoDB table named by `GRAPH_CONTROL_TABLE` with:
  - Primary key: `PK` (HASH, String), `SK` (RANGE, String)
  - GSI `GSI1`: `GSI1PK` (HASH), `GSI1SK` (RANGE) — tenant-scoped queries
  - GSI `GSI2`: `GSI2PK` (HASH), `GSI2SK` (RANGE) — status-scoped queries
- `AWS_REGION` or `AWS_DEFAULT_REGION` (no hardcoded fallback).
- Credentials via the SDK default provider chain only.

Single-table key layout:

```
PK = GS#<graphSourceId>   SK = META            -> GraphSource
PK = GS#<graphSourceId>   SK = BR#<buildRunId> -> BuildRun
PK = GS#<graphSourceId>   SK = PR#<proposalId> -> MappingProposal
PK = GS#<graphSourceId>   SK = MV#<version>    -> MappingVersion
GSI1PK = T#<tenantId>     GSI2PK = <Entity>#<status>
```

### Security

- **No credentials are stored** — only connection/secret *references*
  (`SecretRef`, `ConnectionRef` with role ARNs / secret ARNs). Auth is resolved
  at runtime.
- **SSRF defenses**: outbound serving/ontology URLs must be HTTPS and must not
  target private/loopback/link-local/metadata (`169.254.169.254`) hosts. A live
  `queryEngineUrl` additionally requires a non-empty matching `allowedHosts`
  allowlist; placeholders remain available for routing preview only.
- **Optimistic concurrency**: every write is a conditional write on a `rev`
  token; a lost race returns a `409` (`VERSION_CONFLICT`).
- **Honest UI**: the `/graph` build panel does **not** fake live discovery — if
  no build run exists it says so; proposals only appear when the build plane
  records them.
- **Published mapping pinning**: routing preview works before publication, but a
  live graph query returns `MAPPING_NOT_PUBLISHED` until a MappingVersion exists.
  Serving requests carry its id, version, and checksum so the data plane can
  verify the exact approved mapping artifact before planning SQL.

### Cross-track mapping semantics (build plane ↔ control plane)

The `graph-utility` build plane (Python) and this control plane share one
mapping vocabulary so proposals cross the boundary losslessly:

- **Proposal status** — `proposed | approved | rejected` on both sides.
- **Validation severity** — a publish-blocking issue is `"blocking"` here and
  `"error"` in `graph-utility`; **both** are treated as blocking by the publish
  gate, so a build-plane invalid proposal can never slip through.
- **Evidence** — the control plane accepts the build plane's evidence kinds
  (`name-similarity`, `type-compatibility`, `ontology-relationship`,
  `key-metadata`, `profile`) and their `weight` verbatim, alongside its own.
- **Published artifact reference** — a `MappingVersion.artifactRef.checksum`
  (`sha256:…`) is a content-addressed reference to *which* proposals were
  published (ids + version), mirroring `graph-utility`'s
  `PublishedMappingSet.set_fingerprint`. It references the artifact, never the
  data.
- **`universalJoinKey`** — a **legacy** single-join-key seam for the
  `databricks-uc` engine only: required for that backend, optional otherwise,
  and with **no default** (a source never inherits another tenant's join key).
  The precision build/plan path derives joins from discovered keys per
  relationship and does not use it.

## The two-layer authorization model (Part 3 + 4)

Authorization is enforced in two layers, both written in **Cedar**:

1. **Gateway (AgentCore Policy)** — at the MCP perimeter, before a tool is called.
2. **AVP (Verified Permissions)** — inside the tool (e.g. the Expense Lambda), with
   fine-grained resource context such as an expense amount.

The seeded demo proves all paths (verified via the Playground API):

| Persona | Tool | Amount | Result | Why |
|---|---|---|---|---|
| Employee | `expense.query` | — | **ALLOW** | Gateway permit for employees |
| Employee | `expense.approve` | — | **DENY** | Gateway *forbid* self-approval |
| Manager | `expense.approve` | 1000 | **ALLOW** | Gateway permit + AVP budget ok (≤ 5000) |
| Manager | `expense.approve` | 9000 | **DENY** | Gateway permits, but AVP budget denies (> 5000) |

## Project layout

```
control-plane/
  src/
    app/
      page.tsx              # Dashboard
      registry/             # Part 1
      agents/               # Part 2
      policies/             # Part 3
      playground/           # Part 4
      models/               # Part 5
      audit/                # Audit trail
      api/                  # Route handlers (registry, agents, policies, models, playground, audit)
    components/ui.tsx        # Shared UI primitives
    lib/
      types.ts               # Domain types for all 5 parts
      store.ts               # In-memory store + seed data
      evaluator.ts           # Two-layer Cedar-style evaluator
      api.ts                 # Client fetch helpers
```

## Wiring to real AWS AgentCore (later)

The in-memory store is intentionally isolated behind simple functions. To connect to
real infrastructure, replace the reads/writes in `src/lib/store.ts` and
`src/lib/evaluator.ts` with calls to:

- **Registry** → AgentCore Gateway targets / your registry service.
- **Agents** → AgentCore Runtime (agent runtimes).
- **Policies** → AgentCore **Policy** (Cedar at the gateway) + **Amazon Verified Permissions** (in-tool).
- **Model Governance** → the **second AgentCore Gateway** acting as an LLM gateway
  over the OpenAI wire protocol.
- **Audit** → CloudTrail + AgentCore Observability.

The API route contracts (`/api/*`) stay the same, so the UI does not change.

## Notes

- This is a local demonstration. The Cedar evaluator in `evaluator.ts` is a small,
  explainable simulation — **not** a full Cedar engine. Use the real Cedar / AVP
  engines when wiring to AWS.
- No AWS credentials are ever stored by this app. In `local` mode no AWS calls
  are made at all; in `aws` mode the read-only slice uses the AWS SDK default
  credential provider chain (see "Real-AWS execution slice" above).
