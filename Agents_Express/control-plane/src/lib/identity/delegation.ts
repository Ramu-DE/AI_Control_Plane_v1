// Delegation chains (PDF "The confused deputy: the agent's rights must not
// decide" + anti-pattern #6 "Uncontrolled Cross-Agent Delegation").
//
// Rules enforced:
//  - Every hop carries the SAME originating user (sub=user) and act=agent.
//  - Child scopes MUST be a subset of the parent's ("scope shrinks at every hop").
//  - The CEILING is the ROOT USER's scopes — never the agent's own rights
//    (confused-deputy denial: authorization is decided by the user, not the
//    agent). An agent cannot widen scope beyond what the user holds.
//  - Cross-agent delegation requires EXPLICIT policy authorization (from→to).
//  - The full chain is recorded for the audit trail.
//
// Pure, deterministic, no I/O.

import type { ID } from "../types";
import type {
  DelegationChain,
  DelegationHop,
  DelegationPolicy,
  DelegationResult,
} from "./types";
import { isSubset, excessScopes } from "./scopes";
import { opaqueHandle } from "./util";

export interface DelegationRequest {
  rootUserSub: string;
  /** The scopes the originating USER actually holds (the hard ceiling). */
  rootScopes: string[];
  hops: Omit<DelegationHop, "userSub">[];
}

/**
 * Authorize and build a delegation chain. Denies (confused-deputy style) when:
 *  - a hop user differs from the root user (JWT must stop at the user),
 *  - a child hop's scopes exceed the parent's (no scope widening),
 *  - any hop exceeds the root user's held scopes (agent rights don't decide),
 *  - a cross-agent hop is not explicitly authorized by policy.
 */
export function authorizeDelegation(
  req: DelegationRequest,
  policy: DelegationPolicy
): DelegationResult {
  const reasons: string[] = [];

  if (req.hops.length === 0) {
    return { authorized: false, reasons: ["no delegation hops provided"] };
  }

  // Parent scope ceiling starts at the ROOT USER's scopes. This is the crux of
  // confused-deputy denial: the chain is bounded by the user, not by any
  // agent's own (possibly broader) permissions.
  let parentScopes = req.rootScopes;

  const builtHops: DelegationHop[] = [];
  for (let i = 0; i < req.hops.length; i++) {
    const hop = req.hops[i];

    // 1) explicit policy authorization for this from→to pair.
    const allowed = policy.allow.some(
      (a) => a.fromAgent === hop.fromAgent && a.toAgent === hop.toAgent
    );
    if (!allowed) {
      reasons.push(
        `hop ${i + 1}: cross-agent delegation ${hop.fromAgent} → ${hop.toAgent} is not authorized by policy '${policy.id}'`
      );
    }

    // 2) child scopes must be a subset of the parent's (scope shrinks).
    if (!isSubset(hop.scopes, parentScopes)) {
      const excess = excessScopes(hop.scopes, parentScopes);
      reasons.push(
        `hop ${i + 1}: child scopes exceed parent — would widen by [${excess.join(", ")}] (confused-deputy denial: the agent's rights must not decide)`
      );
    }

    // 3) and must never exceed the root user's ceiling (belt and suspenders).
    if (!isSubset(hop.scopes, req.rootScopes)) {
      const excess = excessScopes(hop.scopes, req.rootScopes);
      reasons.push(
        `hop ${i + 1}: scopes [${excess.join(", ")}] exceed the originating user's held scopes`
      );
    }

    builtHops.push({ ...hop, userSub: req.rootUserSub });
    // The next hop's ceiling is THIS hop's (already-narrowed) scopes.
    parentScopes = hop.scopes;
  }

  if (reasons.length > 0) {
    return { authorized: false, reasons };
  }

  const chain: DelegationChain = {
    id: opaqueHandle("chain"),
    rootUserSub: req.rootUserSub,
    rootScopes: [...req.rootScopes],
    hops: builtHops,
    createdAt: new Date().toISOString(),
  };
  return { authorized: true, reasons: [], chain };
}

/** Validate an already-built chain (e.g. loaded from the store). */
export function validateChain(
  chain: DelegationChain,
  policy: DelegationPolicy
): DelegationResult {
  return authorizeDelegation(
    {
      rootUserSub: chain.rootUserSub,
      rootScopes: chain.rootScopes,
      hops: chain.hops.map(({ userSub: _userSub, ...rest }) => rest),
    },
    policy
  );
}

/** The effective (narrowest) scopes at the end of a chain. */
export function effectiveScopes(chain: DelegationChain): string[] {
  if (chain.hops.length === 0) return [...chain.rootScopes];
  return [...chain.hops[chain.hops.length - 1].scopes];
}

export type { ID };
