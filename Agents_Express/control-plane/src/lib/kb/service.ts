// Knowledge Base retrieval service — policy, embedding, retrieval, audit.
//
// This is the only module that composes a governed RAG retrieval. Order of
// operations fails closed at every step:
//   1. the record must exist, be type "Knowledge Base", and be Approved
//   2. Cedar two-stage check (perimeter, then record-scoped)
//   3. preview short-circuits BEFORE any credential is read or egress happens
//   4. the credential reference is resolved server-side
//   5. the query is embedded with the record's declared model/dimension
//   6. the provider adapter retrieves
//   7. every outcome is audited
//
// Server-only.

import { evaluate } from "../evaluator";
import { logAudit, store } from "../store";
import { embedQuery } from "./embed";
import { QdrantRetriever } from "./qdrant";
import { resolveApiKey } from "./secrets";
import {
  KbConfigError,
  KbDeniedError,
  KbNotFoundError,
} from "./types";
import type { KbAuthorization, RetrievalResult } from "./types";
import type { KnowledgeConfig, Policy, RegistryRecord } from "../types";

// --------------------------------------------------------------------------- //
// Cedar resource naming (same two-stage shape as the A2A gate)
// --------------------------------------------------------------------------- //

export const KB_ACTION = "queryKnowledgeBase";
export const KB_PERIMETER_TOOL = "kb";

export function recordScopedTool(recordId: string): string {
  return `${KB_PERIMETER_TOOL}:${recordId}`;
}

/** Does an enabled gateway policy name this specific KB record? Pure. */
export function recordScopedPolicyExists(policies: Policy[], recordId: string): boolean {
  const needle = `Tool::"${recordScopedTool(recordId)}"`;
  return policies.some(
    (p) => p.enabled && p.layer === "gateway" && p.cedar.includes(needle)
  );
}

/**
 * Two-stage authorization. Stage 2 is evaluated only when a policy names the
 * record, and is then authoritative — so a KB can be locked down to specific
 * personas without touching the perimeter rule.
 */
export function authorizeRetrieval(recordId: string, personaId: string): KbAuthorization {
  // A tenant-owned KB is evaluated IN its tenant: membership, the role
  // minimum and the GxP / residency forbids then apply. Platform-provided
  // records (no tenantId) keep the perimeter-only decision.
  const tenantId = store.records.find((r) => r.id === recordId)?.tenantId;
  const perimeterResult = evaluate({
    personaId,
    agentId: "kb-retriever",
    action: KB_ACTION,
    tool: KB_PERIMETER_TOOL,
    resource: recordId,
    ...(tenantId ? { tenantId } : {}),
  });
  const pd = perimeterResult.decisions[0];
  const perimeter = {
    allowed: perimeterResult.allowed,
    reason: pd?.reason ?? "no decision recorded",
    ...(pd?.matchedPolicyId ? { matchedPolicyId: pd.matchedPolicyId } : {}),
  };

  if (!perimeter.allowed) {
    return {
      allowed: false,
      perimeter,
      recordScoped: {
        evaluated: false,
        reason: "not evaluated — the Knowledge Base perimeter denied the call",
      },
    };
  }

  if (!recordScopedPolicyExists(store.policies, recordId)) {
    return {
      allowed: true,
      perimeter,
      recordScoped: {
        evaluated: false,
        reason: `no policy names Tool::"${recordScopedTool(recordId)}" — perimeter decision stands`,
      },
    };
  }

  const scoped = evaluate({
    personaId,
    agentId: "kb-retriever",
    action: KB_ACTION,
    tool: recordScopedTool(recordId),
    resource: recordId,
    ...(tenantId ? { tenantId } : {}),
  });
  const sd = scoped.decisions[0];
  return {
    allowed: scoped.allowed,
    perimeter,
    recordScoped: {
      evaluated: true,
      allowed: scoped.allowed,
      reason: sd?.reason ?? "no decision recorded",
      ...(sd?.matchedPolicyId ? { matchedPolicyId: sd.matchedPolicyId } : {}),
    },
  };
}

// --------------------------------------------------------------------------- //
// Record resolution
// --------------------------------------------------------------------------- //

export interface ResolvedKb {
  record: RegistryRecord;
  config: KnowledgeConfig;
}

/** Fetch a KB record and assert it is usable. Throws typed errors. */
export function resolveKbRecord(recordId: string): ResolvedKb {
  const record = store.records.find((r) => r.id === recordId);
  if (!record) throw new KbNotFoundError(`registry record '${recordId}' not found`);
  if (record.type !== "Knowledge Base") {
    throw new KbConfigError(
      `record '${recordId}' is type '${record.type}', not 'Knowledge Base'`
    );
  }
  if (record.status !== "Approved") {
    throw new KbConfigError(
      `record '${record.name}' is ${record.status}; only an Approved Knowledge Base can be queried`
    );
  }
  if (!record.knowledgeConfig) {
    throw new KbConfigError(`record '${record.name}' has no knowledgeConfig`);
  }
  return { record, config: record.knowledgeConfig };
}

// --------------------------------------------------------------------------- //
// Retrieval
// --------------------------------------------------------------------------- //

