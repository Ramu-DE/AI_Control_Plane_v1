// Identity store singleton — isolated from the main `store.ts` so the
// identity controls can be added without disturbing existing state/shape.
//
// OFFLINE: no AWS, no network, no secrets. Metadata-only vault. Persisted to
// its own snapshot file, matching store.ts.
//
// SEAM: to wire real AgentCore later, back these arrays with AgentCore Identity
// (GetWorkloadAccessTokenForJWT, GetResourceOauth2Token OBO), the real Token
// Vault, and Secrets Manager — behind the same function signatures used here.

import { durableSingleton } from "../persist";
import { seedIdentity } from "./seed";
import type { IdentityState } from "./seed";

// Durable, like the other stores. A workload identity or a delegation profile
// is configuration a human entered; losing it on restart means re-entering it.
const durable = durableSingleton<IdentityState>({
  cacheKey: "__cpIdentityStore",
  fileSuffix: ".identity",
  label: "identity",
  seed: seedIdentity,
});

export const identityStore: IdentityState = durable.state;
export const flushIdentityStore = durable.flush;

/** Deterministic id generator for identity entities (no crypto randomness leak). */
let _counter = 0;
export function identityId(prefix: string): string {
  _counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_counter.toString(36)}`;
}
