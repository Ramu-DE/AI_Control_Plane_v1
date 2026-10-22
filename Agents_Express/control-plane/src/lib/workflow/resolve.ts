// Resolve a workflow step into the configuration that will actually execute.
//
// This is the join between the platform's two halves. Until now `/agents` held
// governance (approval, tenancy, Cedar, runtime topology) while `/workflows`
// held execution, and neither referenced the other. A step may now name an
// `agentId`, in which case the step INHERITS that agent's model, system prompt,
// toolRefs and knowledgeRefs, and the agent's `compute.modelRuntimeId` chooses
// the executor.
//
// Pure and deterministic: it reads the passed-in collections, performs no I/O,
// and fails closed with typed errors so the route maps them to honest statuses.

import { selectTools } from "../tools/registry";
import { narrowTools } from "../tools/discover";
import { agentEligibleForWorkflow } from "./eligibility";
import { executorFor, planeMismatch } from "../plane";
export { executorFor } from "../plane";
import type { ToolSpec } from "../tools/registry";
import type {
  AgentConfig,
  CatalogModel,
  RegistryRecord,
  Tenant,
  WorkflowStep,
} from "../types";

export class StepResolutionError extends Error {
  readonly code = "STEP_UNRESOLVABLE";
  constructor(message: string) {
    super(message);
    this.name = "StepResolutionError";
  }
}

/** Which execution plane a catalog model routes to. */
export type Executor = "bedrock" | "databricks";


export interface ResolvedStep {
  /** The step as the executor should see it: model + composed prompt. */
  step: WorkflowStep & { modelId: string };
  executor: Executor;
  catalogModel: CatalogModel;
  agent: AgentConfig | null;
  /** Approved KB record ids this step may ground on. */
  knowledgeRefs: string[];
  /** Tool NAMES the agent is permitted to use (approved records only). */
  resolvedTools: string[];
  /** Of those, the ones the platform can REALLY execute — offered to the model. */
  executableTools: ToolSpec[];
  notes: string[];
}

export interface ResolveContext {
  agents: AgentConfig[];
  models: CatalogModel[];
  records: RegistryRecord[];
  tenants: Tenant[];
  /** The owning workflow's tenant, for cross-tenant checks. */
  workflowTenantId: string;
}

/**
 * Compose the prompt for an agent-bound step.
 *
 * The agent's system prompt establishes the persona; the step's prompt is the
 * instruction for this stage. Both are kept, in that order, so a governed
 * agent's instructions cannot be silently dropped by a step.
 *
 * TODAY'S DATE IS INJECTED, because a model has no clock and these agents are
 * asked about dates constantly — lead times, promise dates, ETAs. Without it a
 * supply agent asked "can we hit 2026-11-07 against a 10-day lead time?" has to
 * invent today in order to answer, and does: observed live, it replied
 * "2026-11-17, which is 10 days from today" — wrong arithmetic from a guessed
 * baseline, stated with total confidence. The instruction to say so when a date
 * is missing is not enough on its own; the date has to actually be there.
 *
 * `now` is a parameter so the composition stays pure and testable.
 */
export function composePrompt(
  agentSystemPrompt: string,
  stepPrompt: string,
  now: Date = new Date()
): string {
  const a = (agentSystemPrompt || "").trim();
  const s = (stepPrompt || "").trim();
  const today = now.toISOString().slice(0, 10);
  const clock =
    `Today's date is ${today} (UTC). Use it for any relative date — do not ` +
    `assume a different one, and show the arithmetic when you compute a date.`;
  const body = a && s ? `${a}\n\n${s}` : a || s;
  return body ? `${body}\n\n${clock}` : clock;
}

/**
 * Resolve one step. Throws StepResolutionError when the step cannot execute as
 * configured — never silently substitutes a different model or agent.
 */
