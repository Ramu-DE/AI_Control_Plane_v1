# Runbook — Sales ⇄ Supply Chain agents, A2A and memory

A step-by-step build of two collaborating agents in the control plane UI, on
live Databricks data.

**Scenario.** A Sales agent owns demand (who wants what, by when, at what
margin). A Supply Chain agent owns movement (which lane gets it there, how
fast, how reliably). Each needs the other: Supply Chain cannot prioritise
without knowing which orders matter, and Sales cannot promise a date without
knowing what the network can actually do.

Read §0 before clicking anything — two of the steps are not in the UI yet, and
knowing that up front saves you hunting for buttons that do not exist.

---

## 0. What is UI, what is not

| Step | Where |
|---|---|
| Register the model | **UI** — Settings → Model Catalog |
| Publish + approve tool records | **UI** — Registry |
| Create both agents | **UI** — Agents |
| Build and run the workflow | **UI** — Workflows |
| Register the A2A peer | **UI** — A2A |
| **Attach memory to an agent** | **API only** — the Agents form has no memory section yet |
| **Create a Memory registry record** | **API only** — `Memory` is not in the Create Record type list yet |

The memory backend, its Cedar gate and its namespace isolation are all built and
tested; only the two form controls are missing. §6 gives the `curl` for those,
and they are the edits in `SETUP`-style step 2a/2b if you want them in the UI.

---

## 1. The data (already provisioned)

`workspace.scm_demo` in Unity Catalog, with declared primary and foreign keys:

| Table | Owned by | Holds |
|---|---|---|
| `demand_orders` | Sales | 5 open orders: customer, SKU, units, destination, promised date, priority, margin |
| `inventory` | Supply Chain | stock by SKU × warehouse |
| `lanes` | Supply Chain | 8 transport lanes: mode, transit days, cost, capacity |
| `lane_performance` | Supply Chain | observed on-time % and average delay per lane |

**One case in this data is the whole point of the demo.** For Rotterdam →
Frankfurt:

```
LN-ROT-FRA-AIR    1 day    €18.40/unit    71.0% on-time
LN-ROT-FRA-ROAD   3 days   € 4.10/unit    96.5% on-time
```

Air is three times faster and four times the price, and misses its promise
nearly a third of the time. `ORD-1001` (Meridian Health, HIGH, promised
2026-11-05) is the order where that matters. An agent that answers "air is
fastest" has answered the wrong question. The point of two agents is that Sales
holds the promise and Supply Chain holds the reliability, and the answer needs
both.

Verify the data is there — Workflows will fail confusingly if it is not:

```sql
SELECT lane_id, mode, transit_days, cost_per_unit FROM workspace.scm_demo.lanes
WHERE destination = 'Frankfurt';
```

---

## 2. Register the model

**Settings → Model Catalog → add a model.**

| Field | Value |
|---|---|
| Name | `Llama 3.3 70B (Databricks)` |
| Model Provider | `Meta` |
| Model ID | `databricks-meta-llama-3-3-70b-instruct` |
| Inference Provider | `Databricks Model Serving` |

Leave the token field as the **env var name** `DATABRICKS_TOKEN`, not a token.
Records store credential references; nothing in the platform stores a secret.

> If you prefer Bedrock, pick `Amazon Bedrock` and a Claude model id instead.
> Whichever you choose, §3 must match it — a Databricks model with an AWS
> runtime is refused at create time, deliberately.

---

## 3. Publish the tools, then approve them

Both agents read Unity Catalog, so both need the UC tools. A tool is only
attachable once it is an **Approved** registry record.

**Registry → open a registry → Create Record.**

- Type: **MCP**
- Source: **Define manually**
- Name: `uc-readonly`
- Schema: paste this. The names must match exactly — they are what the platform
  maps to real implementations.

```json
{
  "toolSchema": [
    { "name": "uc_list_tables",
      "description": "List tables in a Unity Catalog schema",
      "inputSchema": { "type": "object",
        "properties": { "catalog": {"type":"string"}, "schema": {"type":"string"} } } },
    { "name": "uc_describe_table",
      "description": "Describe one Unity Catalog table's columns and types",
      "inputSchema": { "type": "object",
        "properties": { "fullName": {"type":"string"} } } },
    { "name": "uc_query",
      "description": "Run ONE read-only SQL statement against Unity Catalog",
      "inputSchema": { "type": "object", "properties": { "sql": {"type":"string"} } } }
  ]
}
```

