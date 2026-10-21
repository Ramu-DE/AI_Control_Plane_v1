// Governance for agent-bound workflow steps: Cedar authorization + RAG grounding.
//
// Two things happen here that previously could not:
//   1. a workflow step that runs AS a governed agent is Cedar-checked, with the
//      same two-stage shape used for A2A and Knowledge Base calls;
//   2. an agent's `knowledgeRefs` are actually RETRIEVED and injected into the
//      prompt with citations — the field used to be stored and never read.
//
// Server-only.

import { evaluate } from "../evaluator";
import { store } from "../store";
import { retrieve } from "../kb/service";
import type { Policy, StepGrounding } from "../types";

// --------------------------------------------------------------------------- //
// Cedar: action `runAgent`
// --------------------------------------------------------------------------- //

export const RUN_AGENT_ACTION = "runAgent";
export const WORKFLOW_PERIMETER_TOOL = "workflow";

/** Raised when Cedar refuses to run a step as the bound agent. */
export class StepDeniedError extends Error {
  readonly code = "STEP_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "StepDeniedError";
  }
}

export function agentScopedTool(agentId: string): string {
  return `${WORKFLOW_PERIMETER_TOOL}:${agentId}`;
}

/** Does an enabled gateway policy name this specific agent? Pure. */
export function agentScopedPolicyExists(policies: Policy[], agentId: string): boolean {
  const needle = `Tool::"${agentScopedTool(agentId)}"`;
  return policies.some(
    (p) => p.enabled && p.layer === "gateway" && p.cedar.includes(needle)
  );
}

export interface StepAuthorization {
  allowed: boolean;
  perimeter: { allowed: boolean; reason: string; matchedPolicyId?: string };
  agentScoped:
    | { evaluated: true; allowed: boolean; reason: string; matchedPolicyId?: string }
    | { evaluated: false; reason: string };
}

/**
 * Authorize running a step as a given agent.
 *
 * Stage 1 is the workflow perimeter; stage 2 is an agent-scoped rule that only
 * applies when a policy names that agent, and is then authoritative. Identical
 * semantics to lib/a2a/logic.ts and lib/kb/service.ts so operators learn one
 * model, not three.
 */
export function authorizeAgentStep(agentId: string, personaId: string): StepAuthorization {
  const base = evaluate({
    personaId,
    agentId,
    action: RUN_AGENT_ACTION,
    tool: WORKFLOW_PERIMETER_TOOL,
    resource: agentId,
  });
  const pd = base.decisions[0];
  const perimeter = {
    allowed: base.allowed,
    reason: pd?.reason ?? "no decision recorded",
    ...(pd?.matchedPolicyId ? { matchedPolicyId: pd.matchedPolicyId } : {}),
  };

  if (!perimeter.allowed) {
    return {
      allowed: false,
      perimeter,
      agentScoped: {
        evaluated: false,
        reason: "not evaluated — the workflow perimeter denied the step",
      },
    };
  }

  if (!agentScopedPolicyExists(store.policies, agentId)) {
    return {
      allowed: true,
      perimeter,
      agentScoped: {
        evaluated: false,
        reason: `no policy names Tool::"${agentScopedTool(agentId)}" — perimeter decision stands`,
      },
    };
  }

  const scoped = evaluate({
    personaId,
    agentId,
    action: RUN_AGENT_ACTION,
    tool: agentScopedTool(agentId),
    resource: agentId,
  });
  const sd = scoped.decisions[0];
  return {
    allowed: scoped.allowed,
    perimeter,
    agentScoped: {
      evaluated: true,
      allowed: scoped.allowed,
      reason: sd?.reason ?? "no decision recorded",
      ...(sd?.matchedPolicyId ? { matchedPolicyId: sd.matchedPolicyId } : {}),
    },
  };
}

// --------------------------------------------------------------------------- //
// RAG grounding
// --------------------------------------------------------------------------- //

export interface GroundingOutcome {
  /** Text block to prepend to the prompt, or "" when nothing was retrieved. */
  context: string;
  grounding: StepGrounding | null;
  notes: string[];
}

const MAX_PASSAGE_CHARS = 1_200;

/**
 * Retrieve grounding passages for a step from the first KB that returns any.
 *
 * Deliberately DEGRADED-BUT-VISIBLE: a retrieval failure does not fail the
 * step, but it is recorded in `notes` and no grounding block is attached, so a
 * reader can always tell whether an answer was actually grounded.
 */
export async function groundStep(
  knowledgeRefs: string[],
  personaId: string,
  query: string,
  topK = 4
): Promise<GroundingOutcome> {
  const notes: string[] = [];
  if (knowledgeRefs.length === 0) return { context: "", grounding: null, notes };

  for (const recordId of knowledgeRefs) {
    try {
      const out = await retrieve({ recordId, personaId, query, topK });
      const passages = out.result?.passages ?? [];
      if (passages.length === 0) {
        notes.push(`knowledge base '${out.recordName}' returned no passages`);
        for (const n of out.result?.notes ?? []) notes.push(`retrieval: ${n}`);
        continue;
      }
      const block = passages
        .map((p, i) => `[${i + 1}] ${p.text.slice(0, MAX_PASSAGE_CHARS)}`)
        .join("\n\n");
      return {
        context:
          `Grounding context retrieved from '${out.recordName}'. Cite sources as [n].\n\n` +
          `${block}\n\n`,
        grounding: {
          recordId,
          recordName: out.recordName,
          provider: out.provider,
          passageCount: passages.length,
          citations: passages.map((p) => ({
            id: p.id,
            score: p.score,
            source: p.source,
          })),
        },
        notes,
      };
    } catch (e) {
      // Config/denied/transport problems are all non-fatal for the step itself.
      notes.push(
        `grounding from knowledge base '${recordId}' unavailable: ${(e as Error).message}`
      );
    }
  }

  notes.push("step ran WITHOUT retrieval grounding");
  return { context: "", grounding: null, notes };
}
