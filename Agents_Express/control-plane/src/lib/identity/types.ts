// Agent Identity — framework/IdP-neutral typed model (OFFLINE simulation).
//
// These types encode the controls from the "Agent Identity" source material:
//  - L0–L3 autonomy classification and the acts-as/acts-for model
//  - inbound auth (IAM SigV4 / OIDC JWT) config + validation
//  - per-tool outbound patterns (IAM role / M2M / 3LO / OBO)
//  - a token VAULT that stores METADATA ONLY (never a raw secret/token)
//  - delegation chains (sub=user, act=agent) with mandatory child-scope subset
//  - confused-deputy denial, gateway interceptors, attributable audit
//
// SECURITY INVARIANT: nothing in this module represents a real credential.
// Any JWT-shaped string produced by the simulation is UNSIGNED and literally
// tagged with the marker `SIMULATED` so it can never be mistaken for, or used
// as, a real bearer token. The vault holds opaque *handles* + metadata only.
//
// IdP/framework neutrality: no type here names a concrete IdP (Cognito, Entra,
// Okta, PingFederate) or agent framework (Strands, LangGraph, CrewAI). Those
// are carried as opaque string hints only.

import type { ID } from "../types";

/** Literal marker embedded in every simulated token handle / claim bundle. */
export const SIMULATED = "SIMULATED" as const;

// ---------------------------------------------------------------------------
// Autonomy & acts-as model (PDF: "Agency and autonomy decide the pattern")
//   L0  acts as: no one   → 2LO, or none
//   L1  acts as: the user → 3LO or OBO
//   L2  acts as: itself   → SigV4 or 2LO (M2M)
//   L3  acts as: both     → all, plus delegation policy
// ---------------------------------------------------------------------------
export type AutonomyLevel = "L0" | "L1" | "L2" | "L3";

/** Who the agent acts for when calling downstream resources. */
export type ActsAs = "none" | "user" | "self" | "both";

/** The identity controls an autonomy level is REQUIRED to configure. */
export interface RequiredControls {
  level: AutonomyLevel;
  actsAs: ActsAs;
  /** Human must be present / consentable for outbound calls. */
  requiresUserContext: boolean;
  /** A distinct workload identity (own client_id) is required. */
  requiresWorkloadIdentity: boolean;
  /** Delegation policy is required (L3 only). */
  requiresDelegationPolicy: boolean;
  /** Outbound patterns allowed at this level. */
  allowedOutbound: OutboundPattern[];
  /** Short human-readable rationale. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Inbound authentication (who calls the agent/gateway) — IAM SigV4 or OIDC JWT
// ---------------------------------------------------------------------------
export type InboundKind = "sigv4" | "oidc";

export interface InboundSigV4Config {
  kind: "sigv4";
  /** Glob-style principal ARN pattern the caller must match, e.g.
   *  "arn:aws:iam::*:role/EventBridge-*". Wildcards: * (any run), ? (one). */
  principalArnPattern: string;
}

export interface InboundOidcConfig {
  kind: "oidc";
  /** Expected token issuer (iss). */
  issuer: string;
  /** Expected audience (aud). */
  audience: string;
  /** Scopes the inbound token MUST carry. */
  requiredScopes: string[];
  /** Opaque JWKS location hint — never fetched in the offline simulation. */
  jwksHint?: string;
}

export type InboundAuthConfig = InboundSigV4Config | InboundOidcConfig;

/** A SIMULATED decoded inbound token presented for validation. Unsigned. */
export interface SimulatedDecodedJwt {
  iss: string;
  aud: string | string[];
  sub: string;
  scope?: string; // space-delimited, OAuth convention
  scopes?: string[]; // alternative array form
  exp?: number; // epoch seconds
  nbf?: number;
  /** Always `SIMULATED` for offline tokens. */
  marker?: typeof SIMULATED;
}

export interface InboundValidationResult {
  kind: InboundKind;
  valid: boolean;
  reasons: string[];
  /** The principal/subject that was authenticated, when valid. */
  principal?: string;
}

// ---------------------------------------------------------------------------
// Outbound patterns (how the agent calls downstream) + per-tool bindings
// ---------------------------------------------------------------------------
//  iam  → agent assumes an execution role (no user, L2-style)
//  m2m  → client-credentials (2LO), agent acts as itself (sub=bot)
//  3lo  → authorization-code grant, acts for the user (sub=user, client_id=agent)
//  obo  → on-behalf-of token exchange (sub=user, cid=agent, aud=resource)
export type OutboundPattern = "iam" | "m2m" | "3lo" | "obo";

export interface ToolAuthBinding {
  toolName: string;
  pattern: OutboundPattern;
  /** The downstream resource/audience this tool talks to. */
  resource: string;
  /** Minimum viable scopes requested up front. */
  minScopes: string[];
  /** Additional scopes requested only incrementally (on user action). */
  incrementalScopes: string[];
}

// ---------------------------------------------------------------------------
// Per-agent workload identity (own client_id; secret is a REFERENCE handle)
// ---------------------------------------------------------------------------
export type RotationState = "fresh" | "rotating" | "stale";

export interface WorkloadIdentity {
  id: ID;
  agentId: ID;
  /** The agent's own OAuth client_id (its distinct workload identity). */
  clientId: string;
  /** Opaque reference to a secret kept OUTSIDE this app (Secrets Manager).
   *  NEVER a secret value — just a handle/ARN-shaped reference string. */
  secretRef: string;
  createdAt: string;
  rotatedAt: string | null;
  rotationState: RotationState;
  status: "active" | "revoked";
}

