# Agents_Express (outside control-plane) — module guide

## What it is for and why it is in this repository

`Agents_Express/` holds the AgentControl control plane (`control-plane/`, a Next.js app,
not covered here) together with a set of **supporting files** from reproducing the
AgentExpress / Agentic Governance workshop. This guide covers those supporting files:

- **`aws-audit/`**: a read-only AWS inventory script. It was used to verify what the
  workshop sandbox had deployed. `docs/governance-workshop-log.md` is built on its output.
- **`src/agentexpress/` + `requirements*.txt`**: the start of a **Python Strands /
  Bedrock AgentCore** multi-agent package. So far it contains only a package docstring
  and a settings module. No agents are implemented, and nothing in the repo imports
  `agentexpress.config`. It is separate from the control plane.
- **`.env.example`**: an environment template. Its header says it is "read by
  `src/agentexpress/config.py`" (which uses `AWS_REGION`, `AGENTEXPRESS_MODEL_ID` and
  `AGENTEXPRESS_TEMPERATURE`). The rest of the file holds Neptune/Databricks/graph
  placeholders. Of those, only some names are read by the control plane:
  `DATABRICKS_HOST`, `DATABRICKS_TOKEN` and `GRAPH_SERVING_TOKEN` (the latter in
  `control-plane/src/app/api/graph/route.ts`). The control plane uses `NEPTUNE_PORT` but
  reads `NEPTUNE_ENDPOINT`, not `NEPTUNE_CLUSTER_ENDPOINT`. A repo grep finds no reader
  for names such as `NEPTUNE_SPARQL_URL`, `NEPTUNE_IAM_ROLE_ARN`,
  `DATABRICKS_ALLOWED_*` / `DATABRICKS_ENFORCE_RESOURCE_ALLOWLIST`,
  `DATABRICKS_REGISTRY_TABLE` or `DATABRICKS_VECTOR_INDEX`. Note that the control plane's
  UC bound is `DATABRICKS_UC_ALLOWED_SCOPES`, which is not in this file.
- **`docs/`**: design, plan and test-report documents about the control plane. They cover
  the workshop log, the Takeda reference architecture, the production-readiness plan,
  Qdrant KB registration and runtime execution testing.
- **`images/`**: workshop UI reference screenshots for Parts 1–5 (root `README.md`).

## Flow

- **Audit path:**
  1. Export AWS credentials and run `aws-audit.sh`.
  2. Each `run "<desc>" <aws args>` call logs a header plus the command and a UTC
     timestamp, then tees the `aws ... --region $REGION` output into
     `aws-audit/logs/audit-<UTC stamp>.log`. The calls are `describe` / `list` / `get`
     only.
  3. The findings are written up in `docs/governance-workshop-log.md`.
  4. The `logs/` folder is gitignored because the logs contained a workshop sign-in
     password (root README §8).
- **Python package path (intended, not built):**
  1. `config.py` loads `Agents_Express/.env`, but only for keys not already set in the
     environment.
  2. It exposes a frozen `Settings` (region, model_id, temperature).
  3. The `__init__.py` docstring describes the intended design: a supervisor that
     delegates to Researcher/Writer/Reviewer specialists ("agents as tools", Strands
     SDK) and is deployable to AgentCore Runtime. That code does not exist yet.
- **Docs path:** these documents record the target state and gaps for the control plane.
  The workshop log feeds the architecture, which feeds the production-readiness plan. The
  Qdrant and runtime docs are operator and test records against
  `control-plane/src/lib/{kb,runtimes,databricks,bedrock}.ts`.

## Files

