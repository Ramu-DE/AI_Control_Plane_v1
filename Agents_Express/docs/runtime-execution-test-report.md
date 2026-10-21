# Agent execution runtime types — test report

**Date:** 2026-10-21 · **Scope:** every runtime id in `control-plane/src/lib/runtimes.ts`
**Credentials used:** Databricks workspace PAT (admin), AWS instance role (us-west-2)
**Workspace:** `dbc-59bdc3b9-a35a.cloud.databricks.com` · id `7474660543828156` · user in `admins`

---

## Headline finding

All **23** runtime ids validate and persist correctly on an agent. **None of them is an
execution target.** `AgentConfig.compute` is written by the create API, normalized in the
store, and rendered in the UI — it is **never read at execution time**. Workflow steps call
`runStepOnBedrock()` unconditionally, so every agent executes on Amazon Bedrock Converse
regardless of the runtime pair selected.

Evidence (`grep -rn "\.compute\b" src/`) — the only consumers are:

| Location | Use |
|---|---|
| `app/agents/page.tsx:259,264,279,284` | the create form's two selects |
| `app/agents/page.tsx:397` | the detail view's "Runtime Topology" tab |
| `lib/store.ts:934` | hot-reload normalization of legacy shapes |
| `api/agents/route.ts:101` | applying the default when omitted |

No execution path reads it. So runtime selection is **governed metadata**, not placement.

---

## Method

1. `GET /api/runtimes` to enumerate the catalog (7 agentic-workload + 16 model-inference).
2. For each id, `POST /api/agents` against the `takeda` tenant (pro, maxAgents 50) and
   confirm HTTP 201 and that the value round-tripped.
3. Negative cases: swapped planes, unknown id, omitted `compute`.
4. Probe the **real** provider behind each runtime family with the supplied credentials.
5. Execute real inference wherever a reachable engine existed.

---

## 1. Engine acceptance — 23/23 ✅

Every id was accepted and stored verbatim.

| Plane | Runtime id | API | Stored |
|---|---|---|---|
| agentic-workload | `aws-agentcore-runtime` | 201 | ✅ |
| agentic-workload | `aws-lambda` | 201 | ✅ |
| agentic-workload | `aws-ecs` | 201 | ✅ |
| agentic-workload | `aws-eks` | 201 | ✅ |
| agentic-workload | `databricks-agent-runtime` | 201 | ✅ |
| agentic-workload | `databricks-apps-custom` | 201 | ✅ |
| agentic-workload | `databricks-lakeflow-jobs-agent` | 201 | ✅ |
| model-inference | `aws-bedrock` | 201 | ✅ |
| model-inference | `aws-sagemaker-ai` | 201 | ✅ |
| model-inference | `aws-eks-models` | 201 | ✅ |
| model-inference | `databricks-fm-api-pay-per-token` | 201 | ✅ |
| model-inference | `databricks-fm-api-provisioned` | 201 | ✅ |
| model-inference | `databricks-custom-serving-cpu` | 201 | ✅ |
| model-inference | `databricks-custom-serving-gpu` | 201 | ✅ |
| model-inference | `databricks-ai-runtime-standard` | 201 | ✅ |
| model-inference | `databricks-ai-runtime-ai` | 201 | ✅ |
| model-inference | `databricks-runtime-ml-cpu` | 201 | ✅ |
| model-inference | `databricks-runtime-ml-gpu` | 201 | ✅ |
| model-inference | `databricks-runtime-ml-photon` | 201 | ✅ |
| model-inference | `databricks-runtime-ml-lts` | 201 | ✅ |
| model-inference | `databricks-runtime-standard` | 201 | ✅ |
| model-inference | `databricks-runtime-photon` | 201 | ✅ |
| model-inference | `databricks-runtime-lts` | 201 | ✅ |

**Negative cases all behave correctly:**

| Case | Result |
|---|---|
| planes swapped (`aws-bedrock` in the agent slot) | **400** — *"compute must contain a valid agentRuntimeId and modelRuntimeId"* |
| unknown id (`made-up`) | **400** — same |
| `compute` omitted | **201**, defaulted to `aws-agentcore-runtime` + `aws-bedrock` |

---

## 2. Does a real backing capability exist? (probed, not assumed)

### Databricks — workspace reachable, PAT admin ✅

| Catalog runtime | Probe | Finding |
|---|---|---|
| `databricks-fm-api-pay-per-token` | `GET /api/2.0/serving-endpoints` | ✅ **12 endpoints, all `READY`** |
| `databricks-fm-api-provisioned` | same | ⚠️ none provisioned (all 12 are system pay-per-token) |
| `databricks-custom-serving-cpu` / `-gpu` | same | ⚠️ no custom model endpoints exist |
| `databricks-agent-runtime` | `GET /api/2.0/apps` | ⚠️ API present, **0 apps** |
| `databricks-apps-custom` | same | ⚠️ 0 apps |
| `databricks-lakeflow-jobs-agent` | `GET /api/2.1/jobs/list` | ⚠️ **0 jobs** |
| `databricks-runtime-ml-cpu` | `clusters/spark-versions` | ✅ 27 ML CPU versions |
| `databricks-runtime-ml-gpu` | same | ✅ 9 ML GPU versions |
| `databricks-runtime-ml-photon` | same | ✅ 18 Photon versions |
| `databricks-runtime-ml-lts` | same | ✅ 21 LTS+ML (e.g. `16.4.x-cpu-ml-scala2.12`) |
| `databricks-runtime-standard` / `-photon` / `-lts` | same | ✅ 47 versions total, 37 LTS |
| `databricks-ai-runtime-standard` / `-ai` | no public API | ❓ **not probeable** — serverless GPU AI Runtime has no list API; cannot confirm entitlement |

