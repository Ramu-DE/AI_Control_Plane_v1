// Live tenant usage — what a tenant is ACTUALLY consuming of its capacity.
//
// The tenants console used to show a `basic` / `pro` chip and the tier's static
// limits. Both are facts about the plan, not about the tenant, so the page
// looked informative and answered nothing an operator asks: is this BU near a
// limit, does it own anything at all, where do I go to see it.
//
// These functions compute the usage side. PURE — they take the collections
// rather than importing the store, so the same code serves the API route and
// can be tested without one.

import { getTierConfig } from "./tiers";
import type {
  AgentConfig,
  AuditEvent,
  RegistryRecord,
  Tenant,
  TierConfig,
  Workflow,
} from "./types";

export interface TenantUsage {
  agents: number;
  agentsReady: number;
  agentsDraft: number;
  workflows: number;
  /**
   * Distinct registry records ATTACHED to this tenant's agents, by kind.
   *
   * Not "records this tenant owns". `RegistryRecord.owner` holds values like
   * `console-user`, `platform-team` and `finance-platform` — a mix of people
   * and teams, not tenant ids — so filtering by it reports 0 for almost every
   * tenant and is meaningless for the two that coincidentally match. What a
   * tenant demonstrably uses is what its agents reference.
   */
  toolsAttached: number;
  knowledgeBasesAttached: number;
  memoriesAttached: number;
  /**
   * The largest number of each attachment any ONE of its agents carries.
   * These are what the per-agent ceilings are actually compared against, so
   * the peak is the only number that can tell you whether a tenant is close
   * to one.
   */
  peakPerAgent: { tools: number; knowledgeBases: number; memories: number };
  /** Direct children in the tenant tree. */
  subUnits: number;
  /** Children at any depth, which is what a BU lead actually manages. */
  descendants: number;
}

export interface CapacityLine {
  key: string;
  label: string;
  used: number;
  /** null = unlimited. */
  limit: number | null;
  /** 0..1, or null when there is no limit to be a fraction of. */
  ratio: number | null
  ;
  /** "ok" | "tight" | "full" — a UI should not re-derive these thresholds. */
  state: "ok" | "tight" | "full";
}

export interface TenantCapacity {
  plan: string;
  lines: CapacityLine[];
  /** True when any limited dimension is at or over its limit. */
  anyFull: boolean;
  /** True when any limited dimension is at 80% or more. */
  anyTight: boolean;
}

/**
 * Every descendant id of `rootId`, excluding itself.
 *
 * Iterative rather than recursive, and it tracks visited ids, so a cycle
 * introduced by a bad `parentId` cannot hang the console. Tenant trees come
 * from data; assuming they are acyclic is how a page freezes in production.
 */