| File | What it is for (why) | Key contents | Connects to |
|---|---|---|---|
| `aws-audit/aws-audit.sh` | Reproducible, read-only AWS account inventory | `set -uo pipefail`; `REGION=${AWS_DEFAULT_REGION:-us-east-1}`; `log()`/`run()` helpers tee to `logs/audit-<stamp>.log`; 16 calls: sts caller identity, IAM aliases/users/roles/groups/summary, Organizations describe/list-accounts, S3 buckets, EC2 instances/regions/VPCs, Lambda, Bedrock foundation models, `bedrock-agentcore-control list-agent-runtimes`, CloudFormation stacks | `docs/governance-workshop-log.md` (evidence); `.gitignore` (`*.log`) and root `.gitignore` (`aws-audit/logs/`) |
| `src/agentexpress/__init__.py` | Package marker and statement of the intended design | Docstring: supervisor and specialists (Researcher, Writer, Reviewer) via Strands "agents as tools", deployable to AgentCore Runtime; `__version__ = "0.1.0"` | `config.py`; `requirements*.txt` |
| `src/agentexpress/config.py` | Central settings for the (planned) Python agents | `_load_dotenv()` (no-dependency parser of `parents[2]/.env`, `os.environ.setdefault` so real env wins); frozen dataclass `Settings`: `AWS_REGION` (default `us-east-1`), `AGENTEXPRESS_MODEL_ID` (default `us.anthropic.claude-3-5-haiku-20241022-v1:0`), `AGENTEXPRESS_TEMPERATURE` (default `0.3`); `settings` singleton | `.env.example`; not imported anywhere else |
| `requirements.txt` | Core runtime dependencies for the Python package | `strands-agents>=0.1.0`, `strands-agents-tools>=0.1.0`, `bedrock-agentcore>=0.1.0`, `boto3>=1.35.0` | `src/agentexpress/` |
| `requirements-deploy.txt` | Deploy tooling for AgentCore Runtime | `-r requirements.txt` + `bedrock-agentcore-starter-toolkit>=0.1.0` | `.gitignore` ignores the toolkit's `.bedrock_agentcore.yaml` / generated `Dockerfile` |
| `.env.example` | Environment template (copy to `.env`) | `AWS_REGION`, `AGENTEXPRESS_MODEL_ID`, `AGENTEXPRESS_TEMPERATURE`; Neptune endpoint/SPARQL/openCypher/IAM role/ontology metadata (`sigv4-assume-role`, no keys); Databricks host, UC catalog/schema, OMDA registry table, vector search, model serving, `DATABRICKS_TOKEN`, resource allowlist (`DATABRICKS_ENFORCE_RESOURCE_ALLOWLIST=true`, `DATABRICKS_ALLOWED_*`); `GRAPH_SERVING_TOKEN` (never `NEXT_PUBLIC_*`) | `config.py`; control plane reads `DATABRICKS_HOST`/`DATABRICKS_TOKEN`/`GRAPH_SERVING_TOKEN` |
| `.gitignore` | Keeps secrets and artifacts out of git | Python caches, venvs, `.env`, `*.pem`, `.bedrock_agentcore.yaml`, `Dockerfile`/`.dockerignore` (re-included for `control-plane/`), `*.log` | `aws-audit/logs`, `control-plane/Dockerfile` |
| `docs/governance-workshop-log.md` | Record of the workshop and the account audit, plus a convergence plan | Thesis (managed identity, declarative Cedar policy, audit); services verified in sandbox `899561148374` (AgentCore Runtime/Gateway/Identity, Cognito, AVP empty, CloudTrail); the 5 parts (Registry, Agents, two-layer Cedar, Playground personas, LLM gateway); AgentExpress (data plane) + Governance (control plane) target diagram and build order; Organizations API denied; rotate-credentials note | `aws-audit/` logs; control-plane pages mapped to the 5 parts |
| `docs/takeda-agent-platform-architecture.md` | Target reference architecture (draft for review) | Thesis (IDMC + Databricks UC/S3 + AgentCore, Cedar perimeter); principles; tenancy tree Takeda→BU→BFBF→Workspace with silo/pool/hybrid; logical diagram; S3/Databricks/IDMC as governed tools; §4A KB providers + `queryKnowledgeBase` + tier limits (basic 1 / pro 20); OBO identity propagation; roles; GxP guardrails; decisions; phased rollout; §11 gap table vs control-plane | `control-plane/` (Registry, Agents, Policies, Tenants); `production-readiness-plan.md` |
| `docs/production-readiness-plan.md` | Plan to take the control plane from demo to production | Current state at writing (in-memory store, no auth, regex Cedar sim, TierConfig not enforced); P0 persistence/AuthN-Z/tenant isolation/GxP; P1 observability, scale, IaC (+ saas-workloads KRO+ArgoCD GitOps), tests; P2 pool→silo migration via KRO/ArgoCD, FinOps; service mapping table | `control-plane/src/lib/{store,evaluator,types}.ts`; `saas-workloads/`; root README links it |
| `docs/qdrant-knowledge-base-setup.md` | Field-by-field guide to registering a Qdrant KB in the Registry | API key goes to Secrets Manager, not the form; cluster URL/collection values; `Takeda_Knowledge_Registry`; "Define manually" gotcha; retrieval defaults (`scoreThreshold 0.4`, `hybrid`, citations); lifecycle Draft→Pending→Approved; §6 retriever modules (`lib/kb/{types,secrets,embed,qdrant,service}.ts`, `api/kb/retrieve`), two-stage Cedar `queryKnowledgeBase`, API-only fields, cluster unreachable (TLS reset); `integration/qdrant_live_check.mjs`; `POST /api/registry` payload | `control-plane/src/lib/kb/*`, `/api/registry`, `/api/kb/retrieve`, `/approvals` |
| `docs/runtime-execution-test-report.md` | Test report on every runtime id in `lib/runtimes.ts` | Round 1: 23/23 ids accepted, none used for execution (`compute` never read); negative cases 400; Databricks/AWS capability probes; silent model substitution to haiku in `toInferenceProfileId()`. Round 2: Databricks executor (`lib/databricks.ts`, dispatch in `api/workflows`), workspace is serverless-only, FM pay-per-token + Lakeflow job executed for real, `MODEL_UNROUTABLE`, plane-agreement guard, `costUsd` null for Databricks; tests 176/176; rotate PAT/Qdrant/Neo4j secrets | `control-plane/src/lib/{runtimes,bedrock,databricks}.ts`, `api/agents`, `api/workflows` |
| `images/` (folder, 29 PNGs, ~6.5 MB) | Workshop UI reference screenshots, used as the visual spec for reproducing the console | Filenames prefixed by workshop part: `part1_*` (registry creation/records/approval), `part2*` (compute, add tool, Opus model setting), `part3*` / `Part3_*` (Cognito personas/groups, NL2Cedar, policy engine/lifecycle/tracing, gateway sync), `part5_*` (per-caller / per-target budgets, bedrock-mantle, registering gpt-oss-120b/20b), plus `persona_sub.png`, `register-gpt-oss-120b.png` | Control-plane pages for Registry, Agents, Policies, Policy Engines, Settings/Models |

