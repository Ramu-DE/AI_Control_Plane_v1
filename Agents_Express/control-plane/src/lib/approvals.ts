// Maker-checker for governed resources: Registry records and Graph Sources.
//
// Approving a tool, knowledge base or graph is what makes it usable by every
// agent in a tenant, so it is as consequential as a workflow's review gate and
// follows the same rule:
//
//   SUBMIT  (Draft -> Pending approval)   an analyst+ of the resource's tenant,
//                                         recorded as the submitter
//   DECIDE  (-> Approved | Rejected |     an approver+ of the resource's tenant,
//            Deprecated)                  NOT the submitter (four eyes), and
//                                         Cedar `approveRecord` must permit —
//                                         so the GxP and residency policies
//                                         bind approvers too
//
// A resource with no tenant is PLATFORM-PROVIDED (available to every tenant),
// so its decisions belong to the org root: an approver of `takeda`.
//
// Other transitions (Rejected -> Draft) need no reviewer.

import { evaluate } from "./evaluator";
import { personaTenantDecision, roleAllows } from "./personas";
import { APPROVALS_TOOL, APPROVE_RECORD_ACTION } from "./regulatory";
import { store } from "./store";
import type { Persona, RecordStatus } from "./types";

export const DECISION_STATUSES: RecordStatus[] = ["Approved", "Rejected", "Deprecated"];
export const PLATFORM_TENANT = "takeda";

export interface ApprovalInput {
  next: RecordStatus;
  /** The resource's owning tenant; undefined = platform-provided. */
  tenantId?: string;
  resourceId: string;
  /** Who submitted it, when known. */
  submittedByPersonaId?: string;
  personaId?: string;
}

export type ApprovalOutcome =
  | { ok: true; persona?: Persona; role: "submit" | "decide" | "none"; tenantId: string }
  | { ok: false; status: number; code: string; error: string };

export function authorizeTransition(input: ApprovalInput): ApprovalOutcome {
  const tenantId = input.tenantId && store.tenants.some((t) => t.id === input.tenantId)
    ? input.tenantId
    : PLATFORM_TENANT;
  const deciding = DECISION_STATUSES.includes(input.next);
  const submitting = input.next === "Pending approval";
  if (!deciding && !submitting) return { ok: true, role: "none", tenantId };

  const persona = store.personas.find((p) => p.id === input.personaId);
  if (!persona) {
    return {
      ok: false, status: 400,
      code: deciding ? "REVIEWER_REQUIRED" : "SUBMITTER_REQUIRED",
      error: deciding
        ? "reviewerPersonaId is required: an approval decision must name who took it"
        : "submitterPersonaId is required: a submission must name who made it",
    };
  }

  if (submitting) {
    const member = personaTenantDecision(persona, tenantId, store.tenants);
    const byRole = roleAllows(member.role, "submitRecord");
    if (!member.allowed || !byRole.allowed) {
      return {
        ok: false, status: 403, code: "SUBMITTER_NOT_PERMITTED",
        error: member.allowed
          ? `${persona.name} is ${member.role} in '${member.via}'; submitting needs ${byRole.needed} or above`
          : member.reason,
      };
    }
    return { ok: true, persona, role: "submit", tenantId };
  }

  if (input.submittedByPersonaId && input.submittedByPersonaId === persona.id) {
    return {
      ok: false, status: 403, code: "SELF_REVIEW",
      error: `${persona.name} submitted this and cannot also decide it (four-eyes rule)`,
    };
  }
  const decision = evaluate({
    personaId: persona.id,
    agentId: "approvals",
    action: APPROVE_RECORD_ACTION,
    tool: APPROVALS_TOOL,
    resource: input.resourceId,
    tenantId,
  });
  if (!decision.allowed) {
    return {
      ok: false, status: 403, code: "REVIEWER_NOT_PERMITTED",
      error: decision.decisions[decision.decisions.length - 1]?.reason ?? "denied",
    };
  }
  return { ok: true, persona, role: "decide", tenantId };
}
