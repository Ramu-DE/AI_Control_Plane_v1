// Server-to-server client for the RAG Factory running as a private sidecar
// in SERVICE MODE: every call carries the shared service token plus the
// tenant and persona the control plane has already authorized. The factory
// stamps and filters on that tenant; browsers never reach it.

import type { FinalizedDocument } from "../docintel/contract";

export class RagFactoryError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface RagCaller {
  tenantId: string;
  personaId: string;
}

export function ragConfig(): { url: string; token: string } | null {
  const url = (process.env.RAG_URL || "").replace(/\/+$/, "");
  const token = process.env.RAG_SERVICE_TOKEN || "";
  return url && token ? { url, token } : null;
}

function requireConfig() {
  const cfg = ragConfig();
  if (!cfg) {
    throw new RagFactoryError("RAG_NOT_CONFIGURED",
      "the RAG Factory is not configured: set RAG_URL and RAG_SERVICE_TOKEN in the control plane's environment");
  }
  return cfg;
}

function headers(token: string, caller: RagCaller): Record<string, string> {
  return {
    "X-Service-Token": token, "X-Tenant-Id": caller.tenantId, "X-Persona-Id": caller.personaId,
    "content-type": "application/json",
  };
}

async function call<T>(path: string, body: unknown, caller: RagCaller, timeoutMs: number): Promise<T> {
  const cfg = requireConfig();
  const r = await fetch(`${cfg.url}${path}`, {
    method: "POST", headers: headers(cfg.token, caller), body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 400);
    try {
      const d = JSON.parse(text).detail;
      detail = typeof d === "string" ? d : JSON.stringify(d).slice(0, 400);
    } catch { /* not JSON */ }
    throw new RagFactoryError("RAG_CALL_FAILED", `RAG Factory ${path.split("?")[0]} returned ${r.status}: ${detail}`, r.status);
  }
  return JSON.parse(text) as T;
}

export async function ragHealth(): Promise<{ ok: boolean; detail: string }> {
  const cfg = ragConfig();
  if (!cfg) return { ok: false, detail: "RAG_URL / RAG_SERVICE_TOKEN not set" };
  try {
    const r = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    return { ok: r.ok, detail: r.ok ? "healthy" : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export interface IngestResult {
  collection_name: string;
  finalized_document_id: string;
  version: number;
  chunk_count: number;
  chunker: string;
  points_upserted: number;
  points_deleted: number;
  superseded_versions: number[];
  elapsed_ms: number;
}

export function ragIngestFinalized(
  doc: FinalizedDocument, collection: string, chunker: string, caller: RagCaller, timeoutMs = 5 * 60_000
): Promise<IngestResult> {
  const q = new URLSearchParams({ collection_name: collection, chunker });
  return call<IngestResult>(`/ingest/finalized?${q}`, doc, caller, timeoutMs);
}

export interface RagQueryResult {
  answer: string;
  retrieved_chunks: Record<string, unknown>[];
  scores: number[];
  guard_log: Record<string, unknown>;
  faithfulness: number | null;
  elapsed_ms: number;
  top_k?: number;
}

export function ragQuery(
  input: { collection: string; query: string; topK: number; filters?: Record<string, string | number | boolean> },
  caller: RagCaller,
  timeoutMs = 2 * 60_000
): Promise<RagQueryResult> {
  return call<RagQueryResult>("/query", {
    query: input.query, collection_name: input.collection, top_k: input.topK,
    ...(input.filters && Object.keys(input.filters).length ? { filters: input.filters } : {}),
  }, caller, timeoutMs);
}
