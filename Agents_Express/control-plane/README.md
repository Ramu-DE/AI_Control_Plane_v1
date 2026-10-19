# AgentExpress Control Plane

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
| Model Governance | Part 5 | `/models` | LLM gateway **routes**, **providers**, rate limits & token budgets |
| Audit | — | `/audit` | Filterable trail of every control-plane action |

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
- No AWS credentials are used or stored by this app.
