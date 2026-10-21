// Outbound patterns — how the agent calls downstream (PDF "THE PATTERNS · OUTBOUND").
//
//  iam → agent assumes an execution role. No user, no token vault needed.
//        (L2 scanner: scoped to s3:GetBucketPolicy, iam:ListPolicies, dynamodb:PutItem)
//  m2m → client credentials (2LO). Agent acts as ITSELF. Claims: sub=<bot>, aud, scope.
//  3lo → authorization-code grant. Acts FOR the user after one-time consent.
//        Claims: sub=<user>, client_id=<agent>, scope. (Jira: write:jira-work)
//  obo → on-behalf-of token exchange. Claims: sub=<user>, cid=<agent>, aud=<resource>.
//        (MS Graph: Mail.Read, sub=John act=Agent)
//
// Each pattern yields SIMULATED (unsigned, marked) claims + the issuance inputs
// for the vault. No raw token is ever produced. Pure, deterministic, no I/O.

import { SIMULATED } from "./types";
import type {
  ConsentGrant,
  OutboundPattern,
  SimulatedClaims,
  ToolAuthBinding,
  VaultKey,
} from "./types";
import { minimumScopes } from "./scopes";

export interface OutboundContext {
  /** The agent whose identity is making the call. */
  agentId: string;
  /** The agent's workload client_id (for 3LO/OBO claims + M2M principal). */
  agentClientId: string;
  /** The bot principal name used as sub for M2M (agent acts as itself). */
  botPrincipal: string;
  /** The authenticated user (required for 3LO/OBO; null for iam/m2m). */
  userSub: string | null;
  tenantId: string;
}

export interface OutboundPlan {
  pattern: OutboundPattern;
  key: VaultKey;
  scopes: string[];
  withRefresh: boolean;
  claims: SimulatedClaims;
  /** True when a 3LO consent grant is required before issuance. */
  requiresConsent: boolean;
}

/**
 * Build the issuance plan for a tool binding under a given context. Applies
 * minimum-viable scoping (incremental scopes are NOT requested up front).
 */
export function planOutbound(
  binding: ToolAuthBinding,
  ctx: OutboundContext
): { ok: boolean; reason?: string; plan?: OutboundPlan } {
  const scopes = minimumScopes(binding.minScopes, binding.incrementalScopes);
  const resource = binding.resource;
  const agentId = ctx.agentId;

  switch (binding.pattern) {
    case "iam": {
      // No user, no token; the agent assumes an execution role.
      const key: VaultKey = { tenantId: ctx.tenantId, agentId, userSub: null, resource };
      const claims: SimulatedClaims = {
        sub: ctx.botPrincipal,
        aud: resource,
        scope: scopes.join(" "),
        marker: SIMULATED,
      };
      return { ok: true, plan: { pattern: "iam", key, scopes, withRefresh: false, claims, requiresConsent: false } };
    }
    case "m2m": {
      const key: VaultKey = { tenantId: ctx.tenantId, agentId, userSub: null, resource };
      const claims: SimulatedClaims = {
        sub: ctx.botPrincipal, // acts as itself
        aud: resource,
        scope: scopes.join(" "),
        marker: SIMULATED,
      };
      return { ok: true, plan: { pattern: "m2m", key, scopes, withRefresh: false, claims, requiresConsent: false } };
    }
    case "3lo": {
      if (!ctx.userSub) return { ok: false, reason: "3LO requires an authenticated user" };
      const key: VaultKey = { tenantId: ctx.tenantId, agentId, userSub: ctx.userSub, resource };
      const claims: SimulatedClaims = {
        sub: ctx.userSub, // acts for the user
        cid: ctx.agentClientId, // client_id of the agent
        aud: resource,
        scope: scopes.join(" "),
        marker: SIMULATED,
      };
      return { ok: true, plan: { pattern: "3lo", key, scopes, withRefresh: true, claims, requiresConsent: true } };
    }
    case "obo": {
      if (!ctx.userSub) return { ok: false, reason: "OBO requires an authenticated user" };
      const key: VaultKey = { tenantId: ctx.tenantId, agentId, userSub: ctx.userSub, resource };
      const claims: SimulatedClaims = {
        sub: ctx.userSub, // token stays in the user's name
        act: "agent", // act=agent attribution
        cid: ctx.agentClientId,
        aud: resource,
        scope: scopes.join(" "),
        marker: SIMULATED,
      };
      // OBO needs no extra user consent (token exchange), but still refreshable.
      return { ok: true, plan: { pattern: "obo", key, scopes, withRefresh: true, claims, requiresConsent: false } };
    }
  }
}

/** True iff a (user, agent, resource) consent grant exists and covers scopes. */
export function hasConsent(
  consents: ConsentGrant[],
  userSub: string,
  agentId: string,
  resource: string,
  scopes: string[]
): boolean {
  const g = consents.find(
    (c) =>
      c.userSub === userSub &&
      c.agentId === agentId &&
      c.resource === resource &&
      c.revokedAt === null
  );
  if (!g) return false;
  return scopes.every((s) => g.scopes.includes(s));
}