Also present: **1 SQL warehouse** (Serverless Starter, `STOPPED`), **0 clusters**, UC catalogs
`workspace` / `samples` / `system`.

The 12 live Foundation Model endpoints:

```
chat        databricks-meta-llama-3-3-70b-instruct   databricks-meta-llama-3-1-8b-instruct
            databricks-gpt-oss-120b                  databricks-gpt-oss-20b
            databricks-qwen3-next-80b-a3b-instruct   databricks-qwen35-122b-a10b
            databricks-gemma-3-12b                   databricks-llama-4-maverick
            databricks-deepseek-v4-flash-0731
embeddings  databricks-gte-large-en                  databricks-bge-large-en
            databricks-qwen3-embedding-0-6b
```

### AWS — instance role, us-west-2

| Catalog runtime | Probe | Finding |
|---|---|---|
| `aws-bedrock` | `list-foundation-models` | ✅ **120 models** |
| `aws-agentcore-runtime` | `bedrock-agentcore-control list-agent-runtimes` | ⚠️ **0 runtimes** |
| `aws-lambda` | `list-functions` | ✅ **5 functions** |
| `aws-ecs` | `list-clusters` | ⚠️ 0 clusters |
| `aws-eks` / `aws-eks-models` | `list-clusters` | ⚠️ 0 clusters |
| `aws-sagemaker-ai` | `list-endpoints` | ⚠️ 0 endpoints |

---

## 3. Real execution performed ✅

### Databricks Foundation Model APIs — pay-per-token

```
POST /serving-endpoints/databricks-meta-llama-3-3-70b-instruct/invocations
  -> HTTP 200   reply: "RUNTIME OK"
     usage: prompt 42, completion 4, total 46

POST /serving-endpoints/databricks-gpt-oss-120b/invocations
  -> HTTP 200   reply: reasoning-format content
     usage: prompt 108, completion 12, total 120

POST /serving-endpoints/databricks-gte-large-en/invocations
  -> HTTP 200   embedding dim 1024
```

### Amazon Bedrock

- Converse: workflow step returned `STEP OK`, 43 tokens, 745 ms, $0.0000536
- Titan Text Embeddings V2: 1024 dims, L2 norm 1.0000

**Not executed** (no deployed target exists to execute on): AgentCore Runtime, Lambda-as-agent,
ECS, EKS, SageMaker endpoints, Databricks Apps, Lakeflow Jobs, provisioned throughput,
custom model serving, serverless GPU AI Runtime.

---

## 4. Second finding — silent model substitution ⚠️

A workflow step referencing catalog model `model-gpt-oss-120b`
(`modelId: "bedrock-mantle/openai.gpt-oss-120b"`, provider *AgentCore Gateway*) **executed on
`us.anthropic.claude-haiku-4-5-20251001-v1:0`** and reported `status: done` with no warning.

Cause: `lib/bedrock.ts` → `toInferenceProfileId()` returns the `KNOWN_GOOD` haiku profile for
any upstream id that neither starts with `us.` nor matches `/opus|sonnet|haiku/`. The run's
cost and token figures are therefore attributed to a model the operator did not choose.

This matters here because **`openai.gpt-oss-120b` genuinely exists in this workspace** as
`databricks-gpt-oss-120b` and responds — so the platform substitutes a different model while a
working one is reachable.

Suggested fix: fail the step with an explicit "no route for model X" error instead of silently
falling back, and record the requested-vs-resolved pair on the `StepRun`.

---

## 5. To make runtime selection actually mean something

The cheapest high-value increment is a **Databricks serving executor**, because the engine is
already live and proven:

1. Add `inferenceProvider: "Databricks Model Serving"` to `CatalogModel`, carrying the
   workspace host + endpoint name.
2. Add `lib/databricks.ts` with `runStepOnDatabricks()` — `POST /serving-endpoints/<name>/invocations`,
   OpenAI-shaped `messages`, mapping `usage` onto `TokenUsage` (the fields line up already).
3. In `api/workflows/route.ts`, dispatch on the step model's `inferenceProvider` instead of
   always calling `runStepOnBedrock`.
4. Resolve the PAT by reference (`DATABRICKS_TOKEN` env or a Secrets Manager ARN) — never on
   the record, matching the Neo4j and Qdrant patterns.
5. Only then make `compute.modelRuntimeId` select the executor, so the field stops being
   decorative.

