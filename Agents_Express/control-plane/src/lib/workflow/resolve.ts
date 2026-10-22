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

export function executorFor(model: CatalogModel): Executor {
  return model.inferenceProvider === "Databricks Model Serving"
    ? "databricks"
    : "bedrock";
}

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
 */
export function composePrompt(agentSystemPrompt: string, stepPrompt: string): string {
  const a = (agentSystemPrompt || "").trim();
  const s = (stepPrompt || "").trim();
  if (a && s) return `${a}\n\n${s}`;
  return a || s;
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
    if (agent.tenantId !== ctx.workflowTenantId && !isAncestorTenant(agent.tenantId, ctx.workflowTenantId, ctx.tenants)) {
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
    const wantsDatabricks = agent.compute.modelRuntimeId.startsWith("databricks-");
    if (wantsDatabricks && executor !== "databricks") {
      throw new StepResolutionError(
        `agent '${agent.name}' declares model runtime '${agent.compute.modelRuntimeId}' but its ` +
          `model is served by '${catalogModel.inferenceProvider}'`
      );
    }
    if (!wantsDatabricks && executor === "databricks") {
      throw new StepResolutionError(
        `agent '${agent.name}' declares model runtime '${agent.compute.modelRuntimeId}' but its ` +
          `model is served by Databricks Model Serving`
      );
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

/** Walk the tenant tree upward from `from`, looking for `ancestor`. */
export function isAncestorTenant(
  ancestor: string,
  from: string,
  tenants: Tenant[]
): boolean {
  let cursor = tenants.find((t) => t.id === from);
  const seen = new Set<string>();
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    seen.add(cursor.parentId);
    if (cursor.parentId === ancestor) return true;
    cursor = tenants.find((t) => t.id === cursor!.parentId);
  }
  return false;
}

/** True when any step in a workflow is bound to a registered agent. */
export function hasAgentBoundStep(steps: WorkflowStep[]): boolean {
  return steps.some((s) => Boolean(s.agentId));
}
