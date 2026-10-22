// Memory governance — authorization, record validation, scope narrowing.
//
// PURE. Every decision that controls who may read whose memory lives here, so
// it can be tested without AWS and without a network. The SDK calls are in
// client.ts and the orchestration is in service.ts; neither makes a policy
// decision of its own.

import { evaluate } from "../evaluator";
import { store } from "../store";
import { MemoryConfigError } from "./types";
import type { MemoryAuthorization, MemoryConfig } from "./types";
import type { Policy, RegistryRecord } from "../types";

// --------------------------------------------------------------------------- //
// Cedar resource naming — the same two-stage shape as a2a, kb, runAgent and kg
// --------------------------------------------------------------------------- //

/** One action covers read and write; the scope is what differs, and it is audited. */
export const MEMORY_ACTION = "useMemory";
export const MEMORY_PERIMETER_TOOL = "memory";

export function memoryScopedTool(recordId: string): string {
  return `${MEMORY_PERIMETER_TOOL}:${recordId}`;
}

/** Does an enabled gateway policy name this specific memory record? Pure. */
export function memoryScopedPolicyExists(
  policies: Policy[],
  recordId: string
): boolean {
  const needle = `Tool::"${memoryScopedTool(recordId)}"`;
  return policies.some(
    (p) => p.enabled && p.layer === "gateway" && p.cedar.includes(needle)
  );
}

/**
 * Two-stage authorization. Stage 2 runs only when a policy names the record,
 * and is then authoritative — so one tenant's memory can be locked to specific
 * personas without loosening or touching the perimeter rule.
 */
export function authorizeMemory(
  recordId: string,
  personaId: string
): MemoryAuthorization {
  const perimeterResult = evaluate({
    personaId,
    agentId: "memory-service",
    action: MEMORY_ACTION,
    tool: MEMORY_PERIMETER_TOOL,
    resource: recordId,
  });
  const pd = perimeterResult.decisions[0];
  const perimeter = {
    allowed: perimeterResult.allowed,
    reason: pd?.reason ?? "no decision recorded",
    ...(pd?.matchedPolicyId ? { matchedPolicyId: pd.matchedPolicyId } : {}),
  };

  if (!perimeter.allowed) {
    return {
      allowed: false,
      perimeter,
      recordScoped: {
        evaluated: false,
        reason: "not evaluated — the memory perimeter denied the call",
      },
    };
  }

  if (!memoryScopedPolicyExists(store.policies, recordId)) {
    return {
      allowed: true,
      perimeter,
      recordScoped: {
        evaluated: false,
        reason: "no record-scoped policy names this memory; perimeter governs",
      },
    };
  }

  const scopedResult = evaluate({
    personaId,
    agentId: "memory-service",
    action: MEMORY_ACTION,
    tool: memoryScopedTool(recordId),
    resource: recordId,
  });
  const sd = scopedResult.decisions[0];
  return {
    allowed: scopedResult.allowed,
    perimeter,
    recordScoped: {
      evaluated: true,
      allowed: scopedResult.allowed,
      reason: sd?.reason ?? "no decision recorded",
      ...(sd?.matchedPolicyId ? { matchedPolicyId: sd.matchedPolicyId } : {}),
    },
  };
}

// --------------------------------------------------------------------------- //
// Record validation — approved-only, same gate as tools and knowledge bases
// --------------------------------------------------------------------------- //

/**
 * A memory may only be used through an APPROVED registry record of type
 * "Memory". That is the whole point of putting it in the platform rather than
 * calling AWS directly: a memory is a governed resource that someone signed off
 * on, with a declared scope ceiling and retrieval bounds, not an ambient
 * capability any agent can reach for.
 */
export function readMemoryConfig(record: RegistryRecord | undefined): MemoryConfig {
  if (!record) {
    throw new MemoryConfigError("memory record not found");
  }
  if (record.type !== "Memory") {
    throw new MemoryConfigError(
      `record '${record.id}' is type '${record.type}', not 'Memory'`
    );
  }
  if (record.status !== "Approved") {
    throw new MemoryConfigError(
      `memory record '${record.id}' is ${record.status}; only an Approved ` +
        `record may be used`
    );
  }
  const cfg = (record as RegistryRecord & { memoryConfig?: Partial<MemoryConfig> })
    .memoryConfig;
  if (!cfg) {
    throw new MemoryConfigError(
      `memory record '${record.id}' has no memoryConfig; it cannot be used ` +
        `until the AgentCore memory id, region and strategy are declared`
    );
  }
  if (!cfg.memoryId || !cfg.region || !cfg.strategyId) {
    throw new MemoryConfigError(
      `memory record '${record.id}' needs memoryId, region and strategyId`
    );
  }
  if (!cfg.namespaceTemplate) {
    throw new MemoryConfigError(
      `memory record '${record.id}' needs namespaceTemplate — retrieval renders ` +
        `it, so without it a read cannot match what extraction wrote`
    );
  }
  // An unbounded topK is how a "relevant memory" feature turns into replaying
  // the whole store into every prompt.
  const topK = Number(cfg.topK ?? 5);
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    throw new MemoryConfigError(
      `memory record '${record.id}' topK must be an integer 1..50 (got ${cfg.topK})`
    );
  }
  return {
    ...(cfg.ownerTenantId ? { ownerTenantId: cfg.ownerTenantId } : {}),
    memoryId: cfg.memoryId,
    region: cfg.region,
    strategyId: cfg.strategyId,
    namespaceTemplate: cfg.namespaceTemplate,
    topK,
    ...(cfg.minRelevance !== undefined ? { minRelevance: Number(cfg.minRelevance) } : {}),
    ...(cfg.eventExpiryDays !== undefined
      ? { eventExpiryDays: Number(cfg.eventExpiryDays) }
      : {}),
  };
}

// --------------------------------------------------------------------------- //
// Cross-tenant boundary
// --------------------------------------------------------------------------- //

/**
 * Is `childTenantId` the tenant itself, or a descendant of it?
 *
 * Memory follows the tenant tree: a tenant inside the owner's subtree may USE
 * the record, a sibling never may. Note what this does and does not decide —
 * it governs whether the record is usable at all. Data isolation comes from the
 * namespace, which is keyed on the REQUESTING tenant, so a descendant using an
 * ancestor-owned record still reads only its own namespace. Mirrors
 * `isAncestorTenant` in the workflow resolver so the platform has one answer to
 * "may this tenant see that one".
 */
export function tenantInSubtree(
  rootTenantId: string,
  childTenantId: string,
  tenants: { id: string; parentId?: string | null }[]
): boolean {
  if (rootTenantId === childTenantId) return true;
  let cursor = tenants.find((t) => t.id === childTenantId);
  const seen = new Set<string>();
  while (cursor?.parentId) {
    if (seen.has(cursor.id)) return false; // cycle guard
    seen.add(cursor.id);
    if (cursor.parentId === rootTenantId) return true;
    cursor = tenants.find((t) => t.id === cursor!.parentId);
  }
  return false;
}
