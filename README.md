# AWS AI Control Plane — AgentExpress-style Governed Multi-Agent Platform

A working control plane for building and governing AI agents on **Amazon Bedrock AgentCore**,
built by reproducing the 5-part **AgentExpress** workshop and extending it with multi-tenant
SaaS features for a regulated-pharma (Takeda) context.

- **Frontend/Backend:** Next.js 15 (App Router) + React 19 + TypeScript + Tailwind CSS
- **State:** in-memory store (demo) — see "Production notes" for the persistence path
- **Real execution:** multi-agent workflows call **Amazon Bedrock** (Converse API) for real
- **Repo:** `github.com/Ramu-DE/AWS_AI-Control-plane`

> This is a demo/reference implementation. Authorization decisions, lifecycle, tenancy, and
> rate limits are real application logic; **workflow steps call Bedrock for real**. Items that
> are modeled-but-not-wired to live AWS are called out in "What's real vs. simulated".

---

## 1. What this platform does (feature map)

| Area | Route | What it is |
|---|---|---|
| **Dashboard** | `/` | Governance signals (pending approvals, unsynced policies, tenants) |
| **Registry** (Part 1) | `/registry` | AWS Agent Registry model: registries + records (MCP / Agent / Agent skills / Custom / **Knowledge Base**) with a Draft→Pending→Approved lifecycle and per-record authentication |
| **Agents** (Part 2) | `/agents` | Declarative agents (model, prompt, tools, KBs, compute, visibility), tenant-scoped, approved-tools-only |
| **Policy Library** (Part 3-1) | `/policies` | Cedar policies via an NL→Cedar composer, versions + activity, lifecycle |
| **Policy Engines** (Part 3-1) | `/policy-engines` | AgentCore Policy engines: import from library, attach gateway (Enforce/Log only), Sync |
| **Policy Stores** (Part 3-2) | `/policy-stores` | Amazon Verified Permissions: namespace, schema, in-tool Cedar policies |
| **Playground** (Part 4) | `/playground` | End-to-end persona simulation: JWT identity → Gateway (Cedar) → AVP → result, with a **real Bedrock agent response** on allow |
| **Model Governance** (Part 5) | `/settings` → Governance tab | LLM gateway inference targets + gateway-routed models + **rate limits** (per-target / per-caller / hybrid, real 429 enforcement) |
| **Graph Sources** | `/graph` | Governed Neptune + Unity Catalog OMDA sources: Draft→Approved lifecycle, Cedar routing preview, and live Databricks Model Serving forwarding |
| **Workflows** (extension) | `/workflows` | **Real multi-agent workflow execution on Bedrock** with human-in-the-loop review gates (approve / revise / deny / re-run) |
| **Tenants** (extension) | `/tenants` | Hierarchical Takeda org tree (BUs → functions → sub-units) with basic/pro tiers + pool/silo isolation + enforced tier limits |
| **Approval Inbox** (extension) | `/approvals` | Aggregated pending registry records + in-review policies |
| **Settings** | `/settings` | Models catalog, Personas (Cognito-style), Governance |
| **Audit** | `/audit` | Attributable action trail |

The 5 workshop parts map 1:1 to the governance surface; the extensions (Tenants, Knowledge
Bases, real Workflows, Approvals) adapt it to a multi-BU regulated SaaS.

---

## 2. Repository layout

```
.
├── README.md                         ← this file
├── .gitignore                        ← excludes node_modules, .next, .venv, secrets, audit logs
├── Agents_Express/
│   ├── control-plane/                ← the Next.js app (the platform)
│   │   ├── src/app/                   pages + API routes (/api/*)
│   │   ├── src/lib/                   store (in-memory), evaluator (Cedar sim),
│   │   │                              bedrock (real Converse runner), ratelimits, tiers
│   │   ├── src/components/            Sidebar, UI primitives, GovernanceTab
│   │   ├── package.json  next.config.mjs  tailwind.config.ts  tsconfig.json
│   ├── docs/
│   │   ├── takeda-agent-platform-architecture.md   ← target architecture (control/data plane, KBs)
│   │   ├── production-readiness-plan.md             ← P0/P1/P2 to go to production
│   │   └── governance-workshop-log.md               ← workshop + account audit notes
│   ├── images/                        ← workshop UI reference screenshots (Parts 1-5)
│   └── aws-audit/aws-audit.sh         ← read-only AWS inventory script (logs are gitignored)
├── saas-gaming-app/                  ← SaaS reference (tenant tiers, tier middleware) — source of the tenancy patterns
├── saas-platform-configs/            ← KRO ResourceGraphs (tenant provisioning) reference
└── saas-workloads/                   ← ArgoCD ApplicationSets + KRO tenant examples reference
```

