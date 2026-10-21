// Pure, offline helpers for the identity simulation.
//
// No network, no AWS, no randomness that leaves the process. `node:crypto` is
// used only for local hashing (audit chain) and opaque-handle derivation. These
// handles are NOT secrets — they are references that index vault metadata.

import { createHash, randomUUID } from "node:crypto";

/** Stable SHA-256 hex over a string. Used for the audit hash chain. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Derive an OPAQUE handle. The handle is a hash of a label + a fresh UUID, so
 * it is unique and reveals nothing. It is explicitly NOT a credential: it only
 * indexes metadata held in the in-memory vault.
 */
export function opaqueHandle(label: string): string {
  return `${label}_${sha256(`${label}:${randomUUID()}`).slice(0, 24)}`;
}

/** A secret REFERENCE (ARN-shaped). Never a secret value. */
export function secretReference(agentId: string): string {
  return `arn:aws:secretsmanager:simulated:000000000000:secret:agent/${agentId}/client-secret-${sha256(
    agentId
  ).slice(0, 6)}`;
}

/** Canonical JSON (stable key order) for hashing event bodies. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Glob match supporting `*` (any run) and `?` (single char). Anchored. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}
