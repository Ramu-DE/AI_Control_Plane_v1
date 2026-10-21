// Pure, dependency-free normalization helpers that map raw AWS SDK response
// shapes into the compact, UI-friendly types this app exposes. These functions
// are deterministic, perform NO I/O, and must stay free of SDK client imports
// so they can be unit-tested and reused on either side of the wire.

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  status: string;
  description?: string;
  updatedAt?: string;
}

export interface BedrockAgentSummary {
  id: string;
  name: string;
  status: string;
  description?: string;
  updatedAt?: string;
}

export interface PolicyStoreSummary {
  id: string;
  arn?: string;
  description?: string;
  createdAt?: string;
}

export interface RetrievalResult {
  content: string;
  score?: number;
  source?: string;
}

export interface AuthorizationResult {
  decision: "ALLOW" | "DENY" | "UNKNOWN";
  determiningPolicyIds: string[];
  errors: string[];
}

function toIso(d: unknown): string | undefined {
  if (!d) return undefined;
  if (d instanceof Date) return d.toISOString();
  // SDK sometimes hands back a string/number already.
  const parsed = new Date(d as string | number);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function normalizeKnowledgeBase(
  kb: Record<string, unknown> | undefined | null
): KnowledgeBaseSummary | null {
  if (!kb) return null;
  const id = (kb.knowledgeBaseId as string) ?? "";
  if (!id) return null;
  return {
    id,
    name: (kb.name as string) ?? id,
    status: (kb.status as string) ?? "UNKNOWN",
    description: (kb.description as string) || undefined,
    updatedAt: toIso(kb.updatedAt),
  };
}

export function normalizeKnowledgeBases(
  list: Array<Record<string, unknown>> | undefined | null
): KnowledgeBaseSummary[] {
  return (list ?? [])
    .map((kb) => normalizeKnowledgeBase(kb))
    .filter((x): x is KnowledgeBaseSummary => x !== null);
}

export function normalizeAgent(
  a: Record<string, unknown> | undefined | null
): BedrockAgentSummary | null {
  if (!a) return null;
  const id = (a.agentId as string) ?? "";
  if (!id) return null;
  return {
    id,
    name: (a.agentName as string) ?? id,
    status: (a.agentStatus as string) ?? "UNKNOWN",
    description: (a.description as string) || undefined,
    updatedAt: toIso(a.updatedAt),
  };
}

export function normalizeAgents(
  list: Array<Record<string, unknown>> | undefined | null
): BedrockAgentSummary[] {
  return (list ?? [])
    .map((a) => normalizeAgent(a))
    .filter((x): x is BedrockAgentSummary => x !== null);
}

export function normalizePolicyStore(
  s: Record<string, unknown> | undefined | null
): PolicyStoreSummary | null {
  if (!s) return null;
  const id = (s.policyStoreId as string) ?? "";
  if (!id) return null;
  return {
    id,
    arn: (s.arn as string) || undefined,
    description: (s.description as string) || undefined,
    createdAt: toIso(s.createdDate),
  };
}

export function normalizePolicyStores(
  list: Array<Record<string, unknown>> | undefined | null
): PolicyStoreSummary[] {
  return (list ?? [])
    .map((s) => normalizePolicyStore(s))
    .filter((x): x is PolicyStoreSummary => x !== null);
}

// Normalize a Bedrock KB Retrieve response's retrievalResults array.
export function normalizeRetrievalResults(
  list: Array<Record<string, unknown>> | undefined | null
): RetrievalResult[] {
  return (list ?? []).map((r) => {
    const content = r.content as Record<string, unknown> | undefined;
    const location = r.location as Record<string, unknown> | undefined;
    const s3 = location?.s3Location as Record<string, unknown> | undefined;
    return {
      content: (content?.text as string) ?? "",
      score: typeof r.score === "number" ? (r.score as number) : undefined,
      source: (s3?.uri as string) || (location?.type as string) || undefined,
    };
  });
}

// Normalize an AVP IsAuthorized response into a stable shape.
export function normalizeAuthorization(
  res: Record<string, unknown> | undefined | null
): AuthorizationResult {
  const decisionRaw = String((res?.decision as string) ?? "").toUpperCase();
  const decision: AuthorizationResult["decision"] =
    decisionRaw === "ALLOW" ? "ALLOW" : decisionRaw === "DENY" ? "DENY" : "UNKNOWN";
  const determining = (res?.determiningPolicies as Array<Record<string, unknown>>) ?? [];
  const errors = (res?.errors as Array<Record<string, unknown>>) ?? [];
  return {
    decision,
    determiningPolicyIds: determining
      .map((p) => (p.policyId as string) ?? "")
      .filter(Boolean),
    errors: errors.map((e) => (e.errorDescription as string) ?? "").filter(Boolean),
  };
}

// Map common AWS SDK error names to a stable, honest classification used by the
// API layer so the UI can distinguish "access denied" from "empty" from "error".
export function classifyAwsError(err: unknown): {
  kind: "access-denied" | "not-found" | "throttling" | "error";
  name: string;
  message: string;
} {
  const e = err as { name?: string; message?: string; $metadata?: unknown };
  const name = e?.name ?? "Error";
  const message = e?.message ?? "Unknown error";
  if (/AccessDenied|UnrecognizedClient|NotAuthorized|Forbidden/i.test(name)) {
    return { kind: "access-denied", name, message };
  }
  if (/ResourceNotFound|NotFound|NoSuch/i.test(name)) {
    return { kind: "not-found", name, message };
  }
  if (/Throttl|TooManyRequests|LimitExceeded/i.test(name)) {
    return { kind: "throttling", name, message };
  }
  return { kind: "error", name, message };
}
