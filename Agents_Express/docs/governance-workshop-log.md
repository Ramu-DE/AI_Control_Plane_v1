# Agentic AI Authorization & Governance — Workshop Log + Convergence Plan

Source workshop: https://catalog.workshops.aws/workshops/586eff4f-ef9e-475d-8084-ca95fd6389a2/en-US
Duration: ~3 hours · Format: 5 parts
Captured: 2026-10-19 (UTC) · Account probed: `899561148374` (workshop sandbox)

> The workshop catalog page is a JavaScript app and cannot be scraped directly.
> The structure below is reconstructed from (a) the workshop abstract you provided,
> (b) the AWS services verified as deployed in the sandbox account, and
> (c) official AWS docs for the services the workshop is built on. Items marked
> **[inferred]** are reconstructed, not copied verbatim from the catalog.

---

## 1. What the workshop teaches (the thesis)

Nearly 40% of enterprise apps embed AI agents, but most orgs can *monitor* agents
yet cannot *authorize and govern* them at scale. AI agents are a **new identity
class**: non-human, autonomous, invoking multiple tools in one session **on behalf
of a user**. The workshop teaches governing agents as **"digital employees"** via a
**centralized control plane** with three pillars:

1. **Managed identities** — every agent gets its own first-class identity (not a shared key / reused human role).
2. **Declarative policies** — authorization expressed as data (Cedar), enforced outside the LLM, default-deny.
3. **Audit trail** — every agent action is attributable and reviewable.

---

## 2. The AWS services the workshop is built on (verified in the account)

Read-only inventory of account `899561148374` found these governance primitives
already deployed by the workshop (full logs in `aws-audit/logs/`):

| Capability | Service / Resource found | Evidence |
|---|---|---|
| Agent runtime | **Bedrock AgentCore Runtime** — `ax_bd707413` ("Multi-agent LangGraph orchestrator, CDK-managed", READY) | `list-agent-runtimes` |
| Tool authorization boundary | **AgentCore Gateway** — `ax-bd707413-gw` (protocol **MCP**, authorizer **CUSTOM_JWT**, READY) | `list-gateways` |
| Agent identity | **AgentCore Identity** — 3 workload identities (gateway, runtime, registry) | `list-workload-identities` |
| Inbound auth (who can call the agent) | **Amazon Cognito** — user pools `agentexpress-users`, `ax_bd707413-users` (PostAuth Lambda) | `list-user-pools` |
| Declarative policy engine | **Cedar** via AgentCore Policy (store empty in sandbox at probe time) / Amazon Verified Permissions (`list-policy-stores` → empty) | `list-policy-stores` |
| Audit trail | **CloudTrail** — org trails `EventEngineTrail`, `CloudTrailStreamStack...` (multi-region, org-level) | `describe-trails` |
| Builder console | CloudFormation `agentexpress-console` → CloudFront UI, from `aws-samples/sample-aiml-solution-labs` | `describe-stacks` |

Mapping to concepts:
- **Managed identity** → AgentCore Identity workload identities + Cognito for human/user auth.
- **Declarative policy** → Cedar policies enforced at the AgentCore **Gateway** (default-deny, independent of LLM reasoning).
- **Audit trail** → CloudTrail (org trail) + CloudWatch/AgentCore Observability.

---

## 3. The 5 parts (confirmed from workshop content)

### Part 1 — Unified Catalog of Agents/Tools
Problem: without a central catalog, agents and tools stay siloed per team → duplicated
work, drifting references, no central place to govern. The **registry** is the single
source of discovery, approval, and reuse (registry-first approach).
You will:
- Learn what **AWS Agent Registry** is and why registry-first matters.
- **Create a registry** — your org's catalog.
- **Register an MCP server** — the public **AWS Knowledge MCP server** → experience
  auto-generated tool discovery.
- **Register a Lambda as an MCP-compatible record** — a pre-deployed **Expense Lambda**,
  using a schema copied from the workshop content.

### Part 2 — Agent Creation
Agents here are **declarative configuration** (LLM model, system prompt, tool list,
compute). AgentCore Runtime reads the config and constructs the agent at invocation time.
You will:
- Add a **foundation model** under **Settings → Models**.
- Create the **Expense Assistant** agent (model, prompt, tools, compute).
- Confirm it's saved and ready to invoke.
- Note: in this part the agent (e.g. **Claude Opus**) calls **Bedrock directly** — this
  "direct model call" is the problem Part 5 fixes.

