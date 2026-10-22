// Registry validation and referential integrity.
//
// PURE — no store access, no I/O. Every rule that decides whether a registry
// entry may be created or removed lives here so it can be tested directly,
// which is also why the duplicate bug survived: there was nowhere these rules
// were expected to be.
//
// THE CENTRAL DISTINCTION: deleting a Draft record and deleting an Approved one
// are not the same operation.
//
// A Draft was never in force. Nothing referenced it, no one signed it off, and
// removing it loses nothing — a hard delete is correct.
//
// An Approved record has been through review and may be attached to agents that
// are running right now. Hard-deleting it would leave those agents pointing at
// an id that no longer exists, and would erase the thing the audit trail refers
// to. The right operation is DEPRECATE: the record stops being attachable but
// remains resolvable, so history still makes sense. The transition table has
// supported this from the start; nothing exposed it.

import type {
  AgentConfig,
  Registry,
  RegistryRecord,
  Workflow,
} from "../types";

export class RegistryValidationError extends Error {
  readonly code = "REGISTRY_VALIDATION";
  /** HTTP status the route should use. 409 for a conflict, 400 for bad input. */
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RegistryValidationError";
    this.status = status;
  }
}

/**
 * Compare names the way a human would: case- and whitespace-insensitive, and
 * collapsing internal runs of space. "Supplier Tools", "supplier tools" and
 * "Supplier  Tools" are the same name to a reviewer, so treating them as
 * distinct is what lets a list fill up with things that look identical.
 */
