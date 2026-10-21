// Qdrant retriever — the first real vector-store adapter.
//
// Wire protocol (Qdrant Cloud REST):
//   primary  POST <url>/collections/<name>/points/query   { query: number[], ... }
//   fallback POST <url>/collections/<name>/points/search   { vector: number[], ... }
//
// `/points/query` is the current Query API; `/points/search` is the older
// endpoint, still present on many clusters. We try the modern one and fall back
// on 404 so the adapter works against either, recording which was used.
//
// Field mapping is DESCRIPTOR-DRIVEN: the payload key holding the chunk text is
// configured on the record, not assumed. A few conventional names are probed
// only when nothing is configured, and the choice is reported in `notes`.
//
// SSRF: the URL is validated with the same policy used for Graph Sources
// (HTTPS, no private/loopback/metadata hosts, allowlist when configured).
// The API key is passed in the `api-key` header and never logged.

import { validateOutboundUrl } from "../graph/logic";
import { fetchTransport, KbConfigError, KbTransportError } from "./types";
import type {
  HttpTransport,
  KbRetriever,
  Passage,
  RetrievalRequest,
  RetrievalResult,
} from "./types";

/** Payload keys probed for chunk text when the record configures none. */
export const TEXT_FIELD_CANDIDATES = [
  "text",
  "page_content",
  "content",
  "chunk",
  "body",
  "document",
] as const;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface QdrantConfig {
  /** Cluster base URL, e.g. https://<id>.<region>.aws.cloud.qdrant.io */
  url: string;
  collection: string;
  /** Resolved at call time by lib/kb/secrets.ts — never persisted. */
  apiKey: string;
  allowedHosts?: string[];
  /** Vector size the collection was built with, for a pre-flight check. */
  dimension?: number;
  fieldMapping?: {
    textField?: string;
    idField?: string;
    metadataFields?: string[];
  };
  /** Named vector, when the collection uses one. */
  vectorName?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to `fetch`. */
  transport?: HttpTransport;
}

type AnyRecord = Record<string, unknown>;

/** Pick the payload key that holds the chunk text. */
export function resolveTextField(
  payload: AnyRecord,
  configured?: string
): { field: string | null; probed: boolean } {
  if (configured) return { field: configured, probed: false };
  for (const candidate of TEXT_FIELD_CANDIDATES) {
    if (typeof payload[candidate] === "string") return { field: candidate, probed: true };
  }
  return { field: null, probed: true };
}

/**
 * Normalize one Qdrant scored point into a Passage. Pure.
 *
 * `metadataFields` restricts passthrough when set; otherwise every payload key
 * except the text field is carried, which is what makes citations useful.
 */
export function normalizePoint(
  point: AnyRecord,
  mapping: QdrantConfig["fieldMapping"],
  collection: string
): { passage: Passage | null; probedTextField: string | null } {
  const payload = (point.payload && typeof point.payload === "object"
    ? point.payload
    : {}) as AnyRecord;

  const { field, probed } = resolveTextField(payload, mapping?.textField);
  const text = field && typeof payload[field] === "string" ? (payload[field] as string) : "";

  const idField = mapping?.idField;
  const rawId = idField && payload[idField] !== undefined ? payload[idField] : point.id;
  const id = rawId === undefined || rawId === null ? "" : String(rawId);

  const metadata: AnyRecord = {};
  if (mapping?.metadataFields && mapping.metadataFields.length > 0) {
    for (const key of mapping.metadataFields) {
      if (key in payload) metadata[key] = payload[key];
    }
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (key !== field) metadata[key] = value;
    }
  }

  // A point with no resolvable text is useless for grounding — drop it, but
  // report the probe outcome so the caller can explain an empty result.
  if (!text) return { passage: null, probedTextField: probed ? field : null };

  return {
    passage: {
      id,
      text,
      score: typeof point.score === "number" ? point.score : 0,
      source: `qdrant:${collection}`,
      metadata,
    },
    probedTextField: probed ? field : null,
  };
}

/** Translate simple equality filters into a Qdrant filter clause. */
export function buildFilter(filters?: Record<string, unknown>): AnyRecord | undefined {
  if (!filters) return undefined;
  const must = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, match: { value } }));
  return must.length > 0 ? { must } : undefined;
}

export class QdrantRetriever implements KbRetriever {
  readonly provider = "Qdrant";
  private readonly cfg: QdrantConfig;
  private readonly transport: HttpTransport;