---

## 3. Clone and run in a NEW AWS environment

### 3.1 Prerequisites
- **Node.js 20+** and npm (the app is built/tested on Node 20.20, npm 10).
- **AWS credentials** available to the process (instance role, `~/.aws/credentials`, or env vars)
  with **Amazon Bedrock access** in a region where the Claude inference profiles below are enabled.
- Region default is **us-east-1** (override with `AWS_REGION`).

### 3.2 Install & run
```bash
git clone https://github.com/Ramu-DE/AWS_AI-Control-plane.git
cd AWS_AI-Control-plane/Agents_Express/control-plane

npm install            # installs Next 15, React 19, Tailwind, @aws-sdk/client-bedrock-runtime

# Dev
AWS_REGION=us-east-1 npm run dev        # http://localhost:3000

# OR production build + start
AWS_REGION=us-east-1 npm run build
AWS_REGION=us-east-1 npm run start      # http://localhost:3000
```
Open **http://localhost:3000**. No database or extra services are needed — state is in-memory
and reseeds on each process start.

### 3.3 Verify it works
- `npm run typecheck` → no errors
- `npm run build` → compiles all routes
- Open `/workflows` → Start run → it should call Bedrock and pause at the human gate.
  If Bedrock isn't reachable, the step shows an error (see 3.5).

### 3.4 Environment variables
| Var | Default | Purpose |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Region for Bedrock Converse calls |
| `BASE_PATH` | (unset) | Path prefix when served behind a reverse proxy (e.g. `/app`). Build **and** start with the same value. |
| `NEXT_PUBLIC_BASE_PATH` | (unset) | Client-side copy of `BASE_PATH` (so `fetch` calls are prefixed). Set to the same value. |

Direct access (recommended): leave `BASE_PATH` unset.
Behind a proxy on `/app`:
```bash
BASE_PATH=/app NEXT_PUBLIC_BASE_PATH=/app npm run build
BASE_PATH=/app NEXT_PUBLIC_BASE_PATH=/app npm run start
```

