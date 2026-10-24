// Server-to-server client for the IDP engine running as a private sidecar.
//
// The engine runs in SERVICE MODE: every call carries the shared service
// token plus the tenant and persona the control plane has already authorized.
// Browsers never talk to it, and it is never told which file to read by
// anyone but the control plane: `process()` passes only the reference IDP
// itself returned from `upload()`.
//
// IDP streams results over Server-Sent Events on the POST response
// (`data: {...}\n\n`). They are consumed here, server-side, into a plain
// result object.

import type { CapabilityOutput, MethodRun } from "./model";

export class IdpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface IdpCaller {
  tenantId: string;
  personaId: string;
}

export function idpConfig(): { url: string; token: string } | null {
  const url = (process.env.IDP_URL || "").replace(/\/+$/, "");
  const token = process.env.IDP_SERVICE_TOKEN || "";
  return url && token ? { url, token } : null;
}

function headers(token: string, caller: IdpCaller): Record<string, string> {
  return { "X-Service-Token": token, "X-Tenant-Id": caller.tenantId, "X-Persona-Id": caller.personaId };
}

function requireConfig() {
  const cfg = idpConfig();
  if (!cfg) {
    throw new IdpError("IDP_NOT_CONFIGURED",
      "the IDP engine is not configured: set IDP_URL and IDP_SERVICE_TOKEN in the control plane's environment");
  }
  return cfg;
}

export async function idpHealth(): Promise<{ ok: boolean; detail: string }> {
  const cfg = idpConfig();
  if (!cfg) return { ok: false, detail: "IDP_URL / IDP_SERVICE_TOKEN not set" };
  try {
    const r = await fetch(`${cfg.url}/api/health`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    return { ok: r.ok, detail: r.ok ? "healthy" : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export interface IdpUpload {
  documentId: string;
  ref: string;
  pageCount?: number;
  documentType?: string;
}

/** Upload bytes the control plane holds. Returns IDP's own reference for them. */
export async function idpUpload(file: Buffer, fileName: string, mimeType: string, caller: IdpCaller): Promise<IdpUpload> {
  const cfg = requireConfig();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file)], { type: mimeType || "application/octet-stream" }), fileName);
  const r = await fetch(`${cfg.url}/api/upload`, {
    method: "POST",
    headers: headers(cfg.token, caller),
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new IdpError("IDP_UPLOAD_FAILED", `IDP upload returned ${r.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { documentId: string; s3Uri: string; pageCount?: number; documentType?: string };
  if (!body.documentId || !body.s3Uri) throw new IdpError("IDP_UPLOAD_FAILED", "IDP upload response lacks documentId/s3Uri");
  return { documentId: body.documentId, ref: body.s3Uri, pageCount: body.pageCount, documentType: body.documentType };
}

/** Parse an SSE body (`data: {...}\n\n` frames) into events. Pure; exported for tests. */
export function parseSse(body: string): unknown[] {
  const events: unknown[] = [];
  for (const frame of body.split(/\n\n+/)) {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // keepalive comments or partial frames are not events
    }
  }
  return events;
}

interface RawProcessorResult {
  method: string;
  status: string;
  results?: Record<string, { data?: unknown; confidence?: number; format?: string }>;
  metrics?: { latencyMs?: number; cost?: number; confidence?: number };
  error?: string;
}

/** Normalise IDP's SSE events into one MethodRun per requested method. Pure. */
export function methodRunsFromEvents(events: unknown[], methods: string[]): MethodRun[] {
  const byMethod = new Map<string, MethodRun>();
  const toRun = (r: RawProcessorResult): MethodRun => ({
    method: r.method,
    status: r.status === "complete" ? "complete" : "error",
    latencyMs: r.metrics?.latencyMs ?? null,
    cost: r.metrics?.cost ?? null,
    confidence: r.metrics?.confidence ?? null,
    ...(r.error ? { error: r.error } : {}),
    results: Object.fromEntries(
      Object.entries(r.results ?? {}).map(([cap, v]): [string, CapabilityOutput] => [
        cap,
        { data: v?.data ?? null, confidence: typeof v?.confidence === "number" ? v.confidence : null, format: v?.format ?? "text" },
      ])
    ),
  });
  for (const ev of events as Record<string, unknown>[]) {
    const type = String(ev?.type ?? "");
    if (type === "method_complete" && ev.data) {
      const run = toRun(ev.data as RawProcessorResult);
      byMethod.set(run.method, run);
    } else if (type === "method_error") {
      const m = String(ev.method ?? "");
      byMethod.set(m, { method: m, status: "error", latencyMs: null, cost: null, confidence: null,
        error: String(ev.error ?? "method error"), results: {} });
    } else if (type === "all_complete") {
      const results = ((ev.data as { results?: RawProcessorResult[] })?.results ?? []);
      for (const r of results) byMethod.set(r.method, toRun(r));
    }
  }
  return methods.map((m) => byMethod.get(m) ?? {
    method: m, status: "error", latencyMs: null, cost: null, confidence: null,
    error: "no result returned by the IDP engine", results: {},
  });
}

/** Run methods on a document the control plane uploaded. */
export async function idpProcess(
  input: { idpDocumentId: string; ref: string; methods: string[]; capabilities: string[] },
  caller: IdpCaller,
  timeoutMs = 10 * 60 * 1000
): Promise<MethodRun[]> {
  const cfg = requireConfig();
  const r = await fetch(`${cfg.url}/api/process`, {
    method: "POST",
    headers: { ...headers(cfg.token, caller), "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      documentId: input.idpDocumentId,
      s3Uri: input.ref,
      methods: input.methods,
      capabilities: input.capabilities,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new IdpError("IDP_PROCESS_FAILED", `IDP process returned ${r.status}: ${text.slice(0, 300)}`);
  return methodRunsFromEvents(parseSse(text), input.methods);
}
