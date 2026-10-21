// In-memory identity store singleton — isolated from the main `store.ts` so the
// identity controls can be added without disturbing existing state/shape.
//
// OFFLINE: no AWS, no network, no secrets. Metadata-only vault. A module-level
// singleton persisted on globalThis survives dev hot-reloads, matching store.ts.
//
// SEAM: to wire real AgentCore later, back these arrays with AgentCore Identity
// (GetWorkloadAccessTokenForJWT, GetResourceOauth2Token OBO), the real Token
// Vault, and Secrets Manager — behind the same function signatures used here.

import { seedIdentity } from "./seed";
import type { IdentityState } from "./seed";

const globalForIdentity = globalThis as unknown as {
  __cpIdentityStore?: IdentityState;
};

export const identityStore: IdentityState =
  globalForIdentity.__cpIdentityStore ?? seedIdentity();
if (!globalForIdentity.__cpIdentityStore) {
  globalForIdentity.__cpIdentityStore = identityStore;
}

/** Deterministic id generator for identity entities (no crypto randomness leak). */
let _counter = 0;
export function identityId(prefix: string): string {
  _counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_counter.toString(36)}`;
}
