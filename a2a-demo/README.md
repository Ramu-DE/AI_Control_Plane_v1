# Sales ↔ Supply Chain — A2A Multi-Agent Demo

Two autonomous agents that collaborate as **peers** over the **A2A protocol**,
reason on **Amazon Bedrock**, and share a **multi-tier memory** layer. Governed
and orchestrated by the **Agent Management Platform**.

- **Sales agent** — demand & supply fulfilment planning; reads Supply Chain's
  optimized delivery.
- **Supply Chain agent** — point-to-point fastest-delivery optimization; uses the
  Sales agent for demand fulfilment.

## Documents

| File | What it covers |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Logical diagram, interaction sequence, A2A-vs-MCP rationale, 4-tier memory design, real-vs-build, decisions |
| [`PLATFORM_SETUP.md`](./PLATFORM_SETUP.md) | Step-by-step config in the Agent Management Platform (Registry, Agents, Policies, Workflows) |

## Code

```
src/
├── memory.py              shared session + semantic + audit memory (swappable backends)
├── bedrock_brain.py       Bedrock Converse reasoning helper (lazy boto3)
├── supply_chain_agent.py  A2A server; optimize() calls Sales + Bedrock
├── sales_agent.py         A2A server; demand_signal() + plan()
└── run_demo.py            driver: one Sales↔SC run + prints shared memory & audit
```

## Prerequisites

- Python 3.10+
- AWS credentials with **Amazon Bedrock** access in `us-east-1` (instance role or
  `AWS_*` env vars). The agents use the same Claude inference profiles as the
  platform (`us.anthropic.claude-haiku-4-5-...` by default).

## Quick start (driver — works without the A2A HTTP servers)

The driver exercises the full loop using each agent's SDK-independent logic and
makes **real Bedrock calls**:

```bash
cd a2a-demo
python3 -m venv .venv && source .venv/bin/activate
pip install boto3              # minimum for the driver
python src/run_demo.py "Fulfil 5,000 units of Product P from DC-Atlanta to Region-West, SLA 72h"
```

You'll see: Sales demand signal → Supply Chain optimized delivery → Sales final
fulfilment plan → a snapshot of **shared SESSION memory** and the **AUDIT trail**.

## Make it run as real A2A servers

1. Install the A2A SDK and pin its version:
   ```bash
   pip install -r requirements.txt
   pip show a2a-sdk        # note the installed version
   ```
2. In `supply_chain_agent.py` and `sales_agent.py`, adapt the lines marked
   `# adapt per SDK` / `# SDK-pinned` to the installed SDK's exact API
   (`Message` / `SendMessageRequest` objects, client method names).
3. Uncomment `app = build_app()` in each, then run both:
   ```bash
   SC_PORT=9001 uvicorn supply_chain_agent:app --port 9001 &
   SALES_PORT=9002 uvicorn sales_agent:app --port 9002 &
   ```
4. Agent Cards are served at `http://localhost:9001/.well-known/agent.json` and
   `:9002/.well-known/agent.json`.

## Production memory backends

- **Shared session**: swap `SessionMemory._store` for a DynamoDB table or Redis
  (key = `session_id`). Both agents must point at the **same** store.
- **Semantic**: back `SemanticMemory` with a **Bedrock Knowledge Base** (register
  it in the platform Registry as `type=Knowledge Base` and attach via
  `knowledgeRefs`).
- **Audit**: append `AuditMemory` events to a DynamoDB append-only table; forward
  to the platform Audit view.

## Governance

Register both agents + the KB in the platform, author Cedar policy for
who-may-call-whom, and orchestrate the loop as a **Workflow** with a human review
gate. See `PLATFORM_SETUP.md`. Platform URL:
**https://d3nbsv2gfe4ggb.cloudfront.net/app**
