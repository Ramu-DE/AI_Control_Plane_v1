// Which models a tenant may invoke — PURE, so it is testable and shared.
//
// Adopted from the Secure-AI-Agents-on-EKS pattern, where the lesson is in the
// IAM, not the diagram. In that workshop the agent's own role carries exactly
// three DynamoDB actions on one table ARN and NO Bedrock permission at all.
// Model access lives only behind a gateway whose role is scoped to ten named
// model ARNs.
//
// This control plane had the opposite shape. `lib/databricks.ts` and
// `lib/bedrock.ts` read the credential from the process environment, and any
// code path that could reach them could invoke any model that credential
// permitted. `planeMismatch` already decided WHERE a model runs, but that was
// advisory — a check on the way in, not a boundary.
//
// So: an allowlist per tenant, INHERITED down the tenant tree, and one broker
// (lib/modelBroker.ts) that is the only thing allowed to call a provider.
//
// Free of server-only imports so a form can narrow its own picker rather than
// offering a model the server will refuse.

import { executorFor, planeMismatch } from "./plane";
import type { CatalogModel, Tenant } from "./types";

export interface ModelAllowlist {
  /** The model ids permitted, or null when this subtree is unrestricted. */
  modelIds: string[] | null;
  /** The tenant the rule came from — not necessarily the one asked about. */
  inheritedFrom: string | null;
}

/**
 * The effective allowlist for a tenant, walking UP to the nearest ancestor
 * that declares one.
 *
 * Inheritance rather than per-tenant declaration because the tenant tree is 32
 * nodes deep in places: requiring every sub-unit to restate the org's model
 * policy guarantees that one of them will not, and the omission reads as
 * "unrestricted" — a default that fails open.
 *
 * `undefined` on a tenant means "inherit"; an explicit `[]` means "no models at
 * all", which is a real and different statement. Conflating them would make it
 * impossible to freeze a tenant without deleting it.
 *
 * Cycle-safe: tenant trees come from data, and a bad `parentId` must not hang
 * the request.
 */
export function effectiveModelAllowlist(
  tenantId: string,
  tenants: Tenant[]
): ModelAllowlist {
  const byId = new Map(tenants.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let cursor: Tenant | undefined = byId.get(tenantId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const declared = cursor.allowedModelIds;
    if (declared !== undefined) {
      return { modelIds: [...declared], inheritedFrom: cursor.id };
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return { modelIds: null, inheritedFrom: null };
}

export interface ModelDecision {
  allowed: boolean;
  reason: string;
  /** Which tenant's rule decided it, for the audit trail. */
  decidedBy: string | null;
}

export interface AuthorizeModelInput {
  tenantId: string;
  modelId: string;
  tenants: Tenant[];
  models: CatalogModel[];
  /** The agent's declared model runtime, when there is one to check. */
  modelRuntimeId?: string;
}

/**
 * May this tenant invoke this model, on this runtime?
 *
 * Three questions in a fixed order, each failing closed:
 *   1. is the model in the catalog at all
 *   2. does the tenant's allowlist admit it
 *   3. does the declared runtime agree with where the model is really served
 *
 * Step 3 reuses `planeMismatch` rather than restating it. That rule already
 * exists in one place precisely because a second copy drifted once before and
 * covered two of five providers.
 */
export function authorizeModel(input: AuthorizeModelInput): ModelDecision {
  const model = input.models.find((m) => m.id === input.modelId);
  if (!model) {
    return {
      allowed: false,
      decidedBy: null,
      reason:
        `model '${input.modelId}' is not in the platform catalog, so no ` +
        `credential may be used for it`,
    };
  }

  const allowlist = effectiveModelAllowlist(input.tenantId, input.tenants);
  if (allowlist.modelIds !== null && !allowlist.modelIds.includes(input.modelId)) {
    return {
      allowed: false,
      decidedBy: allowlist.inheritedFrom,
      reason:
        `model '${model.name}' is not on the allowlist for tenant ` +
        `'${input.tenantId}' (rule set on '${allowlist.inheritedFrom}', ` +
        `${allowlist.modelIds.length} model(s) permitted)`,
    };
  }

  if (input.modelRuntimeId) {
    const mismatch = planeMismatch(input.modelRuntimeId, model.inferenceProvider);
    if (mismatch) {
      return { allowed: false, decidedBy: allowlist.inheritedFrom, reason: mismatch };
    }
  }

  return {
    allowed: true,
    decidedBy: allowlist.inheritedFrom,
    reason:
      allowlist.modelIds === null
        ? `no model allowlist is set for this subtree; '${model.name}' permitted ` +
          `on the ${executorFor(model)} plane`
        : `'${model.name}' is on the allowlist for '${allowlist.inheritedFrom}'`,
  };
}

/**
 * Catalog models a tenant may actually use.
 *
 * Offered so a picker shows what will work instead of what the server will
 * later refuse — the same reason `modelsForRuntime` exists.
 */
export function modelsForTenant<T extends CatalogModel>(
  models: T[],
  tenantId: string,
  tenants: Tenant[]
): T[] {
  const allowlist = effectiveModelAllowlist(tenantId, tenants);
  if (allowlist.modelIds === null) return models;
  return models.filter((m) => allowlist.modelIds!.includes(m.id));
}
