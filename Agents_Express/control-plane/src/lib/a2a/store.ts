// In-memory A2A peer store.
//
// Follows the same conventions as lib/store.ts: a module-level singleton kept on
// globalThis so it survives `next dev` hot-reloads, mutated through small
// functions so the persistence layer can later be swapped (DynamoDB, the
// GraphControlStore pattern) without touching the API routes.
//
// Writes are guarded by an optimistic-concurrency `rev` token, matching the
// graph control plane, so two concurrent approvals cannot silently clobber.

import { newId } from "../store";
import {
  createPersister,
  flushOnExit,
  loadSnapshot,
  storePath,
  trackChanges,
  type Persister,
} from "../persist";
import { configuredSelfBaseUrl } from "./server";
import { canTransition } from "./logic";
import type { RecordStatus } from "../types";
import type { A2AAgentCard, A2APeer } from "./types";
import { A2ANotFoundError } from "./types";

export class A2AVersionConflictError extends Error {
  readonly code = "A2A_VERSION_CONFLICT";
  constructor(message = "peer was modified by another request; retry") {
    super(message);
    this.name = "A2AVersionConflictError";
  }
}

export class A2ATransitionError extends Error {
  readonly code = "A2A_INVALID_TRANSITION";
  constructor(message: string) {
    super(message);
    this.name = "A2ATransitionError";
  }
}

