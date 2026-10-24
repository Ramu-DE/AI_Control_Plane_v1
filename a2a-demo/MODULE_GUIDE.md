# a2a-demo — module guide

## What it is for and why it is in this repository

`a2a-demo` is a small **reference implementation** of two peer agents, a
**Sales agent** and a **Supply Chain agent**. They talk to each other over the
**A2A (Agent-to-Agent) protocol**. Each one reasons with **Amazon Bedrock
Converse** and they share a simple memory layer with three tiers: session,
semantic and audit.

How it relates to the AgentControl control plane (`Agents_Express/control-plane`):

- It is **reference only**. Nothing in the control plane imports or runs it. `SETUP.md` §5 says: "The control
  plane has its own A2A client under `src/lib/a2a/`; it does not import or run
  anything from here." The root `SETUP.md` table describes it as "not wired into the
  control plane".
- The control plane **uses the same scenario**. `control-plane/src/lib/a2a/store.ts`
  seeds the peers `sales-agent` (tenant `bu-us`, Approved) and `supply-chain-agent`
  (tenant `fn-supply`, Draft on purpose). Those peers use `selfRouting(...)`, so they
  loop back to the control plane's own A2A server (`lib/a2a/server.ts`) and do not
  call these Python servers. The Cedar seed in `lib/store.ts` refers to
  `Tool::"a2a:sales-agent"`.
- The docs here (`ARCHITECTURE.md`, `PLATFORM_SETUP.md`) describe the control plane as
  the governance and orchestration layer. In that model it handles Registry, Agents,
  Cedar policy, Workflows and Audit, and the live A2A servers and memory stores run
  outside it.
- One protocol detail differs. This demo serves Agent Cards at
  `/.well-known/agent.json`. The control plane's `lib/a2a/card.ts` probes
  `/.well-known/agent-card.json` first and then `/.well-known/agent.json`. Its
  outbound client (`lib/a2a/client.ts`) sends JSON-RPC `message/send`.

## Flow

**Driver path (`run_demo.py`, no HTTP servers needed, real Bedrock calls):**

1. `run()` creates `session_id = run-<8 hex>`.
2. `sales_agent.demand_signal()` calls `bedrock_brain.reason()` with the Sales system
   prompt. It writes `SESSION[sales_demand_signal]` and logs an `AUDIT` entry
   `produced_demand_signal`.
3. `supply_chain_agent.optimize()` stores `sales_demand`, runs `SEMANTIC.recall()` on
   the request and calls Bedrock. It writes `SESSION[sc_plan]`, runs
   `SEMANTIC.remember()` and logs an audit entry.
4. `sales_agent.plan()` reads `sc_plan` and calls Bedrock to produce the final
   fulfilment plan. It writes `SESSION[sales_plan]` and logs audit entries.
5. The driver prints the session snapshot (values cut to 120 chars) and the audit
   trail.

**A2A server path (each agent is a Starlette app run with uvicorn):**

- **Supply Chain** (port 9001): `SupplyChainExecutor.execute` opens an
  `httpx.AsyncClient`. It calls Sales at `SALES_URL` through `A2AClient` (the code
  marks the method name `send_message_text` as "adapt as needed"), then runs
  `optimize()` and enqueues the plan.
- **Sales** (port 9002): `SalesExecutor.execute` checks `SESSION[sc_plan]` for the
  task id. If it is missing, it runs `demand_signal()`. If it is present, it runs
  `plan()`.
- Both servers advertise an `AgentCard` with `streaming=True`. Sales offers the
  skills `demand_signal` and `fulfilment_plan`. Supply Chain offers `route_optimize`
  and `eta_estimate`. Both use an `InMemoryTaskStore`.
- The memory singletons (`SESSION`, `SEMANTIC`, `AUDIT`) are per process. So when the
  two servers run as separate processes they do **not** share memory unless you swap
  in DynamoDB or Redis (`memory.py` comment).

## Files