// ---------------------------------------------------------------------------
// Token vault — METADATA ONLY, isolated by tenant+agent+user+resource
// ---------------------------------------------------------------------------
export interface VaultKey {
  tenantId: string;
  agentId: string;
  /** null for M2M/IAM (agent acts as itself; no user). */
  userSub: string | null;
  resource: string;
}

/** Simulated, unsigned claim bundle. Carries attribution, never a signature. */
export interface SimulatedClaims {
  sub: string; // user (3LO/OBO) or bot principal (M2M)
  act?: string; // act=agent for delegated tokens
  aud: string; // resource/audience
  cid?: string; // client_id of the agent (3LO/OBO)
  scope: string; // space-delimited granted scopes
  marker: typeof SIMULATED;
}

export interface VaultEntry {
  id: ID;
  key: VaultKey;
  /** Opaque handle — the index into the vault, NOT a token value. */
  handle: string;
  pattern: OutboundPattern;
  scopes: string[];
  ttlSeconds: number;
  issuedAt: string;
  expiresAt: string;
  /** Opaque one-time refresh handle; null when the pattern has no refresh. */
  refreshHandle: string | null;
  /** True once the refresh handle has been consumed (replay → deny). */
  refreshConsumed: boolean;
  /** The session this entry is JIT-bound to; null = unbound (deny on use). */
  sessionId: string | null;
  revoked: boolean;
  /** Lineage id so refresh rotation + replay revocation can target a chain. */
  lineageId: string;
  claims: SimulatedClaims;
}

// ---------------------------------------------------------------------------
// Consent (3LO — "Maria approves once"), per user+agent+resource
// ---------------------------------------------------------------------------
export interface ConsentGrant {
  id: ID;
  userSub: string;
  agentId: ID;
  resource: string;
  scopes: string[];
  grantedAt: string;
  revokedAt: string | null;
}

// ---------------------------------------------------------------------------
// Sessions — JIT binding; vault retrieval only while a session is active
// ---------------------------------------------------------------------------
export interface Session {
  id: ID;
  userSub: string | null; // null for unattended (L0/L2) runs
  agentId: ID;
  startedAt: string;
  expiresAt: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Delegation chains — carry sub=user + act=agent; scope shrinks at every hop
// ---------------------------------------------------------------------------
export interface DelegationHop {
  fromAgent: ID;
  toAgent: ID;
  /** The originating user — constant across the whole chain (sub=user). */
  userSub: string;
  /** Child scopes for this hop — MUST be a subset of the parent's. */
  scopes: string[];
  /** The explicit policy id that authorized THIS cross-agent delegation. */
  authorizedByPolicyId: string;
}

export interface DelegationChain {
  id: ID;
  rootUserSub: string;
  /** Scopes the root user actually holds — the ceiling for every hop. */
  rootScopes: string[];
  hops: DelegationHop[];
  createdAt: string;
}

export interface DelegationPolicy {
  id: string;
  /** Agent pairs this policy authorizes to delegate (from → to). */
  allow: { fromAgent: ID; toAgent: ID }[];
}

export interface DelegationResult {
  authorized: boolean;
  /** 403 "confused-deputy" style denial reason when not authorized. */
  reasons: string[];
  chain?: DelegationChain;
}

// ---------------------------------------------------------------------------
// Gateway interceptors — FGAC, tool filtering, data masking, token exchange
// ---------------------------------------------------------------------------
export interface InterceptorInput {
  agentId: ID;
  tool: string;
  userSub: string | null;
  /** Caller's scopes (for FGAC). */
  callerScopes: string[];
  /** The scope the tool requires. */
  requiredScope: string;
  /** Arbitrary payload the tool would return; PII fields get masked. */
  payload: Record<string, unknown>;
}

export type InterceptorStageName =
  | "fgac"
  | "tool-filter"
  | "data-masking"
  | "token-exchange";

export interface InterceptorStage {
  stage: InterceptorStageName;
  passed: boolean;
  detail: string;
}

export interface InterceptorResult {
  allowed: boolean;
  stages: InterceptorStage[];
  /** Payload after masking (only present when the pipeline allowed the call). */
  maskedPayload?: Record<string, unknown>;
  /** The simulated exchanged token handle (opaque), when applicable. */
  exchangedHandle?: string;
}

// ---------------------------------------------------------------------------
// Agent identity profile — ties it all together, per agent
// ---------------------------------------------------------------------------
export interface AgentIdentityProfile {
  agentId: ID;
  autonomyLevel: AutonomyLevel;
  actsAs: ActsAs;
  inbound: InboundAuthConfig;
  outbound: ToolAuthBinding[];
  /** Tools this agent is allowed to see/use (interceptor tool-filter allowlist). */
  toolAllowlist: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Attributable, immutable-style audit — hash-chained, human+agent+session+chain
// ---------------------------------------------------------------------------
export interface IdentityAuditAttribution {
  humanSub?: string | null;
  agentId?: ID;
  sessionId?: ID | null;
  delegationChainId?: ID | null;
  /** act=agent marker for delegated actions. */
  act?: string;
}

export interface IdentityAuditEvent {
  id: ID;
  action: string;
  actor: string;
  detail: string;
  attribution: IdentityAuditAttribution;
  at: string;
  /** Hash of the previous event ("" for the genesis entry). */
  prevHash: string;
  /** Tamper-evident hash over (prevHash + canonical event body). */
  hash: string;
}
