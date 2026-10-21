// Per-agent workload identity lifecycle (PDF anti-pattern #2 fix:
// "Per-agent workload identity (own client_id + secret)",
// "Independent rotation per agent", "Secrets Manager with automatic rotation").
//
// OFFLINE: the "secret" is never generated or stored here. We only mint an
// opaque client_id and a secret REFERENCE (ARN-shaped) that would point at a
// Secrets Manager secret in a real deployment. Pure functions over a passed-in
// array so the store stays the single source of truth.

import type { ID } from "../types";
import type { RotationState, WorkloadIdentity } from "./types";
import { opaqueHandle, secretReference } from "./util";

export function createWorkloadIdentity(agentId: ID): WorkloadIdentity {
  const now = new Date().toISOString();
  return {
    id: opaqueHandle("wid"),
    agentId,
    clientId: opaqueHandle(`client_${agentId}`),
    secretRef: secretReference(agentId),
    createdAt: now,
    rotatedAt: null,
    rotationState: "fresh",
    status: "active",
  };
}

/**
 * Rotate the workload identity's secret independently of other agents. We mint
 * a NEW secret reference (the old one would be scheduled for deletion by
 * Secrets Manager). No secret value is ever present.
 */
export function rotateWorkloadIdentity(w: WorkloadIdentity): WorkloadIdentity {
  if (w.status === "revoked") {
    throw new Error("cannot rotate a revoked workload identity");
  }
  const now = new Date().toISOString();
  return {
    ...w,
    secretRef: secretReference(`${w.agentId}:${now}`),
    rotatedAt: now,
    rotationState: "fresh" as RotationState,
  };
}

/** Revoke the workload identity — the agent can no longer authenticate. */
export function revokeWorkloadIdentity(w: WorkloadIdentity): WorkloadIdentity {
  return { ...w, status: "revoked", rotationState: "stale" };
}
