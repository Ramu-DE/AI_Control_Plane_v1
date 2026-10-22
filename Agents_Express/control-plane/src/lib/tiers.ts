// Per-tier configuration — replicated from saas-gaming-app/src/middleware/tierMiddleware.ts
// and adapted to the agent control plane. Pro unlocks higher limits + features;
// basic is the shared/pooled default.

// `import type`: these are all type-only, and a value import of them cannot
// be erased by the test loader's transform.
import type { TenantTier, TierConfig, IsolationModel } from "./types";

export const TIER_CONFIGS: Record<TenantTier, TierConfig> = {
  basic: {
    maxAgents: 3,
    maxToolsPerAgent: 2,
    maxKnowledgeBases: 1,
    maxMemories: 1,
    monthlyTokenBudget: 1_000_000,
    enableAnalytics: false,
    enableAuditExport: false,
    enableCustomPolicies: false,
    enableDedicatedGateway: false,
    maxModelsInCatalog: 2,
  },
  pro: {
    maxAgents: 50,
    maxToolsPerAgent: 20,
    maxKnowledgeBases: 20,
    maxMemories: 10,
    monthlyTokenBudget: null, // unlimited
    enableAnalytics: true,
    enableAuditExport: true,
    enableCustomPolicies: true,
    enableDedicatedGateway: true,
    maxModelsInCatalog: 25,
  },
};

export function getTierConfig(tier: TenantTier): TierConfig {
  return TIER_CONFIGS[tier];
}

/**
 * What an OPERATOR sees instead of the raw tier key.
 *
 * `basic` and `pro` are billing words. On a tenant tree they told a platform
 * admin nothing actionable — the useful question is "how much of its capacity
 * is this tenant using", not "which SKU is it on". So the console shows a plan
 * name plus live usage, and the raw keys stay in the data model where the
 * limits are enforced.
 *
 * Shared with the API's limit messages deliberately: a console that never says
 * "basic" must not produce an error that does, or the operator is left looking
 * for a word that appears nowhere in the UI.
 */
export const PLAN_LABELS: Record<TenantTier, string> = {
  basic: "Standard",
  pro: "Expanded",
};

export function planLabel(tier: TenantTier): string {
  return PLAN_LABELS[tier] ?? tier;
}

/** The next plan up, or null at the top. Drives the upgrade hint. */
export function nextPlan(tier: TenantTier): TenantTier | null {
  return tier === "basic" ? "pro" : null;
}

// Basic tier is pooled (shared); Pro tier is siloed (dedicated) — mirrors the
// shared-table vs dedicated-table strategy in tenantContextMiddleware.
export function isolationForTier(tier: TenantTier): IsolationModel {
  return tier === "pro" ? "silo" : "pool";
}
