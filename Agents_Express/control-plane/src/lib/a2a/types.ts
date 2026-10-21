// A2A (Agent-to-Agent) domain types for the control plane.
//
// The control plane is an A2A *client* and *governor*: it registers peer agents,
// discovers their capabilities from a published Agent Card, and sends A2A
// messages to them under Cedar policy with a full audit trail. It does not host
// an A2A server itself — peers run in the data plane.
//
// Protocol shape (A2A over JSON-RPC 2.0 / HTTPS):
//   discovery : GET  <endpoint>/.well-known/agent.json   -> Agent Card
//   messaging : POST <endpoint>  {jsonrpc, id, method:"message/send", params}
//
// SECURITY: no credential is ever stored on a peer record — only a reference
// (`authEnvVar`) resolved server-side at call time, mirroring the Neo4j/graph
// backend convention in lib/graph/entities.ts.

import type { ID, RecordStatus } from "../types";

export type ISO = string;

/** How the control plane authenticates to a peer. */
export type A2AAuthKind = "none" | "bearer-env" | "iam-role";

/**
 * A capability advertised by a peer, normalized from its Agent Card.
 * Mirrors the A2A `AgentSkill` object but keeps only non-sensitive fields.
 */
export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/**
 * A peer's Agent Card, normalized to a stable internal shape. Unknown/extra
 * fields from the wire are deliberately dropped rather than passed through, so
 * a hostile card cannot smuggle data into the UI or the audit log.
 */
export interface A2AAgentCard {
  name: string;
  description: string;
  /** The peer's self-declared service URL (informational; we call `endpoint`). */
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: A2ASkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  /** Where the card was fetched from, for provenance. */
  fetchedFrom: string;
  fetchedAt: ISO;
}

/**
 * A registered A2A peer. Walks the same Draft -> Approved lifecycle as registry
 * records and graph sources, so an unapproved peer can never be called.
 */
export interface A2APeer {
  peerId: string;
  displayName: string;
  description: string;
  /** Owning tenant (BU) — scopes visibility and policy. */
  tenantId: ID;
  /** HTTPS base URL of the peer's A2A service. */
  endpoint: string;
  /** Hostnames permitted for outbound calls. Required for a live endpoint. */
  allowedHosts: string[];
  auth: {
    kind: A2AAuthKind;
    /** Name of the server-side env var holding the bearer token. Never a value. */
    authEnvVar?: string;
    /** Role ARN reference for iam-role auth. Never a credential. */
    roleArn?: string;
  };
  /** Last successfully discovered card, if any. */
  card: A2AAgentCard | null;
  status: RecordStatus;
  owner: string;
  createdAt: ISO;
  updatedAt: ISO;
  /** Optimistic-concurrency token, bumped on every write. */
  rev: number;
}

// --------------------------------------------------------------------------- //
// Call authorization
// --------------------------------------------------------------------------- //

/**
 * The outcome of the two-stage Cedar check performed before any egress.
 * Stage 1 is the A2A perimeter; stage 2 is the peer-scoped "who may call whom"
 * rule, which only applies when a policy names that specific peer.
 */
export interface A2AAuthorization {
  allowed: boolean;
  /** Perimeter decision (resource == Tool::"a2a"). */
  perimeter: { allowed: boolean; reason: string; matchedPolicyId?: ID };
  /** Peer-scoped decision (resource == Tool::"a2a:<peerId>"), when one exists. */
  peerScoped:
    | { evaluated: true; allowed: boolean; reason: string; matchedPolicyId?: ID }
    | { evaluated: false; reason: string };
}

// --------------------------------------------------------------------------- //
// Message exchange
// --------------------------------------------------------------------------- //

export interface A2ASendRequest {
  peerId: string;
  personaId: ID;
  /** The text to send to the peer. */
  text: string;
  /** Optional skill the caller intends to invoke (recorded + sent as metadata). */
  skillId?: string;
  /** Correlates several sends into one logical session on the peer. */
  sessionId?: string;
  /** Stop before egress and return exactly what would be sent. */
  preview?: boolean;
}

/** A normalized reply, flattened from an A2A Task or Message result. */
export interface A2AReply {
  /** Concatenated text of every text part in the response. */
  text: string;
  /** A2A task id when the peer answered with a Task. */
  taskId?: string;
  /** A2A task state (e.g. "completed", "input-required") when present. */
  state?: string;
  /** Count of non-text parts we deliberately did not render. */
  droppedParts: number;
}

export type A2AExchangeMode = "preview" | "live";

export interface A2AExchange {
  mode: A2AExchangeMode;
  peerId: string;
  /** The exact JSON-RPC envelope sent (or that would be sent, in preview). */
  request: unknown;
  authorization: A2AAuthorization;
  reply: A2AReply | null;
  latencyMs: number | null;
  /** Populated instead of `reply` when the peer errored. */
  error?: string;
  at: ISO;
}

// --------------------------------------------------------------------------- //
// Errors — typed so route handlers map them to honest status codes
// --------------------------------------------------------------------------- //

export class A2AConfigError extends Error {
  readonly code = "A2A_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "A2AConfigError";
  }
}

export class A2ANotFoundError extends Error {
  readonly code = "A2A_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "A2ANotFoundError";
  }
}

export class A2ADeniedError extends Error {
  readonly code = "A2A_DENIED";
  // Declared explicitly rather than as a constructor parameter property: Node's
  // strip-only TypeScript loader (used by `npm test`) does not support those.
  readonly authorization: A2AAuthorization;
  constructor(message: string, authorization: A2AAuthorization) {
    super(message);
    this.name = "A2ADeniedError";
    this.authorization = authorization;
  }
}

export class A2ATransportError extends Error {
  readonly code = "A2A_TRANSPORT";
  constructor(message: string) {
    super(message);
    this.name = "A2ATransportError";
  }
}
