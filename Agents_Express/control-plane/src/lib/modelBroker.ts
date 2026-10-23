// The ONE place a model gets invoked.
//
// Before this module, `api/workflows/route.ts` and `api/a2a/rpc/route.ts` each
// imported `runStepOnBedrock` / `runStepOnDatabricks` and called the provider
// themselves. Two call sites today, and the next feature adds a third — each
// with its own chance of forgetting the allowlist, the audit entry, or the
// plane check. That is how a boundary becomes a suggestion.
//
// Adopted from the EKS workshop's shape: there, the agent pod holds no Bedrock
// permission and a gateway with its own identity is the only route to a model.
// We cannot separate credentials by IAM role inside one Next.js process, so
// the equivalent here is a single enforced chokepoint plus a test asserting
// nothing else imports the provider modules. That test is the real control —
// without it this file is a convention, and conventions drift.
//
// WHAT IT GUARANTEES
//   - the model is in the catalog
//   - the model is on the invoking tenant's allowlist (inherited down the tree)
//   - the declared runtime agrees with where the model is really served
//   - every invocation is audited with tenant, persona, model and outcome
//   - a refusal never reaches a provider, so a denied call costs nothing
//
// Server-only.

import { logAudit, store } from "./store";
import { authorizeModel, type ModelDecision } from "./modelAccess";
import { executorFor } from "./plane";
import { runStepOnBedrock } from "./bedrock";
import { runStepOnDatabricks, runStepOnDatabricksWithTools } from "./databricks";
import type { ToolCallRecord, ToolSpec } from "./tools/registry";
import type { WorkflowStep } from "./types";

/** Raised when the broker refuses. Carries the decision for the caller's trace. */
export class ModelAccessDenied extends Error {
  readonly code = "MODEL_ACCESS_DENIED";
  readonly decision: ModelDecision;
  constructor(decision: ModelDecision) {
    super(decision.reason);
    this.name = "ModelAccessDenied";
    this.decision = decision;
  }
}

export interface BrokerContext {
  /** The tenant whose allowlist governs this call. */
  tenantId: string;
  /** Who the call runs as, for the audit trail. */
  personaId: string;
  /** Where the call came from: "workflow" | "a2a-inbound" | ... */
  origin: string;
  /** The agent, when a call is bound to one. */
  agentId?: string;
  /** The agent's declared model runtime, checked against the model's plane. */
  modelRuntimeId?: string;
}

/**
 * Authorize without invoking.
 *
 * Exported so a caller can check before doing expensive preparation, and so
 * the UI can explain a refusal. Auditing a REFUSAL here is deliberate: a
 * denied model request is exactly the event an operator wants to see, and it
 * is the one the old direct-call paths could not record.
 */
export function authorize(modelId: string, ctx: BrokerContext): ModelDecision {
  const decision = authorizeModel({
    tenantId: ctx.tenantId,
    modelId,
    tenants: store.tenants,
    models: store.models,
    ...(ctx.modelRuntimeId ? { modelRuntimeId: ctx.modelRuntimeId } : {}),
  });
  if (!decision.allowed) {
    logAudit({
      category: "model",
      action: "invoke-denied",
      actor: ctx.personaId,
      detail:
        `DENY ${ctx.origin} model call: ${decision.reason}` +
        (ctx.agentId ? ` (agent ${ctx.agentId})` : ""),
    });
  }
  return decision;
}

export interface BrokeredResult {
  output: string;
  /**
   * The tool calls the model actually made, in order.
   *
   * Carried through rather than reduced to a count: the run trace shows each
   * call and its result, and that is how an operator tells a measured answer
   * from a plausible one. Only the Databricks tool path produces them.
   */
  toolCalls?: ToolCallRecord[];
  toolCallCount: number;
  totalTokens: number;
  latencyMs: number;
  executor: "bedrock" | "databricks";
  resolvedModelId: string;
  notes: string[];
}

/**
 * Run one step against whichever plane serves its model — after authorizing.
 *
 * The executor is derived from the catalog model rather than passed in. A
 * caller that could choose the plane could route a Databricks-served model to
 * Bedrock and get a confusing provider error instead of a governance decision.
 */
export async function invokeStep(
  step: WorkflowStep,
  task: string,
  prior: { name: string; output: string }[],
  tools: ToolSpec[],
  ctx: BrokerContext
): Promise<BrokeredResult> {
  const decision = authorize(step.modelId ?? "", ctx);
  if (!decision.allowed) throw new ModelAccessDenied(decision);

  const model = store.models.find((m) => m.id === step.modelId);
  // authorize() already proved the model exists; this is for the type system
  // and for the impossible case where the store changed underneath us.
  if (!model) throw new ModelAccessDenied(decision);
  const executor = executorFor(model);

  const started = Date.now();
  let output = "";
  let toolCallCount = 0;
  let totalTokens = 0;
  let notes: string[] = [];
  let toolCalls: ToolCallRecord[] | undefined;

  if (executor === "databricks" && tools.length > 0) {
    const r = await runStepOnDatabricksWithTools(step, task, prior, tools);
    output = r.output ?? "";
    toolCalls = r.toolCalls;
    toolCallCount = r.toolCalls?.length ?? 0;
    totalTokens = r.usage?.totalTokens ?? 0;
    notes = r.notes ?? [];
  } else if (executor === "databricks") {
    const r = await runStepOnDatabricks(step, task, prior);
    output = r.output ?? "";
    totalTokens = r.usage?.totalTokens ?? 0;
    notes = r.notes ?? [];
  } else {
    // RunStepResult (Bedrock) carries no `notes` — only the Databricks path
    // reports them. Narrowed per branch rather than widened with a cast.
    const r = await runStepOnBedrock(step, task, prior);
    output = r.output ?? "";
    totalTokens = r.usage?.totalTokens ?? 0;
  }

  const latencyMs = Date.now() - started;
  logAudit({
    category: "model",
    action: "invoke",
    actor: ctx.personaId,
    detail:
      `${ctx.origin} invoked '${model.name}' on ${executor} for tenant ` +
      `'${ctx.tenantId}': ${toolCallCount} tool call(s), ${totalTokens} token(s), ` +
      `${latencyMs}ms, ${output.length} char(s)`,
  });

  return {
    output,
    ...(toolCalls ? { toolCalls } : {}),
    toolCallCount,
    totalTokens,
    latencyMs,
    executor,
    resolvedModelId: model.modelId,
    notes,
  };
}