Then move it through the gate: **Draft → Pending approval → Approved**.

Two things worth doing deliberately here, because they are the governance story:

- Try attaching it to an agent while it is still Draft. It is refused.
- Try moving Draft straight to Approved. The transition table refuses that too.

`uc_query` is read-only by construction — writes and DDL are rejected before any
network call, so neither agent can mutate the warehouse.

---

## 4. Create the two agents

**Agents → Create Agent**, twice. Both use the model from §2 and the approved
tool record from §3.

### 4a. Sales agent

| Field | Value |
|---|---|
| Agent name | `Sales Agent` |
| Tenant / Business Unit | `fn-supply` *(or your BU — note it, §5 must match)* |
| Model | `Llama 3.3 70B (Databricks)` |
| Agent execution runtime | `Agent Runtime on Databricks Apps` |
| Model inference runtime | `Foundation Model APIs — Pay per token` |
| Tools | ✅ `uc-readonly` |

System prompt:

```
You are the Sales Agent. You own DEMAND: which orders exist, how urgent they
are, what margin they carry, and what date was promised to the customer.

Your data is workspace.scm_demo.demand_orders. Query it with uc_query; never
guess an order, a date or a margin.

You do NOT own transport. You do not know transit times or lane reliability.
When a delivery decision depends on those, say which orders matter and why,
and state what you need from the Supply Chain Agent.

Rules:
- A promised date is a commitment. Say plainly when a plan would miss one.
- Rank by priority then margin at risk, and show the numbers you ranked on.
- If a tool result says it was truncated, do not treat it as complete. Re-query
  with an aggregate instead.
```

### 4b. Supply Chain agent

Same model, runtime and tools. Name `Supply Chain Agent`, same tenant.

```
You are the Supply Chain Agent. You own MOVEMENT: which lane carries goods from
a warehouse to a destination, how long it takes, what it costs, and how often it
actually arrives on time.

Your data is workspace.scm_demo.inventory, lanes and lane_performance. Query it
with uc_query; never guess a transit time or a reliability figure.

FASTEST IS NOT THE SAME AS BEST. A lane with a 1-day transit and 71% on-time
performance will miss the promise roughly one time in three. Always report
transit_days AND on_time_pct together, and recommend against a fast unreliable
lane when the promised date leaves no slack.

You do NOT own customer priority or margin. When a trade-off depends on which
order matters more, say so and state what you need from the Sales Agent.

Rules:
- Check inventory at the origin before proposing a lane; stock you do not have
  cannot ship.
- Give cost per unit and total cost, so the expensive option is visible.
- If a tool result says it was truncated, re-query with an aggregate.
```

Both prompts say what the agent does **not** know. That is what makes the A2A
call necessary rather than decorative — an agent that will confidently answer
outside its own data has no reason to ask a peer.

---

## 5. The workflow

**Workflows → Create Workflow.** Name it `Fulfilment decision`, tenant as §4.

Three steps, each bound to an agent (pick the agent, not a bare model, so the
step inherits its prompt and tools):

| # | Step name | Agent | Review gate | Prompt |
|---|---|---|---|---|
| 1 | `Demand signal` | Sales Agent | off | `List the open orders for this request. For each: priority, units, destination, promised date, and margin at risk. Rank them and show the numbers.` |
| 2 | `Delivery options` | Supply Chain Agent | off | `For the destinations above, find every viable lane. Report transit_days, cost_per_unit, total cost and on_time_pct for each. Flag any lane whose reliability puts the promised date at risk.` |
| 3 | `Fulfilment plan` | Sales Agent | **on** | `Decide the plan. For each order state the lane, the expected arrival against the promised date, the cost, and the reliability risk accepted. Where you chose a slower lane, say why.` |

Run it with input:

```
Meridian Health needs ORD-1001 by its promised date. What is the best way to
fulfil it, and what does it cost us?
```

Pick a persona when you start it — a run without one is refused, because the
Cedar `runAgent` check needs a principal.

**What to look for in the run:**

- Step 2 should return *both* the 1-day/71% air lane and the 3-day/96.5% road
  lane. If it only returns the fastest, the prompt's reliability rule is not
  landing.
- Step 3 is where the two viewpoints collide. A good answer picks road and
  explains the slack; a lazy one picks air because it is fastest.
