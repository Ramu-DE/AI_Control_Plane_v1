# Configuring the Agent Management Platform for Sales ↔ Supply Chain A2A

Platform URL: **https://d3nbsv2gfe4ggb.cloudfront.net/app**

This guide maps the Sales ↔ Supply Chain A2A system onto the control plane's
screens. The platform **governs and orchestrates**; the live A2A servers and
memory stores run outside it (see `ARCHITECTURE.md` §5).

> Reminder: in the demo app, Cedar / AVP / Cognito are **simulated** and
> persistence is **in-memory** (resets on restart). **Workflow execution and
> Playground responses call Bedrock for real.**

---

## Step 1 — Tenant (`/tenants`)

Create a tenant to scope everything (agents, policies, budgets).

- Suggested: under a Business Unit (e.g., **Commercial**) create a sub-unit
  **"Supply & Sales"**.
- Tier: `pro` (silo) if you want dedicated isolation; `basic` (pool) for a shared demo.

Every object below is scoped to this tenant.

---

## Step 2 — Model catalog (`/settings` → Models)

Confirm a catalog model exists that maps to a Bedrock Claude inference profile, e.g.:

- **Claude Haiku** → `us.anthropic.claude-haiku-4-5-20251001-v1:0` (cheap, default)
- **Claude Sonnet** → `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
- **Claude Opus** → `us.anthropic.claude-opus-4-5-20251101-v1:0`

Agents and workflow steps reference these catalog models.

---

## Step 3 — Registry (`/registry`)

1. **Create Registry** → name `SupplyNet_Registry`
   (Must start with a letter; letters/numbers/underscores only.)
   - Toggle **Auto-approve records** ON for a fast demo, or leave OFF to walk the
     Draft → Pending → Approved lifecycle.

2. Add **two records of type `Agent`** (one per A2A agent):

   | Field | SalesAgent | SupplyChainAgent |
   |---|---|---|
   | Type | Agent | Agent |
   | Record source | Synchronize from endpoint | Synchronize from endpoint |
   | Endpoint | `https://<sales-host>/` (serves `/.well-known/agent.json`) | `https://<sc-host>/` |
   | Credential type | IAM Role / OAuth / API key | IAM Role / OAuth / API key |

   Submit each for approval (or rely on Auto-approve).

3. Add a **Knowledge Base record** for long-term/semantic memory:
   - Type `Knowledge Base`, provider **Bedrock Knowledge Base**
   - Connection = your `knowledgeBaseId` (e.g., `KB1A2B3C4D`), region `us-east-1`
   - This is the governed **semantic memory** tier.

---

## Step 4 — Agents (`/agents`)

Create the two declarative agents, each scoped to the **Supply & Sales** tenant.

**SalesAgent**
- Model: Claude (from catalog)
- System prompt: *"You are the Sales agent. Balance demand vs supply and return a
  fulfilment plan that maximizes sales given delivery constraints."*
- `toolRefs`: the approved **SupplyChainAgent** record (so Sales may read SC)
- `knowledgeRefs`: the approved **Bedrock KB** record
- Visibility: public (so Playground/Workflows can reach it)

**SupplyChainAgent**
- Model: Claude (from catalog)
- System prompt: *"You are the Supply Chain agent. Pick the fastest viable delivery
  mechanism point-to-point given demand priority."*
- `toolRefs`: the approved **SalesAgent** record (so SC may use Sales)
- `knowledgeRefs`: the approved **Bedrock KB** record
- Visibility: public

This is where you declare **"Supply Chain may use Sales"** and vice-versa.

---

## Step 5 — Policies (`/policies` → Policy Library) + Engine (`/policy-engines`)

Author the governed "who-may-call-whom" perimeter for the A2A links using the
NL→Cedar composer.

Example natural-language intents (the composer turns these into Cedar):

- *"Permit SupplyChainAgent to invoke SalesAgent skill fulfilment_plan."*
- *"Permit SalesAgent to read SupplyChainAgent skill route_optimize."*
- *"Forbid any agent outside the Supply & Sales tenant from invoking either agent."*

Then:
1. **Publish** each policy.
2. Go to **Policy Engines**, create an engine, **import** these policies, attach a
   gateway in **Enforce** mode, and **Sync**.

(In the demo these evaluate via the built-in Cedar simulator; in production this
maps to real AgentCore Policy at the gateway.)

---

## Step 6 — Workflow (`/workflows`) — the fastest real demo

Model the Sales ↔ Supply Chain loop as a multi-step workflow with **real Bedrock
execution** and **human gates**. This is the one place the platform actually runs
your agents' reasoning on Bedrock today.

Suggested steps (scoped to the tenant):

1. **Demand Intake** — model: Claude; agent: Sales
   prompt: *"Extract demand, product, origin, destination, and priority from the request."*
2. **Route Optimize** — model: Claude; agent: Supply Chain; **review gate: ON**
   prompt: *"Given the demand priority, choose the fastest viable point-to-point
   delivery mechanism and estimate ETA."*
3. **Fulfilment Plan** — model: Claude; agent: Sales
   prompt: *"Using the optimized delivery, produce a fulfilment plan that maximizes
   sales within delivery constraints."*

Run it with an input like:
> *"Fulfil demand for 5,000 units of Product P from DC-Atlanta to Region-West,
> fastest viable; customer SLA is 72h."*

The run executes real Bedrock calls, pauses at the **Route Optimize** gate for
human **approve / revise / deny**, then completes — with token usage, latency, and
estimated cost captured per step.

---

## Step 7 — Playground + Audit

- **Playground** (`/playground`): test persona-scoped calls against the agents and
  see the authorization decision (allow/deny) with a real Bedrock response on allow.
- **Audit** (`/audit`): review the attributable trail of every step and decision.

---

## Mapping summary

| A2A concept | Platform screen | Object |
|---|---|---|
| Agent identity/capabilities | Registry | `type=Agent` record (+ endpoint) |
| Declarative agent (model/prompt/links) | Agents | AgentConfig (toolRefs, knowledgeRefs, tenant) |
| Long-term/semantic memory | Registry | `type=Knowledge Base` record → `knowledgeRefs` |
| Who-may-call-whom | Policy Library + Engine | Cedar policies (Enforce) |
| Orchestrated Sales↔SC run (real Bedrock) | Workflows | Workflow + steps + review gate |
| Identity simulation / testing | Playground | Persona evaluation |
| Attributable trail | Audit | AuditEvent stream |
| Tenant scope / limits | Tenants | Tenant (tier, isolation) |

---

## What this does **not** do (build outside)

- Host the live A2A servers (run the Python in `src/`).
- Provide shared session/episodic memory stores (DynamoDB/Redis) — run your own.
- Enforce real Cedar/identity — the demo simulates; production wiring per
  `ARCHITECTURE.md` §5 and the repo's `production-readiness-plan.md`.
