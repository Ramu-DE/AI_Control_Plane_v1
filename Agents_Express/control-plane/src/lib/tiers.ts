// Per-tier configuration — replicated from saas-gaming-app/src/middleware/tierMiddleware.ts
// and adapted to the agent control plane. Pro unlocks higher limits + features;
// basic is the shared/pooled default.

import { TenantTier, TierConfig, IsolationModel } from "./types";

export const TIER_CONFIGS: Record<TenantTier, TierConfig> = {
  basic: {
    maxAgents: 3,
    maxToolsPerAgent: 2,
    maxKnowledgeBases: 1,
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

// Basic tier is pooled (shared); Pro tier is siloed (dedicated) — mirrors the
// shared-table vs dedicated-table strategy in tenantContextMiddleware.
export function isolationForTier(tier: TenantTier): IsolationModel {
  return tier === "pro" ? "silo" : "pool";
}