- The step trace shows **tool calls**. If a step has none, its answer was
  invented rather than measured — that distinction matters more than the prose.
- Step 3 pauses at the review gate. Approve it, and check **Audit** for the
  decision.

---

## 6. A2A between the two agents

§5 is orchestration: the *workflow* passes step 2's output into step 3. A2A is
different — one agent calls the other **directly**, mid-reasoning, because it
has hit the edge of what it knows.

### Register the peer — UI

**A2A → add a peer.**

| Field | Value |
|---|---|
| Name | `Supply Chain Agent` |
| Base URL | the peer's HTTPS base (its card is served at `/.well-known/agent-card.json`) |
| Auth | `Bearer (env var)` → `SUPPLY_CHAIN_AGENT_TOKEN`, or `None` for a local peer |

Then **Discover** to fetch the card, and **Send** a message to test it.

The card is a trust boundary: only known fields are kept, and anything else the
peer sends is dropped rather than trusted.

### Authorize it — API

Registering a peer does not grant the right to call it. Add a scoped Cedar
policy (Policies page, or API). Until one exists the perimeter policy governs:

```
permit(
  principal,
  action == Action::"callAgent",
  resource == Tool::"a2a:<peerId>"
) when { principal.role == "director" };
```

### The thing that will bite you: mutual calls

Your scenario is **bidirectional** — Sales calls Supply Chain, and Supply Chain
calls Sales. Without a bound, two agents that each delegate when uncertain will
call each other until something times out, and the failure looks like latency
rather than a loop.

Enforce a **hop budget**, and enforce it on the receiving side:

- A top-level request starts with `hops_remaining: 2`.
- Every agent **decrements it before delegating**, and refuses to delegate at 0
   — at zero it must answer from its own data and say what it could not confirm.
- The receiver decrements and checks; it never trusts the number the caller
  sent, because a buggy or hostile caller would simply send a large one.

A hop budget of 2 is enough for this scenario: Sales → Supply Chain → Sales.
Anything deeper means the agents are negotiating, which is a workflow's job, not
a call chain's.

---

## 7. Memory for multi-agent orchestration

Without memory each run starts cold: the agents re-derive the same lane
reliability and re-ask the same preferences every time. With it, the second run
of the week knows that Meridian Health always wants EUR and that the Frankfurt
air lane has missed twice.

**The design question that matters: whose memory is it?**

AgentCore namespaces are keyed on `actorId`, so two agents are two actors and
get two separate namespaces by default. That is right for what an agent learns,
and wrong for what a *run* needs to share. So use three planes, and model the
shared subject as the actor:

| Plane | `actorId` | Scope | Holds | Who writes |
|---|---|---|---|---|
| **Shared working** | `<tenant>__order-ORD-1001` | session | the demand signal, the lane options, the chosen plan | both, but see ownership below |
| **Agent learning** | `<tenant>__agent-sales` / `__agent-supplychain` | actor | durable lessons: "Meridian wants EUR", "ROT→FRA air missed twice" | that agent only |
| **Audit** | — | — | who decided what, and under which policy | the platform |

**The order is the actor.** That is the non-obvious move. An actor does not have
to be a person: making `ORD-1001` the actor gives both agents one namespace they
genuinely share, with the tenant still in the path so isolation holds. It
replaces an in-process session dictionary with something durable and governed.

**Audit is not memory.** Memory is for recall and is allowed to forget; audit is
for proof and is not. Keep them apart, or you will eventually prune the evidence.

### Write ownership — the rule that prevents conflicting truth

Both agents writing the same namespace produces two disagreeing facts about the
same thing, and consolidation then has to pick one. So give every fact type
exactly one owner:

- **Sales writes** demand, priority, margin, promised dates, customer
  preferences.
- **Supply Chain writes** lanes, transit, cost, reliability, inventory.
- **Neither writes the other's.** If Supply Chain thinks a priority is wrong, it
  says so in its reply; it does not overwrite Sales' fact.

### Reading each other's data — two routes, different purposes

- **Live facts → A2A.** "What is the on-time rate on this lane right now?" Ask
  the agent. Memory may be stale, and extraction is asynchronous.
- **Durable preferences → memory.** "This customer always wants EUR." Read it;
  do not make the peer re-derive it every run.

### Wiring it (API, until step 2a/2b lands)

**1. Publish the memory record** — one shared-working, one per-agent:

