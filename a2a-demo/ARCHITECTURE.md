# Sales ↔ Supply Chain — A2A Multi-Agent Architecture

**Status:** Design + runnable reference · **Audience:** Platform/AI architects
**Goal:** Two autonomous agents that collaborate as peers:

- **Sales agent** — demand & supply fulfilment planning. Reads Supply Chain's
  optimized delivery to understand delivery in terms of sales fulfilment.
- **Supply Chain agent** — point-to-point fastest-delivery optimization based on
  demand. Uses the Sales agent for efficient delivery / demand fulfilment.

The relationship is **bidirectional and peer-to-peer** (each calls the other),
which is precisely what the **A2A protocol** (Agent-to-Agent) is designed for.

---

## 0. The core distinction (read this first)

The **Agent Management Platform** (the Next.js control plane at `/app`) is a
**governance + orchestration control plane**. It lets you:

- register agents / tools / knowledge bases (Registry, with an approval lifecycle),
- declare agents (model, prompt, tools, KBs, tenant),
- author Cedar policy (who may call whom),
- run **multi-agent workflows on real Amazon Bedrock** with human-in-the-loop gates,
- audit every action.

What it is **not**: a runtime that hosts long-lived A2A servers exchanging messages
over a wire protocol. Per the platform's own README, Cedar / AVP / Cognito are
**simulated**; only **Bedrock Converse** calls are **real**.

> **Therefore:** the live A2A servers and the memory stores are things you **build
> and run outside** the control plane. The platform then **registers, governs
> (Cedar), orchestrates (Workflows), and audits** them.

---

## 1. Logical architecture

```
                         ┌──────────────────────────────────────────┐
                         │  AGENT MANAGEMENT PLATFORM (control plane) │
                         │  • Registry: register each agent (type=    │
                         │    "Agent") + its A2A endpoint + auth      │
                         │  • Agents: declarative config (model,      │
                         │    prompt, toolRefs, knowledgeRefs, tenant)│
                         │  • Policy (Cedar): who may call whom        │
                         │  • Workflow: orchestrate a Sales+SC run    │
                         │  • Audit: every A2A call attributable      │
                         └───────────────┬────────────────────────────┘
                     governs / registers │ (metadata, policy, orchestration)
                                         ▼
   ┌──────────────── DATA / RUNTIME PLANE (you build + run) ─────────────────┐
   │                                                                          │
   │   ┌───────────────────────┐        A2A (JSON-RPC/HTTPS + SSE)           │
   │   │  SALES AGENT           │◄───────────────────────────────────────┐   │
   │   │  (A2A server)          │   "optimize delivery for this demand"   │   │
   │   │  AgentCard: /.well-    │────────────────────────────────────────┼─► │
   │   │   known/agent.json     │   "here is demand/fulfilment plan"      │   │
   │   │  skills: demand_signal,│                                          │   │
   │   │   fulfilment_plan      │        ┌───────────────────────┐         │   │
   │   │  model: Bedrock Claude │        │  SUPPLY CHAIN AGENT    │─────────┘   │
   │   └──────────┬─────────────┘        │  (A2A server)          │             │
   │              │                      │  skills: route_optimize│             │
   │              │  reads SC data       │   , eta_estimate,      │             │
   │              └─────────────────────►│   capacity_lookup      │             │
   │                                     │  model: Bedrock Claude │             │
   │                                     └──────────┬─────────────┘             │
   │                                                │                           │
   │   ┌─────────────────── SHARED MEMORY LAYER ────┴──────────────────────┐   │
   │   │  Short-term (per task):  conversation/context window (in-proc)     │   │
   │   │  Working (per session):  Redis / DynamoDB  (shared task state)     │   │
   │   │  Long-term (semantic):   Bedrock KB / vector store (demand &       │   │
   │   │                          delivery history, embeddings)             │   │
   │   │  Episodic (audit):       DynamoDB append-only run log              │   │
   │   └────────────────────────────────────────────────────────────────────┘ │
   └──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Interaction sequence

```
Orchestrator / user
      │  "Fulfil demand D for product P from DC-A to Region-B, fastest viable"
      ▼
┌───────────────┐   A2A: ask demand/fulfilment priority    ┌────────────────────┐
│ SUPPLY CHAIN  │ ───────────────────────────────────────► │ SALES AGENT         │
│ AGENT         │                                           │ (reasons on Bedrock)│
│               │ ◄─────────────────────────────────────── │ returns demand sig. │
│ writes        │        demand/fulfilment signal           └────────────────────┘
│ sales_demand  │
│ to SESSION    │
│               │   reason on Bedrock (route + ETA) using
│               │   recalled history (SEMANTIC) + sales signal
│ writes        │
│ sc_plan       │
│ to SESSION    │
└──────┬────────┘
       │  returns optimized delivery plan
       ▼