export function normalizeName(name: string): string {
  return (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

const NAME_OK = /^[\w][\w .,()\/+-]{0,119}$/;

/** Validate a display name. Returns the trimmed name or throws. */
export function assertName(label: string, raw: string | undefined): string {
  const name = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) {
    throw new RegistryValidationError(`${label} is required.`);
  }
  if (name.length > 120) {
    throw new RegistryValidationError(`${label} must be 120 characters or fewer.`);
  }
  if (!NAME_OK.test(name)) {
    throw new RegistryValidationError(
      `${label} may contain letters, digits, spaces and . , ( ) / + - _ only.`
    );
  }
  return name;
}

// --------------------------------------------------------------------------- //
// Duplicates
// --------------------------------------------------------------------------- //

/**
 * Refuse a second registry with the same name.
 *
 * Two registries called "Supplier Tools" cannot be told apart in a picker, so a
 * reviewer approving a record has no way to know which container it landed in.
 */
export function assertRegistryNameFree(
  name: string,
  registries: Registry[],
  excludeId?: string
): void {
  const needle = normalizeName(name);
  const clash = registries.find(
    (r) => r.id !== excludeId && normalizeName(r.name) === needle
  );
  if (clash) {
    throw new RegistryValidationError(
      `A registry named '${clash.name}' already exists (${clash.id}). ` +
        `Use it, or choose a different name.`,
      409
    );
  }
}

/**
 * Refuse a second record with the same name IN THE SAME REGISTRY.
 *
 * Scoped to the registry on purpose: two business units may each legitimately
 * have a "uc-readonly" record, and forcing platform-wide uniqueness would make
 * one of them rename a thing they own. Within one registry it is a duplicate.
 */
export function assertRecordNameFree(
  name: string,
  registryId: string,
  records: RegistryRecord[],
  excludeId?: string
): void {
  const needle = normalizeName(name);
  const clash = records.find(
    (r) =>
      r.id !== excludeId &&
      r.registryId === registryId &&
      normalizeName(r.name) === needle
  );
  if (clash) {
    throw new RegistryValidationError(
      `A record named '${clash.name}' already exists in this registry ` +
        `(${clash.id}, status ${clash.status}). Rename it, or edit the ` +
        `existing one instead of creating a second.`,
      409
    );
  }
}

// --------------------------------------------------------------------------- //
// Referential integrity
// --------------------------------------------------------------------------- //

export interface RecordUsage {
  /** Agents holding this record in toolRefs / knowledgeRefs / memoryRefs. */
  agents: { id: string; name: string; via: string }[];
  /** Workflow steps holding it in toolRefs / knowledgeRefs. */
  workflowSteps: { workflowId: string; workflowName: string; stepName: string; via: string }[];
}

export function isUsed(u: RecordUsage): boolean {
  return u.agents.length > 0 || u.workflowSteps.length > 0;
}

/**
 * Find everything that would break if this record disappeared.
 *
 * Reported rather than counted: "in use by 2 things" tells an operator nothing
 * actionable, whereas naming the agent and the field lets them go and detach it.
 */
export function findRecordUsage(
  recordId: string,
  agents: AgentConfig[],
  workflows: Workflow[]
): RecordUsage {
  const usage: RecordUsage = { agents: [], workflowSteps: [] };

  for (const a of agents) {
    const fields: [string, string[] | undefined][] = [
      ["toolRefs", a.toolRefs],
      ["knowledgeRefs", a.knowledgeRefs],
      ["memoryRefs", a.memoryRefs],
    ];
    for (const [via, refs] of fields) {
      if (refs?.includes(recordId)) {
        usage.agents.push({ id: a.id, name: a.name, via });
      }
    }
  }

  for (const w of workflows) {
    for (const s of w.steps ?? []) {
      const fields: [string, string[] | undefined][] = [
        ["toolRefs", s.toolRefs],
        ["knowledgeRefs", s.knowledgeRefs],
      ];
      for (const [via, refs] of fields) {
        if (refs?.includes(recordId)) {
          usage.workflowSteps.push({
            workflowId: w.id,
            workflowName: w.name,
            stepName: s.name,
            via,
          });
        }
      }
    }
  }

  return usage;
}

/** Human-readable list of what depends on a record. */
export function describeUsage(u: RecordUsage): string {
  const parts = [
    ...u.agents.map((a) => `agent '${a.name}' (${a.via})`),
    ...u.workflowSteps.map(
      (s) => `workflow '${s.workflowName}' step '${s.stepName}' (${s.via})`
    ),
  ];
  return parts.join(", ");
}

// --------------------------------------------------------------------------- //
// Deletion policy
// --------------------------------------------------------------------------- //

export type DeleteDecision =
  | { action: "delete"; reason: string }
  | { action: "deprecate"; reason: string }
  | { action: "refuse"; reason: string };

/**
 * Decide what removing a record should actually do.
 *
 * Three outcomes, not two, because "delete" is the wrong answer for a record
 * that has been in force:
 *
 *   refuse     — something still references it. Detach first; a dangling
 *                reference turns into a confusing runtime error later, far from
 *                the action that caused it.
 *   deprecate  — unreferenced but Approved or Deprecated. It passed review and
 *                the audit trail points at it, so it stops being attachable but
 *                stays resolvable.
 *   delete     — Draft or Rejected and unreferenced. It was never in force and
 *                nothing can be looking for it.
 */
export function decideRecordDeletion(
  record: RegistryRecord,
  usage: RecordUsage
): DeleteDecision {
  if (isUsed(usage)) {
    return {
      action: "refuse",
      reason:
        `'${record.name}' is still in use by ${describeUsage(usage)}. ` +
        `Detach it there first — removing it now would leave a reference to ` +
        `an id that no longer exists.`,
    };
  }
  if (record.status === "Approved") {
    return {
      action: "deprecate",
      reason:
        `'${record.name}' is Approved, so it is deprecated rather than ` +
        `deleted: it stops being attachable but stays resolvable, because the ` +
        `audit trail refers to it.`,
    };
  }
  if (record.status === "Deprecated") {
    return {
      action: "refuse",
      reason: `'${record.name}' is already Deprecated. Nothing further to do.`,
    };
  }
  return {
    action: "delete",
    reason: `'${record.name}' is ${record.status} and unreferenced, so it is removed.`,
  };
}

/**
 * A registry may only be removed when it is empty.
 *
 * Cascading would delete reviewed records as a side effect of tidying a
 * container, which is exactly the kind of quiet data loss a governed registry
 * exists to prevent.
 */
export function assertRegistryRemovable(
  registryId: string,
  records: RegistryRecord[]
): void {
  const held = records.filter((r) => r.registryId === registryId);
  if (held.length > 0) {
    const names = held.slice(0, 3).map((r) => r.name).join(", ");
    throw new RegistryValidationError(
      `This registry still holds ${held.length} record(s) (${names}` +
        `${held.length > 3 ? ", …" : ""}). Remove them first — deleting the ` +
        `container must not quietly delete reviewed records.`,
      409
    );
  }
}
