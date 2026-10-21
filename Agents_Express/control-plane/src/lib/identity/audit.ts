// Attributable, immutable-style identity audit (PDF anti-pattern #5:
// "No agent identity distinction in audit"; "Audit tied to agent and
// originating user"; "Audit records the full delegation chain").
//
// Append-only, tamper-evident hash chain: each event's hash covers the previous
// hash plus the canonical event body. Any mutation of an earlier event breaks
// the chain and is detectable. Pure functions over a passed-in array.

import type { ID } from "../types";
import type {
  IdentityAuditAttribution,
  IdentityAuditEvent,
} from "./types";
import { canonicalJson, sha256 } from "./util";

export interface NewIdentityAudit {
  id: ID;
  action: string;
  actor: string;
  detail: string;
  attribution: IdentityAuditAttribution;
  at: string;
}

function hashEvent(prevHash: string, body: Omit<IdentityAuditEvent, "hash">): string {
  return sha256(prevHash + canonicalJson({ ...body }));
}

/**
 * Append a new identity audit event to the chain, computing its prevHash/hash.
 * The caller mutates `chain` (push) with the returned event.
 */
export function appendIdentityAudit(
  chain: IdentityAuditEvent[],
  evt: NewIdentityAudit
): IdentityAuditEvent {
  const prevHash = chain.length > 0 ? chain[chain.length - 1].hash : "";
  const bodyWithoutHash: Omit<IdentityAuditEvent, "hash"> = {
    id: evt.id,
    action: evt.action,
    actor: evt.actor,
    detail: evt.detail,
    attribution: evt.attribution,
    at: evt.at,
    prevHash,
  };
  const hash = hashEvent(prevHash, bodyWithoutHash);
  const full: IdentityAuditEvent = { ...bodyWithoutHash, hash };
  chain.push(full);
  return full;
}

export interface ChainVerification {
  valid: boolean;
  /** Index of the first broken link, or -1 when the chain is intact. */
  brokenAt: number;
  reason?: string;
}

/** Verify the hash chain is intact (tamper-evident). */
export function verifyChain(chain: IdentityAuditEvent[]): ChainVerification {
  let prevHash = "";
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (e.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: "prevHash mismatch" };
    }
    const { hash, ...body } = e;
    const expected = hashEvent(prevHash, body);
    if (expected !== hash) {
      return { valid: false, brokenAt: i, reason: "hash mismatch (event body altered)" };
    }
    prevHash = e.hash;
  }
  return { valid: true, brokenAt: -1 };
}