export interface RetrieveInput {
  recordId: string;
  personaId: string;
  query: string;
  topK?: number;
  filters?: Record<string, unknown>;
  scoreThreshold?: number;
  /** Stop before resolving the credential or performing any egress. */
  preview?: boolean;
}

export interface RetrieveOutput {
  mode: "preview" | "live";
  recordId: string;
  recordName: string;
  provider: string;
  authorization: KbAuthorization;
  /** The plan: what would be / was queried. */
  plan: {
    target: string;
    topK: number;
    scoreThreshold: number;
    embeddingModelId: string;
    embeddingDimension: number;
    filters?: Record<string, unknown>;
  };
  result: RetrievalResult | null;
  error?: string;
  at: string;
}

function actorFor(personaId: string): string {
  return store.personas.find((p) => p.id === personaId)?.name ?? personaId;
}

/** Qdrant target label (collection) for plan/preview output. */
function targetFor(config: KnowledgeConfig): string {
  const c = config.connection;
  return (
    c.qdrantCollection ||
    c.knowledgeBaseId ||
    c.indexName ||
    c.collection ||
    c.indexOrNamespace ||
    "(unset)"
  );
}

export async function retrieve(input: RetrieveInput): Promise<RetrieveOutput> {
  const { record, config } = resolveKbRecord(input.recordId);
  const actor = actorFor(input.personaId);
  const at = new Date().toISOString();

  const authorization = authorizeRetrieval(record.id, input.personaId);
  if (!authorization.allowed) {
    logAudit({
      category: "kb",
      action: "deny-retrieve",
      actor,
      detail: `DENY retrieval from '${record.name}' — ${
        authorization.recordScoped.evaluated && !authorization.recordScoped.allowed
          ? authorization.recordScoped.reason
          : authorization.perimeter.reason
      }`,
    });
    throw new KbDeniedError("Knowledge Base retrieval denied by policy", authorization);
  }

  const topK = Math.min(Math.max(input.topK ?? config.retrieval.topK ?? 5, 1), 100);
  const scoreThreshold = input.scoreThreshold ?? config.retrieval.scoreThreshold ?? 0;
  const embeddingModelId =
    config.embedding?.modelId || "amazon.titan-embed-text-v2:0";
  const embeddingDimension = config.embedding?.dimension || 1024;

  const plan: RetrieveOutput["plan"] = {
    target: targetFor(config),
    topK,
    scoreThreshold,
    embeddingModelId,
    embeddingDimension,
    ...(input.filters ? { filters: input.filters } : {}),
  };

  const base = {
    recordId: record.id,
    recordName: record.name,
    provider: config.provider,
    authorization,
    plan,
    at,
  };

  if (input.preview) {
    logAudit({
      category: "kb",
      action: "preview-retrieve",
      actor,
      detail: `ALLOW retrieval preview for '${record.name}' (${config.provider}, no egress)`,
    });
    return { ...base, mode: "preview", result: null };
  }

  try {
    if (config.provider !== "Qdrant") {
      // The seam is multi-provider; only Qdrant has a live adapter here. Bedrock
      // KB retrieval already exists at POST /api/aws/retrieve (aws mode).
      throw new KbConfigError(
        `no retrieval adapter for provider '${config.provider}'. ` +
          (config.provider === "Bedrock Knowledge Base"
            ? "Use POST /api/aws/retrieve with AWS_EXECUTION_MODE=aws."
            : "Qdrant is implemented; others are not yet.")
      );
    }

    const url = config.connection.qdrantUrl;
    const collection = config.connection.qdrantCollection;
    if (!url) throw new KbConfigError("knowledgeConfig.connection.qdrantUrl is not set");
    if (!collection) {
      throw new KbConfigError("knowledgeConfig.connection.qdrantCollection is not set");
    }

    // Credential is resolved only on the live path, after policy allowed it.
    const apiKey = await resolveApiKey(config.provider, config);

    const retriever = new QdrantRetriever({
      url,
      collection,
      apiKey,
      allowedHosts: config.allowedHosts,
      dimension: config.embedding?.dimension,
      fieldMapping: config.fieldMapping,
    });

    const { vector, info } = await embedQuery(input.query, {
      modelId: embeddingModelId,
      dimension: config.embedding?.dimension,
    });

    const result = await retriever.retrieveWithVector(vector, {
      query: input.query,
      topK,
      filters: input.filters,
      scoreThreshold: scoreThreshold > 0 ? scoreThreshold : undefined,
    });
    result.embedding = info;

    logAudit({
      category: "kb",
      action: "retrieve",
      actor,
      detail:
        `ALLOW retrieval from '${record.name}' (${config.provider}:${result.target}) — ` +
        `${result.passages.length} passage(s) in ${result.latencyMs}ms`,
    });
    return { ...base, mode: "live", result };
  } catch (e) {
    const message = (e as Error).message;
    logAudit({
      category: "kb",
      action: "retrieve-error",
      actor,
      detail: `Retrieval from '${record.name}' failed: ${message}`,
    });
    // Config problems are the caller's to fix — rethrow so the route can map
    // them to a 503/400 rather than reporting a successful empty retrieval.
    if (e instanceof KbConfigError || e instanceof KbNotFoundError) throw e;
    return { ...base, mode: "live", result: null, error: message };
  }
}