  constructor(cfg: QdrantConfig) {
    if (!cfg.url) throw new KbConfigError("Qdrant url is required");
    if (!cfg.collection) throw new KbConfigError("Qdrant collection is required");
    if (!cfg.apiKey) throw new KbConfigError("Qdrant API key could not be resolved");

    const policy = validateOutboundUrl(cfg.url, cfg.allowedHosts);
    if (!policy.ok) {
      throw new KbConfigError(
        policy.placeholder
          ? "Qdrant url is a placeholder — configure the real cluster URL"
          : `Qdrant url rejected: ${policy.reason}`
      );
    }
    this.cfg = cfg;
    this.transport = cfg.transport ?? fetchTransport;
  }

  private base(): string {
    return this.cfg.url.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "api-key": this.cfg.apiKey,
      "content-type": "application/json",
      accept: "application/json",
    };
  }

  private async post(path: string, body: AnyRecord): Promise<{ status: number; text: string }> {
    const timeoutMs = Math.min(Math.max(this.cfg.timeoutMs ?? 15_000, 1_000), 30_000);
    let res;
    try {
      res = await this.transport(`${this.base()}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new KbTransportError(describeNetworkError(e, `${this.base()}${path}`));
    }
    const text = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
    return { status: res.status, text };
  }

  /** Read collection metadata — used to pre-flight the vector dimension. */
  async describeCollection(): Promise<{ dimension: number | null; pointsCount: number | null }> {
    const timeoutMs = Math.min(Math.max(this.cfg.timeoutMs ?? 15_000, 1_000), 30_000);
    const url = `${this.base()}/collections/${encodeURIComponent(this.cfg.collection)}`;
    let res;
    try {
      res = await this.transport(url, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new KbTransportError(describeNetworkError(e, url));
    }
    const text = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
    if (!res.ok) {
      throw new KbTransportError(
        `Qdrant describe collection '${this.cfg.collection}' failed: HTTP ${res.status}${
          text ? ` ${text.slice(0, 200)}` : ""
        }`
      );
    }
    let parsed: AnyRecord;
    try {
      parsed = JSON.parse(text) as AnyRecord;
    } catch {
      throw new KbTransportError("Qdrant returned a non-JSON collection description");
    }
    const result = (parsed.result ?? {}) as AnyRecord;
    const config = ((result.config ?? {}) as AnyRecord).params as AnyRecord | undefined;
    const vectors = config?.vectors as AnyRecord | number | undefined;
    let dimension: number | null = null;
    if (vectors && typeof vectors === "object") {
      if (typeof (vectors as AnyRecord).size === "number") {
        dimension = (vectors as AnyRecord).size as number;
      } else if (this.cfg.vectorName) {
        const named = (vectors as AnyRecord)[this.cfg.vectorName] as AnyRecord | undefined;
        if (named && typeof named.size === "number") dimension = named.size;
      }
    }
    const pointsCount =
      typeof result.points_count === "number" ? (result.points_count as number) : null;
    return { dimension, pointsCount };
  }

  /**
   * Retrieve with a PRE-COMPUTED query vector. Embedding is the caller's job
   * (lib/kb/embed.ts) so the adapter stays provider-pure and testable.
   */
  async retrieveWithVector(
    vector: number[],
    request: RetrievalRequest
  ): Promise<RetrievalResult> {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new KbConfigError("query vector is empty");
    }
    if (this.cfg.dimension && vector.length !== this.cfg.dimension) {
      throw new KbConfigError(
        `query vector has ${vector.length} dimensions but collection '${this.cfg.collection}' ` +
          `expects ${this.cfg.dimension}`
      );
    }

    const topK = Math.min(Math.max(request.topK || 5, 1), 100);
    const filter = buildFilter(request.filters);
    const notes: string[] = [];
    const started = Date.now();

    // Modern Query API first.
    const queryBody: AnyRecord = {
      query: vector,
      limit: topK,
      with_payload: true,
    };
    if (this.cfg.vectorName) queryBody.using = this.cfg.vectorName;
    if (filter) queryBody.filter = filter;
    if (typeof request.scoreThreshold === "number") {
      queryBody.score_threshold = request.scoreThreshold;
    }

    const collection = encodeURIComponent(this.cfg.collection);
    let points: AnyRecord[] | null = null;

    const q = await this.post(`/collections/${collection}/points/query`, queryBody);
    if (q.status === 404) {
      // Either the collection is missing or this cluster predates /points/query.
      notes.push("/points/query returned 404 — retrying the legacy /points/search endpoint");
      const searchBody: AnyRecord = {
        vector: this.cfg.vectorName ? { name: this.cfg.vectorName, vector } : vector,
        limit: topK,
        with_payload: true,
      };
      if (filter) searchBody.filter = filter;
      if (typeof request.scoreThreshold === "number") {
        searchBody.score_threshold = request.scoreThreshold;
      }
      const s = await this.post(`/collections/${collection}/points/search`, searchBody);
      if (s.status === 404) {
        throw new KbTransportError(
          `Qdrant collection '${this.cfg.collection}' not found (both /points/query and /points/search returned 404)`
        );
      }
      if (s.status < 200 || s.status >= 300) {
        throw new KbTransportError(
          `Qdrant search failed: HTTP ${s.status}${s.text ? ` ${s.text.slice(0, 200)}` : ""}`
        );
      }
      points = extractPoints(s.text);
    } else if (q.status === 401 || q.status === 403) {
      throw new KbTransportError(
        `Qdrant rejected the API key (HTTP ${q.status}) — check the credential reference`
      );
    } else if (q.status < 200 || q.status >= 300) {
      throw new KbTransportError(
        `Qdrant query failed: HTTP ${q.status}${q.text ? ` ${q.text.slice(0, 200)}` : ""}`
      );
    } else {
      points = extractPoints(q.text);
    }

    const latencyMs = Date.now() - started;
    const passages: Passage[] = [];
    let dropped = 0;
    let probed: string | null = null;
    for (const point of points ?? []) {
      const { passage, probedTextField } = normalizePoint(point, this.cfg.fieldMapping, this.cfg.collection);
      if (probedTextField) probed = probedTextField;
      if (passage) passages.push(passage);
      else dropped += 1;
    }

    if (!this.cfg.fieldMapping?.textField && probed) {
      notes.push(`text field was not configured; used payload key '${probed}'`);
    }
    if (dropped > 0) {
      notes.push(
        `${dropped} point(s) had no readable text field — set knowledgeConfig.fieldMapping.textField ` +
          `to the payload key holding your chunk text`
      );
    }

    return {
      passages,
      provider: this.provider,
      target: this.cfg.collection,
      embedding: null, // the caller owns embedding and fills this in
      latencyMs,
      notes,
    };
  }

  /**
   * KbRetriever entry point. Requires a vector, so the service layer calls
   * `retrieveWithVector`; this exists to satisfy the interface and gives a
   * clear error if used directly.
   */
  async retrieve(_request: RetrievalRequest): Promise<RetrievalResult> {
    throw new KbConfigError(
      "QdrantRetriever needs an embedded query — call retrieveWithVector(), " +
        "or go through lib/kb/service.ts which embeds first"
    );
  }
}

/**
 * Turn an opaque network failure into something actionable.
 *
 * Node's `fetch` rejects with the bare message "fetch failed" and hides the
 * real reason in `error.cause`, which makes a down cluster indistinguishable
 * from a bad URL. We unwrap the cause chain and name the common cases.
 */
export function describeNetworkError(e: unknown, url: string): string {
  const err = e as { name?: string; message?: string; cause?: unknown };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `Qdrant request to ${url} timed out`;
  }
  const cause = err?.cause as
    | { code?: string; message?: string; errno?: number; cause?: unknown }
    | undefined;
  const code = cause?.code ?? (cause?.cause as { code?: string } | undefined)?.code;
  const detail = cause?.message ?? err?.message ?? "unknown error";

  const hints: Record<string, string> = {
    ECONNRESET:
      "the host accepted the TCP connection then reset it — typically a cluster that is not running yet (provisioning/suspended) or a TLS-terminating middlebox",
    ECONNREFUSED: "nothing is listening on that host/port",
    ENOTFOUND: "DNS did not resolve the host",
    EAI_AGAIN: "DNS lookup failed temporarily",
    ETIMEDOUT: "the connection timed out",
    CERT_HAS_EXPIRED: "the TLS certificate has expired",
    DEPTH_ZERO_SELF_SIGNED_CERT: "the TLS certificate is self-signed",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the TLS certificate chain could not be verified",
  };
  const hint = code && hints[code] ? ` — ${hints[code]}` : "";
  return `could not reach Qdrant at ${url}: ${code ?? detail}${hint}`;
}

/** Pull the scored-point array out of either response shape. Pure. */
export function extractPoints(text: string): AnyRecord[] {
  let parsed: AnyRecord;
  try {
    parsed = JSON.parse(text) as AnyRecord;
  } catch {
    throw new KbTransportError("Qdrant returned a non-JSON response");
  }
  const result = parsed.result;
  // /points/query -> { result: { points: [...] } }
  if (result && typeof result === "object" && Array.isArray((result as AnyRecord).points)) {
    return (result as AnyRecord).points as AnyRecord[];
  }
  // /points/search -> { result: [...] }
  if (Array.isArray(result)) return result as AnyRecord[];
  return [];
}