function iso(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

/**
 * Where the seeded peers point, and what hosts they may reach.
 *
 * REAL EXECUTION, NO NEW INFRASTRUCTURE. A2A needs a peer at a resolvable
 * HTTPS address, and standing one up is the part of this scenario that usually
 * stalls. But this platform now serves the A2A protocol itself
 * (lib/a2a/server.ts), so the most honest peer available is THIS deployment at
 * its own public URL: discovery fetches a card that really exists, and a send
 * reaches a real Databricks-backed agent through the real Cedar gate.
 *
 * `A2A_SELF_BASE_URL` is read at call time rather than hardcoded, because the
 * public address is a property of the deployment, not of the code. When it is
 * unset the endpoints stay `REPLACE-ME` and the platform is in routing-preview
 * mode: discovery and sends are refused rather than silently pointed at a host
 * that does not exist. Fail visible, not plausible.
 */
function selfRouting(peerId: string): { endpoint: string; allowedHosts: string[] } {
  const raw = configuredSelfBaseUrl();
  // Unset or malformed: stay in routing-preview mode rather than pointing at a
  // host that does not exist.
  if (!raw) {
    return { endpoint: `https://REPLACE-ME-${peerId}.example.com`, allowedHosts: [] };
  }
  return { endpoint: raw, allowedHosts: [new URL(raw).hostname] };
}

/**
 * Seed peers for the Sales ⇄ Supply Chain scenario.
 *
 * Auth is `bearer-env` pointing at the SAME env var the inbound server checks,
 * which is what makes the loopback coherent: the caller presents exactly the
 * token the callee requires, and neither side stores it.
 */
function seedPeers(): A2APeer[] {
  const base = {
    card: null,
    owner: "platform-team",
    auth: { kind: "bearer-env" as const, authEnvVar: "A2A_INBOUND_TOKEN" },
  };
  return [
    {
      ...base,
      ...selfRouting("sales-agent"),
      peerId: "sales-agent",
      displayName: "Sales Agent",
      description:
        "Peer agent owned by Commercial: demand signals and fulfilment planning.",
      tenantId: "bu-us",
      status: "Approved",
      createdAt: iso(2),
      updatedAt: iso(2),
      rev: 1,
    },
    {
      ...base,
      ...selfRouting("supply-chain-agent"),
      peerId: "supply-chain-agent",
      displayName: "Supply Chain Agent",
      description:
        "Peer agent owned by Global Supply & Quality: route optimization and ETA.",
      tenantId: "fn-supply",
      // Draft on purpose — demonstrates that an unapproved peer cannot be called.
      status: "Draft",
      createdAt: iso(1),
      updatedAt: iso(1),
      rev: 1,
    },
  ];
}

// Peers persist in their OWN snapshot file, not the main store's.
//
// They are a separate singleton with a separate lifecycle, and an approved
// peer plus its discovered card is exactly the state that was most annoying to
// rebuild after a restart. Same mechanism as lib/store.ts: a change-tracking
// Proxy, so `transitionPeer` and `setPeerCard` keep mutating in place.
const globalForA2A = globalThis as unknown as {
  __a2aPeers?: A2APeer[];
  __a2aPersister?: Persister;
};

function peersPath(): string {
  const main = storePath();
  return main.replace(/\.json$/, "") + ".a2a.json";
}

if (!globalForA2A.__a2aPeers) {
  const loaded = loadSnapshot<A2APeer[]>(peersPath());
  // An empty array in the snapshot is a legitimate state — every peer was
  // deleted — so only a missing or untrusted snapshot falls back to the seed.
  globalForA2A.__a2aPeers = Array.isArray(loaded.state) ? loaded.state : seedPeers();
}

const rawPeers: A2APeer[] = globalForA2A.__a2aPeers!;

if (!globalForA2A.__a2aPersister) {
  const p = createPersister<A2APeer[]>({
    getState: () => rawPeers,
    path: peersPath(),
    onEvent: (m) => console.warn(`[a2a] ${m}`),
  });
  flushOnExit(p);
  globalForA2A.__a2aPersister = p;
}

export const a2aPeers: A2APeer[] = trackChanges(
  rawPeers,
  globalForA2A.__a2aPersister!.markDirty
);

// --------------------------------------------------------------------------- //
// Accessors
// --------------------------------------------------------------------------- //

export function listPeers(filter: { tenantId?: string; status?: RecordStatus } = {}): A2APeer[] {
  let items = [...a2aPeers];
  if (filter.tenantId) items = items.filter((p) => p.tenantId === filter.tenantId);
  if (filter.status) items = items.filter((p) => p.status === filter.status);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getPeer(peerId: string): A2APeer | undefined {
  return a2aPeers.find((p) => p.peerId === peerId);
}

export function requirePeer(peerId: string): A2APeer {
  const peer = getPeer(peerId);
  if (!peer) throw new A2ANotFoundError(`A2A peer '${peerId}' not found`);
  return peer;
}

export interface CreatePeerInput {
  peerId: string;
  displayName: string;
  description?: string;
  tenantId: string;
  endpoint: string;
  allowedHosts?: string[];
  auth?: A2APeer["auth"];
  owner?: string;
}

/** Create a peer in Draft. Throws if the id is taken. */
export function createPeer(input: CreatePeerInput): A2APeer {
  if (getPeer(input.peerId)) {
    throw new A2AVersionConflictError(`peer '${input.peerId}' already exists`);
  }
  const now = new Date().toISOString();
  const peer: A2APeer = {
    peerId: input.peerId,
    displayName: input.displayName,
    description: input.description ?? "",
    tenantId: input.tenantId,
    endpoint: input.endpoint,
    allowedHosts: input.allowedHosts ?? [],
    auth: input.auth ?? { kind: "none" },
    card: null,
    status: "Draft",
    owner: input.owner ?? "console-user",
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  a2aPeers.unshift(peer);
  return peer;
}

/** Attach a freshly discovered Agent Card. */
export function setPeerCard(
  peerId: string,
  card: A2AAgentCard,
  expectedRev: number
): A2APeer {
  const peer = requirePeer(peerId);
  if (peer.rev !== expectedRev) throw new A2AVersionConflictError();
  peer.card = card;
  peer.rev += 1;
  peer.updatedAt = new Date().toISOString();
  return peer;
}

/** Advance a peer through its lifecycle. */
export function transitionPeer(
  peerId: string,
  next: RecordStatus,
  expectedRev: number
): A2APeer {
  const peer = requirePeer(peerId);
  if (peer.rev !== expectedRev) throw new A2AVersionConflictError();
  if (!canTransition(peer.status, next)) {
    throw new A2ATransitionError(`invalid transition ${peer.status} → ${next}`);
  }
  peer.status = next;
  peer.rev += 1;
  peer.updatedAt = new Date().toISOString();
  return peer;
}

/** A stable message id for one A2A exchange. */
export function newMessageId(): string {
  return newId("a2a-msg");
}
