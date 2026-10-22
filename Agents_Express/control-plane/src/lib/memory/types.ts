// Memory types — the governed shape, not the AWS shape.
//
// AgentCore Memory is the backing service, but what the platform manages is a
// governed BINDING: an approved registry record, owned by a tenant, attachable
// to an agent within a tier limit, readable only through a Cedar check, with
// every access audited. The AWS identifiers are a detail inside that.

import type { MemoryScope } from "./namespace";

export class MemoryConfigError extends Error {
  readonly code = "MEMORY_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "MemoryConfigError";
  }
}

export class MemoryNotFoundError extends Error {
  readonly code = "MEMORY_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryDeniedError extends Error {
  readonly code = "MEMORY_DENIED";
  // Declared explicitly: the test loader strips types only and does not
  // support TypeScript parameter properties.
  readonly authorization: MemoryAuthorization;
  constructor(message: string, authorization: MemoryAuthorization) {
    super(message);
    this.name = "MemoryDeniedError";
    this.authorization = authorization;
  }
}

/** One stage of the two-stage Cedar check. */
export interface MemoryStageDecision {
  allowed?: boolean;
  evaluated?: boolean;
  reason: string;
  matchedPolicyId?: string;
}

export interface MemoryAuthorization {
  allowed: boolean;
  perimeter: MemoryStageDecision;
  /** Evaluated only when a policy names this specific memory record. */
  recordScoped: MemoryStageDecision;
}

/**
 * The declared configuration on an approved registry record of type "Memory".
 * Carries identifiers and scope policy — never a credential. AWS access uses
 * the server's own role, exactly as the Bedrock path does.
 */
export interface MemoryConfig {
  /** Owning tenant, if the record is scoped to one. */
  ownerTenantId?: string;
  /** AgentCore Memory resource id. */
  memoryId: string;
  region: string;
  /** Long-term strategy this binding retrieves from. */
  strategyId: string;
  /** The AgentCore namespace template; retrieval renders it. */
  namespaceTemplate: string;
  /** Retrieval bounds. Unbounded recall is how context rot starts. */
  topK: number;
  /** Minimum relevance; below this a record is noise competing for attention. */
  minRelevance?: number;
  /** Event expiry in days, as configured on the AWS resource (30 default). */
  eventExpiryDays?: number;
}

/** A single long-term memory record as the platform hands it to a model. */
export interface MemoryRecordView {
  recordId: string;
  /** The namespace it was found in — kept so scope can be PROVEN, not assumed. */
  namespace?: string;
  content: string;
  relevance?: number;
  createdAt?: string;
  /** Structured metadata. Ontology terms live here; the fact lives in `content`. */
  metadata?: Record<string, unknown>;
}

/** What a governed retrieval returns, including what it did NOT return. */
export interface MemoryRetrieval {
  memoryId: string;
  strategyId: string;
  scope: MemoryScope;
  namespace: string;
  records: MemoryRecordView[];
  /** Asked for vs returned, so a bounded recall never looks exhaustive. */
  topK: number;
  returned: number;
  /** Dropped for relevance below the floor. */
  belowThreshold: number;
  /**
   * Records whose namespace fell OUTSIDE the requested scope. Must always be
   * zero; a non-zero value is an isolation failure and is reported, not hidden.
   */
  outOfScope: number;
  latencyMs: number;
  authorization: MemoryAuthorization;
}

/** What a governed write records. */
export interface MemoryWriteResult {
  memoryId: string;
  namespace: string;
  eventId?: string;
  turns: number;
  latencyMs: number;
  authorization: MemoryAuthorization;
}
