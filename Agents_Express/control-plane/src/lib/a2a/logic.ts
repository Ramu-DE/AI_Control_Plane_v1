// Pure domain logic + the two-stage authorization gate for A2A calls.
//
// Everything here is deterministic and free of network I/O, so the governance
// rules are unit-testable offline. `authorizeCall` reads the policy store and
// delegates to the existing Cedar evaluator — it adds no new policy semantics,
// it just applies the evaluator twice at two different granularities.

import { evaluate } from "../evaluator";
import { store } from "../store";
import { validateOutboundUrl } from "../graph/logic";
import type { Policy, RecordStatus } from "../types";
import type { A2AAuthorization, A2APeer } from "./types";

// --------------------------------------------------------------------------- //
// Cedar resource naming
// --------------------------------------------------------------------------- //

/** The A2A perimeter resource: "may this caller use A2A at all?" */
export const A2A_PERIMETER_TOOL = "a2a";

/** The Cedar action every A2A call is evaluated against. */
export const A2A_ACTION = "callAgent";

/** The peer-scoped resource: "may this caller reach THIS peer?" */
export function peerScopedTool(peerId: string): string {
  return `${A2A_PERIMETER_TOOL}:${peerId}`;
}

/**
 * Does any enabled gateway policy explicitly name this peer as its resource?
 * Pure — takes the policy list rather than reading the store, so it can be
 * tested directly.
 *
 * When no policy names the peer, the perimeter decision stands alone. When one
 * does, it becomes authoritative for that peer (enabling "who may call whom"
 * without changing the evaluator).
 */
export function peerScopedPolicyExists(policies: Policy[], peerId: string): boolean {
  const needle = `Tool::"${peerScopedTool(peerId)}"`;
  return policies.some(
    (p) => p.enabled && p.layer === "gateway" && p.cedar.includes(needle)
  );
}

/**
 * Two-stage Cedar check run before any A2A egress.
 *
 * Stage 1 (always): the A2A perimeter. Deny here ends it.
 * Stage 2 (conditional): a peer-scoped rule, evaluated only when such a policy
 * exists. This keeps the default behaviour simple while allowing precise
 * per-peer grants, and it fails closed — a peer-scoped policy that does not
 * permit blocks the call even though the perimeter allowed it.
 */
export function authorizeCall(peerId: string, personaId: string): A2AAuthorization {
  const perimeterResult = evaluate({
    personaId,
    agentId: "a2a-router",
    action: A2A_ACTION,
    tool: A2A_PERIMETER_TOOL,
    resource: peerId,
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
      peerScoped: {
        evaluated: false,
        reason: "not evaluated — the A2A perimeter denied the call",
      },
    };
  }

  if (!peerScopedPolicyExists(store.policies, peerId)) {
    return {
      allowed: true,
      perimeter,
      peerScoped: {
        evaluated: false,
        reason: `no policy names Tool::"${peerScopedTool(peerId)}" — perimeter decision stands`,
      },
    };
  }

  const scopedResult = evaluate({
    personaId,
    agentId: "a2a-router",
    action: A2A_ACTION,
    tool: peerScopedTool(peerId),
    resource: peerId,
  });
  const sd = scopedResult.decisions[0];
  return {
    allowed: scopedResult.allowed,
    perimeter,
    peerScoped: {
      evaluated: true,
      allowed: scopedResult.allowed,
      reason: sd?.reason ?? "no decision recorded",
      ...(sd?.matchedPolicyId ? { matchedPolicyId: sd.matchedPolicyId } : {}),
    },
  };
}

// --------------------------------------------------------------------------- //
// Peer registration validation
// --------------------------------------------------------------------------- //

export interface RegisterPeerInput {
  peerId?: string;
  displayName?: string;
  description?: string;
  tenantId?: string;
  endpoint?: string;
  allowedHosts?: string[];
  auth?: A2APeer["auth"];
}

/** Peer ids are used in Cedar resource strings, so keep them conservative. */
const PEER_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Validate a registration request. Returns an error string, or null when valid.
 *
 * The endpoint rules mirror the graph control plane: a placeholder endpoint is
 * accepted so a peer can be registered and previewed before it exists, but a
 * CONFIGURED endpoint is live egress and must be pinned to a non-empty
 * allowlist that matches its hostname.
 */
export function validateRegisterPeer(input: RegisterPeerInput): string | null {
  if (!input.peerId?.trim() || !input.displayName?.trim()) {
    return "peerId and displayName are required";
  }
  if (!PEER_ID_RE.test(input.peerId.trim())) {
    return "peerId must be lowercase alphanumeric with hyphens (2-63 chars)";
  }
  if (!input.tenantId?.trim()) {
    return "tenantId is required";
  }
  if (!input.endpoint?.trim()) {
    return "endpoint is required";
  }
  if (input.auth?.kind === "bearer-env" && !input.auth.authEnvVar?.trim()) {
    return "authEnvVar is required when auth kind is 'bearer-env'";
  }

  const endpoint = input.endpoint.trim();
  const allowed = input.allowedHosts;
  const probe = validateOutboundUrl(endpoint);
  if (probe.placeholder) return null; // preview-only registration is permitted
  if (!probe.ok) return `endpoint rejected: ${probe.reason}`;
  if (!allowed || allowed.length === 0) {
    return "endpoint is configured but allowedHosts is empty; a live A2A endpoint must be pinned to an allowlist";
  }
  const pinned = validateOutboundUrl(endpoint, allowed);
  if (!pinned.ok) return `endpoint rejected: ${pinned.reason}`;
  return null;
}

/** True when the peer's endpoint is real, SSRF-safe, and allowlisted. */
export function isPeerCallable(peer: A2APeer): boolean {
  if (!peer.endpoint) return false;
  return validateOutboundUrl(peer.endpoint, peer.allowedHosts).ok;
}

// --------------------------------------------------------------------------- //
// Lifecycle — identical state machine to registry records and graph sources
// --------------------------------------------------------------------------- //

export const A2A_TRANSITIONS: Record<RecordStatus, RecordStatus[]> = {
  Draft: ["Pending approval"],
  "Pending approval": ["Approved", "Rejected"],
  Approved: ["Deprecated"],
  Rejected: ["Draft"],
  Deprecated: [],
};

export function canTransition(from: RecordStatus, to: RecordStatus): boolean {
  return A2A_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Parse a comma/space/newline separated host list into an allowlist. */
export function parseAllowedHosts(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}
