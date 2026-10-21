// Token VAULT — METADATA ONLY (PDF anti-patterns #4 and #5 fixes).
//
// Invariants enforced here:
//  - Isolation by composite key tenant+agent+user+resource (anti-pattern #4).
//  - NO raw token/secret is ever stored — only opaque handles + metadata.
//  - TTL enforcement (short-lived access, 5–15 min) + JIT session binding:
//    retrieval only during an active session (anti-pattern #5).
//  - One-time-use refresh handles with replay detection; a replay revokes the
//    whole lineage (anti-pattern #4: "one-time-use refresh tokens").
//  - Server-side revocation on lifecycle events.
//
// Pure functions over passed-in arrays; the store owns the arrays.

import type { ID } from "../types";
import type {
  OutboundPattern,
  Session,
  SimulatedClaims,
  VaultEntry,
  VaultKey,
} from "./types";
import { opaqueHandle } from "./util";

export function keysEqual(a: VaultKey, b: VaultKey): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.agentId === b.agentId &&
    a.userSub === b.userSub &&
    a.resource === b.resource
  );
}

export function keyString(k: VaultKey): string {
  return `${k.tenantId}|${k.agentId}|${k.userSub ?? "-"}|${k.resource}`;
}

export interface IssueInput {
  key: VaultKey;
  pattern: OutboundPattern;
  scopes: string[];
  ttlSeconds: number;
  /** Must reference an ACTIVE session — JIT binding (unbound issuance denied). */
  session: Session | null;
  claims: SimulatedClaims;
  /** Whether this pattern mints a refresh handle (3LO/OBO yes; IAM/M2M no). */
  withRefresh: boolean;
  now?: Date;
}

export interface IssueResult {
  ok: boolean;
  reason?: string;
  entry?: VaultEntry;
}

/** JIT issuance — only while a session is active (no standing access). */
export function issue(input: IssueInput): IssueResult {
  const now = input.now ?? new Date();
  if (!input.session) {
    return { ok: false, reason: "no active session — JIT issuance requires a bound session" };
  }
  if (!input.session.active) {
    return { ok: false, reason: "session is not active" };
  }
  if (new Date(input.session.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: "session has expired" };
  }
  if (input.session.agentId !== input.key.agentId) {
    return { ok: false, reason: "session agent does not match vault key agent" };
  }
  // The user bound to the session must match the key's user (when user-scoped).
  if (input.key.userSub !== null && input.session.userSub !== input.key.userSub) {
    return { ok: false, reason: "session user does not match vault key user" };
  }
  if (input.ttlSeconds <= 0 || input.ttlSeconds > 900) {
    return { ok: false, reason: "ttl must be short-lived (1..900 seconds)" };
  }

  const lineageId = opaqueHandle("lineage");
  const entry: VaultEntry = {
    id: opaqueHandle("vault"),
    key: input.key,
    handle: opaqueHandle("tok"),
    pattern: input.pattern,
    scopes: [...input.scopes],
    ttlSeconds: input.ttlSeconds,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
    refreshHandle: input.withRefresh ? opaqueHandle("refresh") : null,
    refreshConsumed: false,
    sessionId: input.session.id,
    revoked: false,
    lineageId,
    claims: input.claims,
  };
  return { ok: true, entry };
}

export interface ActiveCheck {
  active: boolean;
  reason?: string;
}

/**
 * Is the entry currently usable? Enforces TTL, revocation, and session binding
 * (the bound session must still be active and unexpired).
 */
export function getActive(
  entry: VaultEntry,
  sessions: Session[],
  now: Date = new Date()
): ActiveCheck {
  if (entry.revoked) return { active: false, reason: "entry revoked" };
  if (new Date(entry.expiresAt).getTime() <= now.getTime()) {
    return { active: false, reason: "access token expired (TTL)" };
  }
  if (!entry.sessionId) {
    return { active: false, reason: "entry is not session-bound (no standing access)" };
  }
  const sess = sessions.find((s) => s.id === entry.sessionId);
  if (!sess) return { active: false, reason: "bound session not found" };
  if (!sess.active) return { active: false, reason: "bound session inactive" };
  if (new Date(sess.expiresAt).getTime() <= now.getTime()) {
    return { active: false, reason: "bound session expired" };
  }
  return { active: true };
}

export interface RefreshResult {
  ok: boolean;
  reason?: string;
  /** The new rotated entry on success. */
  rotated?: VaultEntry;
  /** True when a replay was detected (reused consumed refresh handle). */
  replayDetected?: boolean;
  /** Entry ids in the lineage that must be revoked on replay. */
  revokeLineageId?: string;
}

/**
 * Rotate using a one-time refresh handle. Presenting the SAME refresh handle a
 * second time is a replay: we flag it and signal the caller to revoke the whole
 * lineage. On success, a new entry with a fresh refresh handle is returned and
 * the old entry's refresh handle is marked consumed by the caller.
 */
export function rotateRefresh(
  entry: VaultEntry,
  presentedRefreshHandle: string,
  now: Date = new Date()
): RefreshResult {
  if (!entry.refreshHandle) {
    return { ok: false, reason: "entry has no refresh handle" };
  }
  if (entry.refreshConsumed) {
    // Reuse of an already-consumed refresh handle → replay.
    return {
      ok: false,
      reason: "refresh handle already consumed — replay detected",
      replayDetected: true,
      revokeLineageId: entry.lineageId,
    };
  }
  if (presentedRefreshHandle !== entry.refreshHandle) {
    return { ok: false, reason: "refresh handle mismatch" };
  }
  if (entry.revoked) {
    return { ok: false, reason: "entry revoked" };
  }

  const rotated: VaultEntry = {
    ...entry,
    id: opaqueHandle("vault"),
    handle: opaqueHandle("tok"),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + entry.ttlSeconds * 1000).toISOString(),
    refreshHandle: opaqueHandle("refresh"),
    refreshConsumed: false,
    // lineageId preserved so a later replay can revoke the whole chain.
  };
  return { ok: true, rotated };
}

export type RevokeSelector =
  | { by: "entry"; id: ID }
  | { by: "lineage"; lineageId: string }
  | { by: "session"; sessionId: ID }
  | { by: "key"; key: VaultKey }
  | { by: "agent"; agentId: ID }
  | { by: "user"; userSub: string };

/** Server-side revocation on a lifecycle event. Returns the ids revoked. */
export function revokeByEvent(
  entries: VaultEntry[],
  selector: RevokeSelector
): ID[] {
  const revoked: ID[] = [];
  for (const e of entries) {
    if (e.revoked) continue;
    let hit = false;
    switch (selector.by) {
      case "entry":
        hit = e.id === selector.id;
        break;
      case "lineage":
        hit = e.lineageId === selector.lineageId;
        break;
      case "session":
        hit = e.sessionId === selector.sessionId;
        break;
      case "key":
        hit = keysEqual(e.key, selector.key);
        break;
      case "agent":
        hit = e.key.agentId === selector.agentId;
        break;
      case "user":
        hit = e.key.userSub === selector.userSub;
        break;
    }
    if (hit) {
      e.revoked = true;
      revoked.push(e.id);
    }
  }
  return revoked;
}

/**
 * The redacted, API-safe view of a vault entry. This is what any GET returns.
 * It asserts (by construction) that NO token/secret value is present — only
 * metadata and opaque handles.
 */
export function redactEntry(e: VaultEntry): Omit<VaultEntry, "claims"> & {
  claims: Omit<SimulatedClaims, never>;
} {
  // Entries already hold no raw secret; this is the identity projection used to
  // make the "metadata only" guarantee explicit and testable.
  return e;
}