┌───────────────┐   reads sc_plan from SESSION (or A2A)     ┌────────────────────┐
│ SALES AGENT   │ ◄──────────────────────────────────────── │ SHARED SESSION MEM │
│ final pass    │   produces fulfilment plan maximizing     └────────────────────┘
│               │   sales given delivery constraints
└───────────────┘
```

Both agents read/write the **same session memory** so they never drift, and each
keeps **private scratch memory** for its own reasoning.

---

## 3. Why A2A (and when to pick MCP instead)

**A2A (peer agents) — recommended here.** Your agents are autonomous, owned by
different domains (Sales vs. Logistics), each reasons with an LLM, and each calls
the other dynamically. A2A gives:

- **Agent Cards** (`/.well-known/agent.json`) for capability discovery,
- typed **Task/Message** exchange with streaming (SSE),
- auth between autonomous agents,
- true peer topology (either side can initiate).

**MCP (tool-style) — the alternative.** If you'd rather have Supply Chain treat
Sales as a *callable tool* (and vice versa) with simpler synchronous calls and no
separate agent runtime, register each as an **MCP record** instead of an Agent
record. Less autonomy, simpler ops, no peer initiation.

| Dimension | A2A (chosen) | MCP (alt) |
|---|---|---|
| Topology | Peer ↔ peer | Caller → tool |
| Autonomy | Each is an agent | One is a tool |
| Discovery | Agent Card | Tool schema |
| Streaming | Yes (SSE) | Limited |
| Ops cost | 2 servers | 1 server + 1 tool |

---

## 4. Memory management for multi-agent orchestration

Four tiers, each with a clear owner and store:

| Tier | Scope | Store (dev → prod) | Purpose |
|---|---|---|---|
| **Short-term context** | single task/turn | in-process message list | the running conversation for one request |
| **Working / session** | one run, **shared** by both agents | InMemory → **DynamoDB** / **Redis** (key `session_id`) | shared task state (demand figures, candidate routes) so both agents see the same facts |
| **Long-term semantic** | across runs | list stub → **Bedrock KB** / vector store | historical demand patterns & delivery outcomes via RAG |
| **Episodic / audit** | across runs, immutable | InMemory → **DynamoDB** append-only | every A2A message + decision, feeds the platform Audit view |

**Rules of thumb**

1. **One shared session store** that both agents read/write — prevents divergence.
2. **Private scratch** per agent for intermediate reasoning (don't pollute shared).
3. **Semantic memory is governed** — register the KB in the platform Registry
   (`type = "Knowledge Base"`) and attach to both agents via `knowledgeRefs`.
4. **Everything audited** — episodic log is the attributable trail (GxP-friendly).

> Managed option: **Amazon Bedrock AgentCore Memory** can replace self-run
> Redis/DynamoDB for short/long-term memory if you prefer a managed primitive.

---

## 5. What's real vs. what you build

**Runs for real in the platform today**
- Bedrock-backed **Workflow** orchestration (sequential agents + human gates).
- Playground responses on allow (real Bedrock Converse).

**You build / run outside the platform**
- The live **A2A servers** (the Python in `src/`).
- The **memory stores** (Redis / DynamoDB / Bedrock KB).
- Real identity + Cedar enforcement (the app simulates these per its README).

The platform then **registers, governs, orchestrates, and audits** the above.

---

## 6. Decisions for you

1. **A2A vs MCP** for the inter-agent link (default: **A2A**).
2. **Memory backend** for the demo: in-memory (zero setup) / DynamoDB / Redis.
3. **Sample data**: provide real demand/route data, or use generated mock data.
4. **Execution locus**: standalone A2A servers (this project) and/or model the loop
   as a platform **Workflow** first (fastest path to a governed, Bedrock-real demo).

---

## 7. Repository layout

```
a2a-demo/
├── ARCHITECTURE.md        ← this file
├── PLATFORM_SETUP.md      ← step-by-step Agent Management Platform config
├── README.md              ← how to run
├── requirements.txt
├── .gitignore
└── src/
    ├── memory.py              ← shared session + semantic + audit memory
    ├── bedrock_brain.py       ← Bedrock Converse reasoning helper
    ├── supply_chain_agent.py  ← A2A server (calls Sales)
    ├── sales_agent.py         ← A2A server (reads Supply Chain)
    └── run_demo.py            ← driver: kicks off a Sales↔SC exchange
```

> **SDK note:** the A2A SDK's exact class/method names evolve across versions. The
> code in `src/` is structured against the `a2a-sdk` shape but marked where the
> precise API must be pinned to the installed version. See README §"Make it run".
