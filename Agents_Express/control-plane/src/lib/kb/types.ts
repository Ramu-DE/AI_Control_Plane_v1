// Knowledge Base retrieval — provider-neutral contract.
//
// This is the seam the architecture doc (§4A) specifies: one interface, many
// back-ends, normalizing every provider to
//   retrieve(query, topK, filters) -> { chunks, scores, citations }
//
// It is modelled on graph-utility's proven `Retriever` seam (RetrievalRequest ->
// Passage[] via a descriptor-driven FieldMapping), so the two tracks share one
// vocabulary.
//
// SECURITY: nothing here carries a credential. A provider credential is always
// a *reference* (env var name or Secrets Manager ARN) resolved server-side at
// retrieval time — see ./secrets.ts.

import type { ID } from "../types";

export type ISO = string;

/** A normalized retrieved chunk. `source` identifies which provider produced it. */
export interface Passage {
  /** Provider-side point/chunk id, stringified. */
  id: string;
  text: string;
  /** Provider similarity score, higher is better. */
  score: number;
  source: string;
  /** Passthrough payload fields (minus the text field itself). */
  metadata: Record<string, unknown>;
}

export interface RetrievalRequest {
  query: string;
  topK: number;
  /** Equality filters applied provider-side where supported. */
  filters?: Record<string, unknown>;
  /** Drop chunks scoring below this. Falls back to the record's configured value. */
  scoreThreshold?: number;
}

/** What the query was embedded with — null for providers that embed server-side. */
export interface EmbeddingInfo {
  modelId: string;
  dimension: number;
}

export interface RetrievalResult {
  passages: Passage[];
  provider: string;
  /** Collection / index / KB id actually queried. */
  target: string;
  embedding: EmbeddingInfo | null;
  latencyMs: number;
  /** Non-fatal notes (e.g. a deprecated endpoint was used as a fallback). */
  notes: string[];
}

/** Every provider adapter satisfies this. */
export interface KbRetriever {
  readonly provider: string;
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

/**
 * Minimal fetch-shaped transport, injectable so adapters are unit-testable
 * without a network. Matches the subset of `fetch` the adapters use.
 */
export type HttpTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** The default transport is the platform `fetch`. */
export const fetchTransport: HttpTransport = (url, init) =>
  fetch(url, { ...init, cache: "no-store" });

// --------------------------------------------------------------------------- //
// Authorization (mirrors the two-stage A2A gate for consistency)
// --------------------------------------------------------------------------- //

export interface KbAuthorization {
  allowed: boolean;
  perimeter: { allowed: boolean; reason: string; matchedPolicyId?: ID };
  recordScoped:
    | { evaluated: true; allowed: boolean; reason: string; matchedPolicyId?: ID }
    | { evaluated: false; reason: string };
}

// --------------------------------------------------------------------------- //
// Errors — typed so the route maps them to honest status codes
// --------------------------------------------------------------------------- //

export class KbConfigError extends Error {
  readonly code = "KB_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "KbConfigError";
  }
}

export class KbNotFoundError extends Error {
  readonly code = "KB_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "KbNotFoundError";
  }
}

export class KbDeniedError extends Error {
  readonly code = "KB_DENIED";
  readonly authorization: KbAuthorization;
  constructor(message: string, authorization: KbAuthorization) {
    super(message);
    this.name = "KbDeniedError";
    this.authorization = authorization;
  }
}

export class KbTransportError extends Error {
  readonly code = "KB_TRANSPORT";
  constructor(message: string) {
    super(message);
    this.name = "KbTransportError";
  }
}