export function resolveStep(step: WorkflowStep, ctx: ResolveContext): ResolvedStep {
  const notes: string[] = [];
  let agent: AgentConfig | null = null;

  if (step.agentId) {
    agent = ctx.agents.find((a) => a.id === step.agentId) ?? null;
    if (!agent) {
      throw new StepResolutionError(
        `step '${step.name}' references agent '${step.agentId}', which does not exist`
      );
    }
    if (agent.status !== "ready") {
      throw new StepResolutionError(
        `agent '${agent.name}' is ${agent.status}; only a ready agent can execute a workflow step`
      );
    }
    // A workflow must not reach across tenants: the agent has to belong to the
    // workflow's tenant (or an ancestor of it, mirroring the org tree).
    if (!agentEligibleForWorkflow(agent.tenantId, ctx.workflowTenantId, ctx.tenants)) {
      throw new StepResolutionError(
        `agent '${agent.name}' belongs to tenant '${agent.tenantId}' but the workflow runs in ` +
          `'${ctx.workflowTenantId}'; cross-tenant execution is not permitted`
      );
    }
  }

  // Model: an explicit step model wins; otherwise inherit the agent's.
  const modelId = step.modelId || agent?.modelId;
  if (!modelId) {
    throw new StepResolutionError(
      `step '${step.name}' has no modelId and no agentId to inherit one from`
    );
  }
  if (step.modelId && agent && step.modelId !== agent.modelId) {
    notes.push(
      `step model overrides the agent's model (${step.modelId} instead of ${agent.modelId})`
    );
  }

  const catalogModel = ctx.models.find((m) => m.id === modelId);
  if (!catalogModel) {
    throw new StepResolutionError(
      `step '${step.name}' resolves to catalog model '${modelId}', which is not in the catalog`
    );
  }

  const executor = executorFor(catalogModel);

  // If the agent declares a model runtime, it must agree with where the model
  // is really served — otherwise the runtime field would be decorative again.
  if (agent) {
    const mismatch = planeMismatch(
      agent.compute.modelRuntimeId,
      catalogModel.inferenceProvider
    );
    if (mismatch) {
      throw new StepResolutionError(`agent '${agent.name}': ${mismatch}`);
    }
  }

  // Tools / KBs: inherited from the agent when agent-bound, else taken from the
  // step. Only APPROVED records count — the same rule the Agents API enforces.
  const toolRefs = agent ? agent.toolRefs : step.toolRefs ?? [];
  const knowledgeRefsRaw = agent ? agent.knowledgeRefs : step.knowledgeRefs ?? [];

  const resolvedTools: string[] = [];
  for (const id of toolRefs) {
    const rec = ctx.records.find((r) => r.id === id);
    if (!rec || rec.status !== "Approved") {
      notes.push(`tool record '${id}' is missing or not Approved — skipped`);
      continue;
    }
    resolvedTools.push(...rec.tools);
  }
  // Split the approved names into what the platform can actually run and what
  // it cannot. Never imply execution for an unimplemented tool.
  const { available: implementedTools, unimplemented } = selectTools(resolvedTools);
  // Narrow the catalog to what this step's task plausibly needs. This happens
  // strictly INSIDE the approved+implemented set, so it can only remove
  // candidates — the registry and Cedar remain the authorities on what an agent
  // may do. Withholding is reported, never silent.
  const selection = narrowTools(implementedTools, `${step.name} ${step.prompt ?? ""}`);
  const executableTools = selection.offered;
  if (executableTools.length > 0) {
    notes.push(
      `${executableTools.length} executable tool(s) offered to the model: ` +
        executableTools.map((t) => t.name).join(", ")
    );
  }
  if (!selection.complete) {
    notes.push(
      `${selection.withheld.length} approved tool(s) withheld to keep the catalog ` +
        `under ${selection.maxTools} for this step: ` +
        selection.withheld.map((w) => w.name).join(", ")
    );
  }
  if (unimplemented.length > 0) {
    notes.push(
      `${unimplemented.length} approved tool(s) have no implementation and are NOT invoked: ` +
        `${unimplemented.slice(0, 4).join(", ")}${unimplemented.length > 4 ? ", …" : ""}`
    );
  }

  const knowledgeRefs: string[] = [];
  for (const id of knowledgeRefsRaw) {
    const rec = ctx.records.find((r) => r.id === id);
    if (!rec || rec.type !== "Knowledge Base" || rec.status !== "Approved") {
      notes.push(`knowledge base '${id}' is missing, not a KB, or not Approved — skipped`);
      continue;
    }
    knowledgeRefs.push(id);
  }

  const prompt = agent ? composePrompt(agent.systemPrompt, step.prompt) : step.prompt;

  return {
    step: { ...step, modelId, prompt },
    executor,
    catalogModel,
    agent,
    knowledgeRefs,
    resolvedTools,
    executableTools,
    notes,
  };
}

// `isAncestorTenant` now lives in ./eligibility so the UI can use the same
// rule. Re-exported because existing callers and tests import it from here.
export { isAncestorTenant } from "./eligibility";

/** True when any step in a workflow is bound to a registered agent. */
export function hasAgentBoundStep(steps: WorkflowStep[]): boolean {
  return steps.some((s) => Boolean(s.agentId));
}