| File | What it is for (why) | Key contents | Connects to |
|---|---|---|---|
| `src/bedrock_brain.py` | The LLM "brain" each agent calls | `MODEL_HAIKU/SONNET/OPUS` (`us.anthropic.claude-*-4-5-*` profiles); `DEFAULT_MODEL` from `A2A_MODEL_ID` (default Haiku); `REGION` from `AWS_REGION` (default `us-east-1`); lazy, cached `boto3` `bedrock-runtime` client; `reason(system, user, model_id, max_tokens=600, temperature=0.2)` → joined Converse text; smoke test under `__main__` | Imported by `sales_agent.py` and `supply_chain_agent.py`; Bedrock Converse |
| `src/memory.py` | Swappable memory tiers for the multi-agent run | `SessionMemory` (lock-guarded dict keyed by `session_id`; `put/get/snapshot`); `SemanticMemory` (dataclass, `kb_id`, list fallback; `recall` returns the last `top_k`); `AuditMemory` (append-only events with `session_id/actor/action/detail/ts`); singletons `SESSION`, `SEMANTIC`, `AUDIT` | Used by both agents and `run_demo.py`; ARCHITECTURE.md §4 |
| `src/supply_chain_agent.py` | Supply Chain A2A server (route and ETA optimization) | `SALES_URL` (default `:9002`), `SC_PORT` (9001); `SYSTEM_PROMPT`; `optimize()` (SDK-independent logic); `build_agent_card()`; `build_app()` using `A2AStarletteApplication` + `DefaultRequestHandler` + `InMemoryTaskStore`; `# app = build_app()` commented out | Calls Sales over A2A; `bedrock_brain`, `memory` |
| `src/sales_agent.py` | Sales A2A server (demand signal and fulfilment plan) | `SUPPLY_CHAIN_URL` (default `:9001`), `SALES_PORT` (9002); `demand_signal()`, `plan()`; `build_agent_card()`; `build_app()` with `SalesExecutor` choosing the branch by whether `sc_plan` exists | Reads Supply Chain output from `SESSION`; `bedrock_brain`, `memory` |
| `src/run_demo.py` | Driver that runs the full loop in one process | `run(request_text)`: demand_signal → optimize → plan, then prints the SESSION snapshot and AUDIT trail; default request "5,000 units of Product P from DC-Atlanta to Region-West ... 72 hours" | Imports `memory`, `sales_agent`, `supply_chain_agent` |
| `README.md` | Entry point: what the demo is and how to run it | Code map; prerequisites (Python 3.10+, Bedrock in `us-east-1`); driver quick start; steps to make the real A2A servers work (pin SDK, adapt marked lines, uncomment `app`); production memory backends; governance pointer and workshop platform URL | ARCHITECTURE.md, PLATFORM_SETUP.md |
| `ARCHITECTURE.md` | Design rationale | §0 control plane governs and does not host A2A servers; §1 logical diagram; §2 interaction sequence; §3 A2A vs MCP table; §4 four memory tiers (short-term, working, semantic, episodic); §5 real vs build; §6 decisions; §7 layout; SDK note | Describes the `src/` code and the control plane's role |
| `PLATFORM_SETUP.md` | Maps the scenario onto control-plane screens | Steps: `/tenants` (sub-unit "Supply & Sales", basic/pro), `/settings` models, `/registry` (`SupplyNet_Registry`, two `Agent` records + Bedrock KB record), `/agents` (toolRefs/knowledgeRefs), `/policies` + `/policy-engines` (NL→Cedar, Enforce, Sync), `/workflows` (3 steps, review gate on Route Optimize), `/playground`, `/audit`; mapping table | Control plane UI; refers to `production-readiness-plan.md` |
| `requirements.txt` | Python dependencies | `boto3>=1.34.0`, `a2a-sdk>=0.2.0`, `uvicorn>=0.30.0`, `httpx>=0.27.0`; Redis left commented out as optional | Install step; SETUP.md recommends pinning `a2a-sdk==0.2.16` |

(`.gitignore` excludes `__pycache__/`, `.venv/`, `.env*` and `*.pem`. The local `.venv/`
and `src/__pycache__/` folders are build artifacts and are not part of the module.)

## How to run / apply

From `SETUP.md` §5 (the recommended install):

```bash
cd a2a-demo
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install 'a2a-sdk==0.2.16'   # src/ matches the 0.2.x API; 1.x will not import
```

Driver (needs AWS credentials with Bedrock access, from README):

```bash
python src/run_demo.py "Fulfil 5,000 units of Product P from DC-Atlanta to Region-West, SLA 72h"
python src/bedrock_brain.py      # smoke test: prints "OK"
```

As real A2A servers (README). First adapt the lines marked `# adapt per SDK` /
`# SDK-pinned` and uncomment `app = build_app()` in each agent:

```bash
SC_PORT=9001 uvicorn supply_chain_agent:app --port 9001 &
SALES_PORT=9002 uvicorn sales_agent:app --port 9002 &
# cards: http://localhost:9001/.well-known/agent.json , :9002/.well-known/agent.json
```

Without those edits, `python src/<agent>.py` runs `uvicorn.run(build_app(), ...)` directly.

Environment variables: `A2A_MODEL_ID`, `AWS_REGION`, `SALES_URL`, `SUPPLY_CHAIN_URL`,
`SC_PORT`, `SALES_PORT`.

## Connections to other modules

- **Agents_Express/control-plane**:
  - There is no code dependency.
  - The control plane's TypeScript A2A stack (`src/lib/a2a/{card,client,server,store,logic,types}.ts`)
    re-implements the same Sales ⇄ Supply Chain peers with self-routing, bearer-env
    auth (`A2A_INBOUND_TOKEN`), tenant scoping and Cedar policy.
  - `PLATFORM_SETUP.md` shows how you would register external servers like these in
    the control plane's Registry/Agents/Policies/Workflows instead.
  - The Bedrock inference profile IDs match the control plane's catalog mapping (root
    `README.md`).
- **Agents_Express/docs/production-readiness-plan.md**: `PLATFORM_SETUP.md` points to it
  for the production wiring of identity and Cedar.
- **graph-utility, saas-\***: no connection.