### Part 3 — Policy-Driven Authorization
Write **declarative policies, not application code**, governing which users can invoke
which tools and under what conditions. Decisions become editable/auditable/verifiable in
seconds. **Two-layer authorization model**:
- **AgentCore Policy at the gateway** (perimeter / MCP boundary) — Cedar.
- **Amazon Verified Permissions (AVP) inside the tool** (e.g. inside the Expense Lambda) — Cedar.
- Both engines use **Cedar**. Default-deny.

### Part 4 — Playground & Persona Simulation
End-to-end test of everything built: Registry + Agent + AgentCore Policy at the perimeter
+ AVP inside the Lambda. Simulate different **personas** to see allow/deny decisions and
the two authorization layers working together.

### Part 5 — Model Governance
Parts 1–4 govern **what an agent may do**; Part 5 governs **what an agent may spend**:
which models it can reach, through which provider, at what rate.
- Problem: teams call model endpoints directly (as in Part 2) → no single place for usage,
  no provider switching without redeploy, no per-team throughput isolation. Usual fix is a
  self-hosted LLM proxy (LiteLLM etc.) = another service to run/patch/scale/secure.
- Solution: the **LLM gateway** — a **second, pre-deployed AgentCore Gateway** — fronts
  **model providers over the OpenAI wire protocol** (the same Gateway primitive that fronts
  tools over MCP), with **routing, credential abstraction, and rate limiting** built in,
  nothing to self-host.

### Verified state of these parts in the sandbox (probe at 2026-10-19)
At probe time the environment was provisioned but the parts not yet completed:
- Gateways: **1** (`ax-bd707413-gw`, MCP/tools). The **second LLM gateway (Part 5) not yet created**.
- **No Expense Lambda / registry tool targets** registered yet (Part 1).
- **Verified Permissions policy stores: empty** (Part 3 AVP not yet created).
- Log: `aws-audit/logs/parts-probe-*.log`.

---

## 4. Convergence plan — combine AgentExpress (build) + Governance (control)

You have two workshops. Converge them into one company platform:

- **AgentExpress** = how you **build & run** multi-agent workflows (orchestrator + specialists on AgentCore Runtime, MCP tools via Gateway). This is the *data plane*.
- **Agentic Governance** = how you **secure & govern** them (Identity, Cedar policy, audit). This is the *control plane*.

Target architecture (single platform):

```
          Humans (Cognito / corporate IdP, OIDC)
                     │  inbound JWT
                     ▼
        ┌─────────────────────────────┐
        │  Supervisor / Orchestrator  │  ← AgentExpress build
        │     (AgentCore Runtime)     │
        └──────────────┬──────────────┘
          agents-as-tools / A2A
   ┌──────────────┼───────────────┐
   ▼              ▼               ▼
Researcher     Writer         Reviewer   ← specialist agents (own workload identities)
   │              │               │
   └──────────────┴───────────────┘
                  │ tool calls (MCP)
                  ▼
        ┌─────────────────────────────┐
        │   AgentCore Gateway (MCP)   │  ← Governance control plane
        │   + Cedar policy (deny-by-  │     default-deny, human-in-loop for writes
        │     default) + Identity     │
        └──────────────┬──────────────┘
                       ▼
             Tools / APIs / Knowledge Bases
                       │
                       ▼
     CloudTrail + AgentCore Observability (audit trail)
```

Build order for the company:
1. Build the multi-agent workflow (AgentExpress pattern) — orchestrator + specialists.
2. Give each agent its **own AgentCore workload identity** (no shared creds).
3. Route all tool calls through an **AgentCore Gateway (MCP)**.
4. Add **Cedar policies**: default-deny; read allowed; write/delete require approval.
5. Put human auth in front via **Cognito / corporate OIDC** (inbound JWT).
6. Turn on **CloudTrail + Observability**; define review/revocation cadence.
7. Stand up a central **agent/tool registry** and pick a governance model
   (start **centralized**, evolve to **hybrid** as teams onboard).

---

## 5. Verified account findings (for reuse at Organization scale)

- Identity used: `arn:aws:sts::899561148374:assumed-role/WSParticipantRole/Participant`.
- **Organizations API is denied** for this role (`DescribeOrganization`,
  `ListAccounts` → AccessDenied). An Org-wide rollout needs management-account /
  delegated-admin credentials, then assume a read-only role per member account.
- CloudTrail org trails already exist (`IsOrganizationTrail: true`) — useful as the
  audit backbone when you replicate this across the Organization.

Logs:
- `aws-audit/logs/audit-*.log` — full read-only inventory.
- `aws-audit/logs/governance-probe-*.log` — identity/policy/gateway/trail probe.

## Security note
Credentials were pasted into chat and the inventory log contains a workshop sign-in
password. Rotate/expire these credentials. No credential is hardcoded in any file;
scripts read them from environment variables only.
