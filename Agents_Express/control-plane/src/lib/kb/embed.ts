// Query embedding via Amazon Bedrock.
//
// The query MUST be embedded with the same model and dimension used to build
// the collection, otherwise similarity is meaningless. That pairing is declared
// on the record (`knowledgeConfig.embedding`) and defaulted here.
//
// Verified live in us-west-2: amazon.titan-embed-text-v2:0 returns 1024 dims.
//
// Two model families are handled because they have different request/response
// shapes; anything else fails loudly rather than silently mis-embedding.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { KbConfigError, KbTransportError } from "./types";
import type { EmbeddingInfo } from "./types";

/** Titan Text Embeddings V2 — the platform default. */
export const DEFAULT_EMBED_MODEL = "amazon.titan-embed-text-v2:0";
/** Titan V2 supports 256 | 512 | 1024. */
export const DEFAULT_EMBED_DIMENSION = 1024;

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) {
    const region =
      (process.env.AWS_REGION || "").trim() ||
      (process.env.AWS_DEFAULT_REGION || "").trim();
    if (!region) {
      throw new KbConfigError(
        "embedding requires AWS_REGION or AWS_DEFAULT_REGION (no hardcoded fallback)"
      );
    }
    _client = new BedrockRuntimeClient({ region });
  }
  return _client;
}

export interface EmbedOptions {
  modelId?: string;
  dimension?: number;
}

export interface EmbedResult {
  vector: number[];
  info: EmbeddingInfo;
}

/** Build the provider-specific request body. */
function requestBody(modelId: string, text: string, dimension: number): string {
  if (modelId.startsWith("amazon.titan-embed")) {
    // titan-embed-text-v1 does not accept `dimensions`; v2 does.
    const body: Record<string, unknown> = { inputText: text };
    if (modelId.includes("-v2")) {
      body.dimensions = dimension;
      body.normalize = true;
    }
    return JSON.stringify(body);
  }
  if (modelId.startsWith("cohere.embed")) {
    // Cohere embeds a batch and requires an input_type for retrieval.
    return JSON.stringify({ texts: [text], input_type: "search_query" });
  }
  throw new KbConfigError(
    `unsupported embedding model '${modelId}'. Use an amazon.titan-embed-* or cohere.embed-* model.`
  );
}

/** Pull the vector out of the provider-specific response. */
function parseVector(modelId: string, payload: Record<string, unknown>): number[] {
  if (modelId.startsWith("amazon.titan-embed")) {
    const v = payload.embedding;
    if (Array.isArray(v)) return v as number[];
  }
  if (modelId.startsWith("cohere.embed")) {
    const embeddings = payload.embeddings;
    if (Array.isArray(embeddings) && Array.isArray(embeddings[0])) {
      return embeddings[0] as number[];
    }
    // cohere.embed-v4 nests under float
    if (embeddings && typeof embeddings === "object") {
      const float = (embeddings as Record<string, unknown>).float;
      if (Array.isArray(float) && Array.isArray(float[0])) return float[0] as number[];
    }
  }
  throw new KbTransportError(
    `embedding response from '${modelId}' did not contain a vector`
  );
}

/**
 * Embed a single query string. Returns the vector plus the (modelId, dimension)
 * actually used, so callers can record it and compare against the collection.
 */
export async function embedQuery(
  text: string,
  opts: EmbedOptions = {}
): Promise<EmbedResult> {
  const query = (text ?? "").trim();
  if (!query) throw new KbConfigError("cannot embed an empty query");

  const modelId = opts.modelId || DEFAULT_EMBED_MODEL;
  const dimension = opts.dimension || DEFAULT_EMBED_DIMENSION;

  let payload: Record<string, unknown>;
  try {
    const res = await client().send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: requestBody(modelId, query, dimension),
      })
    );
    payload = JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof KbConfigError) throw e;
    throw new KbTransportError(
      `Bedrock embedding call failed for '${modelId}': ${(e as Error).message}`
    );
  }

  const vector = parseVector(modelId, payload);

  // A mismatch here is the single most common cause of "RAG returns nothing",
  // so fail loudly instead of sending a wrong-sized vector to the vector store.
  if (opts.dimension && vector.length !== opts.dimension) {
    throw new KbConfigError(
      `embedding dimension mismatch: model '${modelId}' returned ${vector.length} ` +
        `but the record declares ${opts.dimension}. Re-embed the collection or fix ` +
        `knowledgeConfig.embedding.dimension.`
    );
  }

  return { vector, info: { modelId, dimension: vector.length } };
}