export function descendantIds(tenants: Tenant[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const t of tenants) {
    if (!t.parentId) continue;
    const list = childrenOf.get(t.parentId) ?? [];
    list.push(t.id);
    childrenOf.set(t.parentId, list);
  }
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [...(childrenOf.get(rootId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return out;
}

export interface UsageInputs {
  tenants: Tenant[];
  agents: AgentConfig[];
  workflows: Workflow[];
  records: RegistryRecord[];
}

/**
 * Count what one tenant owns.
 *
 * Counts are DIRECT, not rolled up through descendants, because the tier limits
 * are enforced per tenant — `/api/agents` compares against
 * `agents.filter(a => a.tenantId === tenant.id).length`. A rolled-up number
 * next to a per-tenant limit would read as though a parent were over capacity
 * when it is not, which is worse than no number. Subtree size is reported
 * separately as `descendants`.
 */
export function tenantUsage(tenantId: string, input: UsageInputs): TenantUsage {
  const agents = input.agents.filter((a) => a.tenantId === tenantId);
  const byId = new Map(input.records.map((r) => [r.id, r]));

  // Distinct across agents: two agents sharing one knowledge base are using
  // ONE, and counting it twice would overstate consumption.
  const refs = (pick: (a: AgentConfig) => string[] | undefined) => {
    const ids = new Set<string>();
    for (const a of agents) for (const id of pick(a) ?? []) ids.add(id);
    return [...ids].map((id) => byId.get(id)).filter(Boolean) as RegistryRecord[];
  };

  const peak = (pick: (a: AgentConfig) => string[] | undefined) =>
    agents.reduce((max, a) => Math.max(max, (pick(a) ?? []).length), 0);

  return {
    agents: agents.length,
    agentsReady: agents.filter((a) => a.status === "ready").length,
    agentsDraft: agents.filter((a) => a.status !== "ready").length,
    workflows: input.workflows.filter((w) => w.tenantId === tenantId).length,
    toolsAttached: refs((a) => a.toolRefs).length,
    knowledgeBasesAttached: refs((a) => a.knowledgeRefs).length,
    memoriesAttached: refs((a) => a.memoryRefs).length,
    peakPerAgent: {
      tools: peak((a) => a.toolRefs),
      knowledgeBases: peak((a) => a.knowledgeRefs),
      memories: peak((a) => a.memoryRefs),
    },
    subUnits: input.tenants.filter((t) => t.parentId === tenantId).length,
    descendants: descendantIds(input.tenants, tenantId).length,
  };
}

function line(
  key: string,
  label: string,
  used: number,
  limit: number | null
): CapacityLine {
  if (limit === null) {
    return { key, label, used, limit: null, ratio: null, state: "ok" };
  }
  // Guard the divide: a limit of 0 means nothing is allowed, so any use is
  // full and zero use is not "0/0 = NaN%".
  const ratio = limit === 0 ? (used > 0 ? 1 : 0) : used / limit;
  const state: CapacityLine["state"] =
    used >= limit ? "full" : ratio >= 0.8 ? "tight" : "ok";
  return { key, label, used, limit, ratio, state };
}

/**
 * Usage against the limits the API ACTUALLY enforces at tenant scope.
 *
 * Exactly one bar, and that is not an oversight. Reading
 * `src/app/api/agents/route.ts`, only `maxAgents` is counted across a tenant:
 *
 *     existing = agents.filter(a => a.tenantId === tenant.id).length
 *
 * `maxToolsPerAgent`, `maxKnowledgeBases` and `maxMemories` are all compared
 * against ONE agent's `toolRefs` / `knowledgeRefs` / `memoryRefs` on create.
 * They are per-agent ceilings, so a tenant-wide bar for them would show a
 * tenant at "8 / 1 memories" while every single agent was within its limit —
 * a meter that implies a guarantee nothing enforces. Those appear in the
 * console as per-agent ceilings instead, next to what the tenant's agents
 * actually carry.
 */
export function tenantCapacity(
  usage: TenantUsage,
  config: TierConfig,
  planName: string
): TenantCapacity {
  const lines = [line("agents", "Agents", usage.agents, config.maxAgents)];
  return {
    plan: planName,
    lines,
    anyFull: lines.some((l) => l.state === "full"),
    anyTight: lines.some((l) => l.state === "tight" || l.state === "full"),
  };
}

/** Per-AGENT ceilings, reported as limits rather than as tenant usage. */
export interface PerAgentLimit {
  key: string;
  label: string;
  limit: number;
  /** The highest count observed on any one of this tenant's agents. */
  peak: number;
  atCeiling: boolean;
}

export function perAgentLimits(
  usage: TenantUsage,
  config: TierConfig
): PerAgentLimit[] {
  const rows: Array<[string, string, number, number]> = [
    ["tools", "Tools per agent", config.maxToolsPerAgent,
     usage.peakPerAgent.tools],
    ["knowledgeBases", "Knowledge bases per agent", config.maxKnowledgeBases,
     usage.peakPerAgent.knowledgeBases],
    ["memories", "Memories per agent", config.maxMemories,
     usage.peakPerAgent.memories],
  ];
  return rows.map(([key, label, limit, peak]) => ({
    key, label, limit, peak, atCeiling: peak >= limit,
  }));
}

/** Everything the tenants console needs for one node, in one shape. */
export function describeTenant(tenant: Tenant, input: UsageInputs) {
  const config = getTierConfig(tenant.tier);
  const usage = tenantUsage(tenant.id, input);
  return { usage, config };
}

// --------------------------------------------------------------------------- //
// Tenant scope — the shared subtree rules
// --------------------------------------------------------------------------- //
//
// Our tenancy is a TREE, not a flat list, and that is what makes a "bridged"
// isolation tier expressible: a rule set at the org applies to every
// descendant unless one overrides it.
//
// The cost is that every tenant-aware check has to handle subtree semantics,
// and for a long time only two did — `tenantInSubtree` for memory and
// `isAncestorTenant` for workflow eligibility. Audit visibility, Cedar
// evaluation and registry attachment each needed the same rule, so it lives
// here once rather than being re-derived three more times with three chances
// to get the direction backwards.

/** `tenantId` then each ancestor, root last. Cycle-safe. */
export function tenantChain(tenantId: string, tenants: Tenant[]): string[] {
  const byId = new Map(tenants.map((t) => [t.id, t]));
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(tenantId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    out.push(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return out;
}

/**
 * Is `candidate` `root` itself, or anywhere beneath it?
 *
 * Reflexive on purpose: a tenant is in its own subtree. The alternative makes
 * every caller write `id === root || inSubtree(...)`, and the one that forgets
 * denies a tenant access to its own resources.
 */
export function inTenantSubtree(
  candidate: string,
  root: string,
  tenants: Tenant[]
): boolean {
  if (candidate === root) return true;
  return tenantChain(candidate, tenants).includes(root);
}

/** The tenant plus every descendant — what a parent may legitimately see. */
export function visibleTenantIds(rootId: string, tenants: Tenant[]): string[] {
  return [rootId, ...descendantIds(tenants, rootId)];
}

/**
 * May a tenant use this resource, given the resource's owning tenant?
 *
 * `undefined` owner means PLATFORM-PROVIDED and is available to everyone —
 * the shared half of "a platform offers shared tools while tenants onboard
 * their own". A resource owned by an ANCESTOR is also available, which is the
 * bridged case: the org publishes a tool once and every BU inherits it.
 *
 * What is refused is the sideways case — a sibling BU's resource — and that is
 * the one that matters, because nothing about the current flat registry would
 * otherwise prevent it.
 */
export function resourceAvailableToTenant(
  resourceTenantId: string | null | undefined,
  tenantId: string,
  tenants: Tenant[]
): { allowed: boolean; reason: string } {
  if (resourceTenantId === null || resourceTenantId === undefined) {
    return { allowed: true, reason: "platform-provided (available to every tenant)" };
  }
  if (resourceTenantId === tenantId) {
    return { allowed: true, reason: `owned by '${tenantId}'` };
  }
  if (inTenantSubtree(tenantId, resourceTenantId, tenants)) {
    return {
      allowed: true,
      reason: `inherited from ancestor tenant '${resourceTenantId}'`,
    };
  }
  return {
    allowed: false,
    reason:
      `owned by tenant '${resourceTenantId}', which is neither '${tenantId}' ` +
      `nor one of its ancestors`,
  };
}

// --------------------------------------------------------------------------- //
// Tenant-scoped telemetry
// --------------------------------------------------------------------------- //

export interface AuditScopeResult {
  events: AuditEvent[];
  /** Tenants whose events are included — the subtree that was expanded. */
  includedTenantIds: string[];
  /** Entries with no tenant at all, counted rather than silently dropped. */
  platformEvents: number;
}

/**
 * The audit events one tenant may see: its own plus its descendants'.
 *
 * A parent seeing its children's activity is the point of the tree — it is how
 * a BU lead gets oversight of their sub-units without being handed the whole
 * org's log. The sideways case is excluded.
 *
 * `includePlatform` governs the untenanted entries (policy edits, catalog
 * changes). They are NOT tenant data, so they are off by default; a platform
 * admin asks for them explicitly. Either way the count is reported, because a
 * log that silently omits entries is worse than one that says it did.
 */
export function filterAuditForTenant(
  events: AuditEvent[],
  tenantId: string,
  tenants: Tenant[],
  opts: { includePlatform?: boolean } = {}
): AuditScopeResult {
  const visible = new Set(visibleTenantIds(tenantId, tenants));
  const out: AuditEvent[] = [];
  let platformEvents = 0;
  for (const e of events) {
    if (e.tenantId === undefined || e.tenantId === null) {
      platformEvents += 1;
      if (opts.includePlatform) out.push(e);
      continue;
    }
    if (visible.has(e.tenantId)) out.push(e);
  }
  return { events: out, includedTenantIds: [...visible], platformEvents };
}

/** Per-tenant token totals from run records — the basis of cost attribution. */
export function usageByTenant(
  runs: Workflow[] | { tenantId: string; totalTokens?: number; totalCostUsd?: number }[]
): Record<string, { tokens: number; costUsd: number; runs: number }> {
  const out: Record<string, { tokens: number; costUsd: number; runs: number }> = {};
  for (const r of runs as { tenantId: string; totalTokens?: number; totalCostUsd?: number }[]) {
    if (!r.tenantId) continue;
    const row = out[r.tenantId] ?? { tokens: 0, costUsd: 0, runs: 0 };
    row.tokens += r.totalTokens ?? 0;
    row.costUsd += r.totalCostUsd ?? 0;
    row.runs += 1;
    out[r.tenantId] = row;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Presentation order
// --------------------------------------------------------------------------- //

export interface TenantOption<T> {
  tenant: T;
  /** Tree depth, for indenting a flat <select>. */
  depth: number;
}

/**
 * Tenants in TREE order: each root, then its children, depth-first.
 *
 * The Create Agent form rendered `tenants.map(...)` in store order, which is
 * insertion order — and new tenants are unshifted to the FRONT. With 32 real
 * tenants that was already hard to scan; once the store became durable and
 * test tenants stopped being wiped on restart, ten throwaway entries sat above
 * "Takeda" and the organisation looked like it had disappeared. It had not: it
 * was at index 10 of an unsorted list.
 *
 * Sorting here rather than in the page so the tenant picker and the tenant
 * tree cannot disagree about order. Cycle-safe, and any node whose parent is
 * missing is emitted as a root rather than silently dropped — a tenant absent
 * from the picker is unselectable, which is worse than one shown out of place.
 */
export function tenantsInTreeOrder<T extends { id: string; parentId: string | null }>(
  tenants: T[]
): TenantOption<T>[] {
  const childrenOf = new Map<string | null, T[]>();
  const ids = new Set(tenants.map((t) => t.id));
  for (const t of tenants) {
    const key = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    const list = childrenOf.get(key) ?? [];
    list.push(t);
    childrenOf.set(key, list);
  }
  const out: TenantOption<T>[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const t of childrenOf.get(parent) ?? []) {
      if (seen.has(t.id)) continue;   // guards a parentId cycle
      seen.add(t.id);
      out.push({ tenant: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything unreachable (a cycle) still has to be selectable.
  for (const t of tenants) {
    if (!seen.has(t.id)) out.push({ tenant: t, depth: 0 });
  }
  return out;
}