## How to run / apply

AWS inventory (from the script header):

```bash
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=...
./aws-audit.sh          # run from Agents_Express/aws-audit/; writes logs/audit-<UTC>.log
```

Python package environment (from the requirements files; there is no entry point to run yet):

```bash
cp .env.example .env    # then edit
pip install -r requirements.txt
pip install -r requirements-deploy.txt   # AgentCore starter toolkit
```

Commands quoted in the docs, which run against the control plane:

```bash
# docs/qdrant-knowledge-base-setup.md
aws secretsmanager create-secret --name qdrant/<cluster-id> --secret-string '{"apiKey":"..."}' --region sa-east-1
cd control-plane
QDRANT_URL=... QDRANT_API_KEY=... QDRANT_COLLECTION=product_docs AWS_REGION=us-west-2 \
  node --import ./tests/register.mjs integration/qdrant_live_check.mjs
curl -X POST http://localhost:3000/proxy/3000/api/kb/retrieve -H 'content-type: application/json' \
  -d '{"recordId":"<record-id>","personaId":"persona-john","query":"...","topK":5}'
```

## Connections to other modules

- **control-plane**:
  - The docs describe it, set its targets and test it.
  - `.env.example` supplies some of the variables it reads.
  - `images/` is the UI reference for its workshop-derived pages.
  - The Python package and the audit script are not imported or invoked by it.
- **saas-workloads / saas-platform-configs**: `production-readiness-plan.md` P1.3 and P2
  name the KRO + ArgoCD GitOps pattern for per-tenant provisioning and pool→silo
  migration.
- **a2a-demo**: `a2a-demo/PLATFORM_SETUP.md` points to `production-readiness-plan.md` for
  the production wiring of identity and Cedar.
- **graph-utility**: the Neptune/OMDA/Databricks placeholders in `.env.example` belong to
  the knowledge-graph work. The `agentexpress_*` UC tables (for example
  `workspace.default.agentexpress_suppliers`, created during the runtime test) are
  mentioned in the module docstring of `graph-utility/src/graph_utility/overlap.py`.