### 3.5 AWS / Bedrock setup (required for real workflow execution)
The app invokes Bedrock **Converse** using these **inference profiles** (cross-region `us.`):
- `us.anthropic.claude-haiku-4-5-20251001-v1:0` (default / cheap — playground + fallback)
- `us.anthropic.claude-opus-4-5-20251101-v1:0` (opus-tier mapping)
- `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (sonnet-tier mapping)

To run real executions in a new account:
1. **Enable Bedrock model access** for those Anthropic Claude models in your region
   (Bedrock console → Model access), OR edit the id allowlist in
   `src/lib/bedrock.ts` (`KNOWN_GOOD` + `PROFILES`) to models you have.
2. Give the app's identity (instance role / user) an IAM policy allowing:
   ```json
   { "Effect": "Allow",
     "Action": ["bedrock:InvokeModel", "bedrock:Converse"],
     "Resource": "*" }
   ```
   (scope `Resource` to the specific model/inference-profile ARNs for least privilege).
3. Confirm with the AWS CLI before starting the app:
   ```bash
   aws bedrock-runtime converse --region us-east-1 \
     --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 \
     --messages '[{"role":"user","content":[{"text":"hi"}]}]' \
     --inference-config '{"maxTokens":10}'
   ```
   If that returns text, the Workflows and Playground real-response features will work.

> **Cost note:** real Converse calls incur Bedrock charges (cents for the demo flows).
> If you only want the governance UI without Bedrock, everything except the Workflows
> execution and the Playground "run agent on allow" still works offline.

---

## 4. What's real vs. simulated (be clear before demoing)

**Real:**
- Multi-agent **workflow execution on Bedrock** (real Converse, real tokens, real latency; cost is *estimated*).
- Playground **agent response on allow** (real Bedrock call).
- All **authorization logic** (two-layer Cedar permit/forbid/default-deny), **tenant tier
  enforcement**, **registry lifecycle**, and **rate-limit evaluation** (AND semantics, rate 0 = 429).

**Simulated / modeled (not wired to live AWS):**
- The Cedar engine is a lightweight evaluator in `src/lib/evaluator.ts`, **not** real AgentCore
  Policy / Amazon Verified Permissions.
- The "simulated JWT" in the Playground is display-only (no real Cognito token issuance).
- Registry tool/Lambda/KB calls are **not** executed (tools are catalogued + governed, not invoked).
- LLM-gateway inference targets and rate limits are modeled (429 is produced by the evaluator,
  not a live gateway). `rate: 0` blocks deterministically, matching the workshop demo.
- Persistence is **in-memory** — all created data resets on restart.

See `Agents_Express/docs/production-readiness-plan.md` for the P0/P1/P2 plan to make these real
(DynamoDB/Aurora persistence, Entra/Okta OIDC + AgentCore Identity, real AgentCore Policy + AVP,
tenant isolation enforcement, GxP/GDPR/PHI controls, observability, CDK/Terraform + GitOps).

---

## 5. Seeded demo data (what you'll see on first run)
- **Registry:** `AnyCompany_Registry` with `AWSKnowledgeMCP` (Draft) and `expense_tool`
  (Custom, Approved, 5 tools) + two Knowledge Base records (Bedrock KB approved, Databricks draft).
- **Catalog:** Claude Opus 4.6 + two gateway-routed GPT-OSS models (120B → bedrock-mantle, 20B → fast-tier).
- **Agent:** `Expense Assistant` (tenant `fn-finance`, wired to expense_tool + a KB).
- **Part 3:** personas John (manager) / Mary (director); policies `expense_ic` + `expense_above_manager`
  (Published), engine `anycompany_policy_engine` (gateway attached, Enforce), AVP store
  `anycompany_agent_policy` (namespace `AnyCompany`, approve_director + approve_manager).
- **Part 5:** inference targets `bedrock-mantle` (Connector) + `fast-tier` (Custom).
- **Tenants:** full Takeda org tree (32 nodes) — BUs + global functions, pro→silo / basic→pool.

Create **Jane Doe** (seniority_ic) yourself via Settings → Personas to reproduce the Part 4/5
IC scenarios.

---

## 6. Common tasks
```bash
npm run dev         # local dev server (hot reload)
npm run build       # production build
npm run start       # run the production build
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
```
Reset demo data: restart the process (in-memory store reseeds).

---

## 7. Deploying to AWS (options)
This is a standard Next.js app. For a new environment:
- **Quickest:** run `npm run build && npm run start` on an EC2 instance with a Bedrock-enabled
  instance role; front it with a load balancer / reverse proxy (set `BASE_PATH` if not at root).
- **Containerized:** add a Dockerfile (Node 20 base, `npm ci && npm run build`, `npm run start`),
  run on ECS Fargate / EKS behind an ALB; attach a task role with the Bedrock IAM policy above.
- **Serverless:** deploy via the Next.js standalone output to Lambda + API Gateway (externalize
  state first — see the production-readiness plan).

The `saas-platform-configs/` and `saas-workloads/` folders contain the **KRO + ArgoCD GitOps**
reference for provisioning per-tenant infrastructure if you adopt that pattern.

---

## 8. Security notes
- `.gitignore` excludes `node_modules/`, `.next/`, `.venv/`, `.env*`, `*.pem`, and
  `Agents_Express/aws-audit/logs/` (those audit logs contain a workshop sign-in password — keep out of git).
- The app never stores credentials: per-record auth config (OAuth secret, API key ref, role ARN)
  is captured in the form for fidelity but **not persisted**; only `credentialType` is stored.
- No secrets are hardcoded. Provide AWS credentials via the environment / instance role.