Agentic-workload placement (ECS/EKS/Lambda/Apps/Jobs) is a genuine deployment concern and
needs infrastructure, not a control-plane change — it should stay declarative until there is a
deployer.

---

---

# Round 2 — real Databricks execution (after building the executor)

A Databricks executor was built so the runtime field stops being decorative:
`lib/databricks.ts` + provider dispatch in `api/workflows/route.ts` +
`"Databricks Model Serving"` on `CatalogModel` + a plane-agreement guard in
`api/agents/route.ts`.

## Hard workspace constraint discovered

```
POST /api/2.1/jobs/create  (new_cluster: 16.4.x-cpu-ml-scala2.12)
-> HTTP 400 INVALID_PARAMETER_VALUE
   "Only serverless compute is supported in the workspace."
```

**This workspace cannot launch classic clusters at all.** That invalidates a Round 1
reading: `clusters/spark-versions` returning 47 versions (27 ML CPU, 9 ML GPU, 18 Photon,
37 LTS) is a *platform availability catalog*, **not** a workspace entitlement. The 41 GPU
node types are likewise unusable here.

Therefore `databricks-runtime-ml-cpu|gpu|photon|lts` and
`databricks-runtime-standard|photon|lts` — all 7 classic-compute runtimes — **cannot be
executed on in this workspace**, regardless of the control plane.

## Executed for real ✅

| Runtime | Evidence |
|---|---|
| `databricks-fm-api-pay-per-token` | 3-step workflow, each step on a **different** live endpoint, **713 tokens total**, run `completed` |
| `databricks-lakeflow-jobs-agent` | Job `787741892511133`, run `TERMINATED/SUCCESS` on **serverless**, 37 s, real UC data returned |

Workflow step attribution (`StepRun.modelId`) now records where execution happened:

```
[Extractor] databricks:databricks-meta-llama-3-3-70b-instruct   151 tok   791ms
[Analyst]   databricks:databricks-qwen3-next-80b-a3b-instruct   181 tok   808ms
[Reviewer]  databricks:databricks-gpt-oss-120b                  381 tok   675ms
```

Job output (real notebook return value, real UC read):

```
python 3.12.3 | aarch64 | pyspark 4.3.0.dev0
sklearn 1.7.2 | mlflow 3.12.0 | torch MISSING(ModuleNotFoundError)
row_count 4 | by_area {Oncology: 365000.0, Cardiology: 318000.0, Neurology: 61000.0}
status RUNTIME PROBE OK
```

Note `torch` is absent from the serverless job environment — serverless is **not** a
substitute for Runtime ML when GPU/DL libraries are needed.

## Assets created in Databricks

| Asset | Identifier |
|---|---|
| UC table (sample data, 4 rows) | `workspace.default.agentexpress_suppliers` |
| Notebook | `/Users/palapalle.lokesh18@gmail.com/agentexpress_runtime_probe` |
| Job | `AgentExpress_Runtime_Probe` (`787741892511133`) |
| SQL warehouse | existing `Serverless Starter Warehouse` started (leave or stop it) |

Created in the control plane: registry `Databricks_Runtime_Registry` with 3 approved
records, 3 Databricks catalog models, 3 agents on Databricks runtime pairs.

## Blocked — needs your decision

Creating a **Databricks App** (`databricks-agent-runtime`, `databricks-apps-custom`) and a
**provisioned-throughput endpoint** (`databricks-fm-api-provisioned`) was refused by this
session's permission classifier. Both provision billable, long-lived compute. Custom model
serving (`databricks-custom-serving-cpu|gpu`) was not attempted for the same reason — it
additionally needs a UC-registered MLflow model.

`databricks-ai-runtime-standard|ai` (serverless GPU) remains **unverifiable**: no list API,
and the workspace exposes no entitlement endpoint.

## Fixes shipped in this round

1. **Silent model substitution fixed.** `toInferenceProfileId()` now throws
   `MODEL_UNROUTABLE` instead of quietly running an unrecognized model on haiku. Verified:
   `bedrock-mantle/openai.gpt-oss-120b` → REFUSED; `us.*` / `global.*` pass through;
   a sonnet-family name still maps correctly.
2. **`compute.modelRuntimeId` is now enforced** against the model's serving plane — a
   Databricks model with `aws-bedrock` is rejected (HTTP 400), and vice versa.
3. **`costUsd` is `null` for Databricks**, not a fabricated figure (DBU billing); tokens
   are real and still accumulate.
4. **Type-only import fixed** in `lib/bedrock.ts` (same class of issue as `store.ts` /
   `evaluator.ts`) so the module loads under Node's strip-only TS loader.

## Final state

Tests **176/176**, typecheck clean, production build OK.

---

## Notes

- The 26 agents created by this test live in the in-memory store and disappear on restart.
- `LTS: 0` appeared in a first pass because Databricks marks LTS in the version **name**, not
  the key; re-probed on `name`, there are 37 LTS versions.
- The PAT, the Qdrant API key and the Neo4j password have all been exposed in a chat
  transcript during this work. **Rotate all three.**