```bash
API=http://localhost:3000/api      # add /proxy/3000 if BASE_PATH is set

curl -s -X POST $API/registry -H 'Content-Type: application/json' -d '{
  "kind":"record","registryId":"<your-registry-id>","type":"Memory",
  "recordSource":"define-manually","name":"Order working memory",
  "credentialType":"IAM Role",
  "memoryConfig":{
    "ownerTenantId":"fn-supply",
    "memoryId":"agentexpress_governed_memory-V12Zou4Dkx",
    "region":"us-west-2",
    "strategyId":"semantic-LYRQAaHrU6",
    "namespaceTemplate":"/agentexpress/strategy/semantic/actor/{actorId}/session/{sessionId}",
    "topK":5,"eventExpiryDays":30}}'
```

For the **agent-learning** plane use the actor-scoped strategy instead —
`preferences-Hdonr69lbC` with template
`/agentexpress/strategy/preferences/actor/{actorId}`. The template decides the
scope: one ending in `/session/{sessionId}` serves a single run, one ending at
`/actor/{actorId}` serves that actor across every run.

**2. Approve it**, same gate as a tool:

```bash
for s in "Pending approval" "Approved"; do
  curl -s -X PATCH $API/registry -H 'Content-Type: application/json' \
    -d "{\"id\":\"<recordId>\",\"status\":\"$s\"}"
done
```

**3. Write and read.** Note `tenantId` and `personaId` are what build the
namespace — you never pass a namespace in:

```bash
# Supply Chain records what it found
curl -s -X POST $API/memory -H 'Content-Type: application/json' -d '{
  "op":"write","recordId":"<recordId>","personaId":"persona-john",
  "tenantId":"fn-supply","sessionId":"ORD-1001","turns":[
    {"role":"USER","text":"Which lane for ORD-1001 to Frankfurt?"},
    {"role":"ASSISTANT","text":"ROT-FRA road: 3 days, EUR 4.10/unit, 96.5% on-time. Air is 1 day but 71% on-time, which puts the 05 Nov promise at risk."}]}'

# Sales reads it back
curl -s -X POST $API/memory -H 'Content-Type: application/json' -d '{
  "op":"retrieve","recordId":"<recordId>","personaId":"persona-john",
  "tenantId":"fn-supply","sessionId":"ORD-1001",
  "query":"Which lane was chosen for ORD-1001 and why?"}'
```

### Four things that will waste your time if you do not know them

1. **The first read returns nothing.** Long-term extraction is asynchronous and
   took about 75 seconds in testing. Write-then-immediately-read is empty. That
   is not a bug.
2. **A session-scoped record never recalls across runs.** If you want the second
   run to remember the first, attach the **actor-scoped** record.
3. **Attach the memory to an agent via the API**, because the Agents form has no
   memory control yet. And note the workflow runner does not call memory
   automatically — today you read and write it explicitly.
4. **A Draft memory is refused** with a clear message, exactly like a Draft tool.

---

## 8. Checks that tell you it actually works

| Check | Where | Pass |
|---|---|---|
| Steps called real tools | Workflow step trace | `toolCalls` present with `uc_query` |
| Answers are measured, not invented | Step output | real lane ids and on-time figures appear |
| Reliability was weighed | Step 3 | the air/road trade-off is named, not ignored |
| Governance held | Audit | `agent`, `registry`, `policy`, `memory` entries |
| Truncation was honest | Step trace | a truncated tool result is labelled, not silently partial |
| Tenant isolation | Memory response | `namespace` contains `actor/<tenant>__…`, `outOfScope: 0` |

If step 3 recommends air purely because it is fastest, the agents are not
actually disagreeing — tighten the Supply Chain prompt's reliability rule and
re-run. That one behaviour is the difference between two agents and one agent
called twice.

---

## 9. Current limits — worth knowing before you demo

- **Memory has no UI.** No page, no sidebar entry, no attachment control.
  API-only.
- **The workflow runner does not use memory yet.** Recall is a capability the
  platform governs; nothing calls it automatically during a run.
- **A2A peers must be reachable over HTTPS.** A locally-run peer needs a tunnel,
  or register it with auth `None` against a local base URL.
- **State is in memory.** Agents, workflows and records vanish when the dev
  server restarts. Build your demo data immediately before presenting.
- **No authentication on the control plane.** Anyone with the URL is an admin.
