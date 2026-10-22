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
