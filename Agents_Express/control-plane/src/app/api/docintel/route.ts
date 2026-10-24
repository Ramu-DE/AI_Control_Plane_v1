// Document Intelligence API: upload → extract → review → submit → finalize.
//
//   GET  ?personaId=…[&tenantId=…]                 -> jobs the persona may view
//   GET  ?personaId=…&documentId=…                 -> one job
//   GET  ?personaId=…&finalizedDocumentId=…        -> one FinalizedDocument v1
//   GET  ?health=1                                 -> IDP engine reachability
//   POST multipart { file, tenantId, personaId }   -> new job (uploaded)
//   POST { op: "run" | "review" | "submit" | "sendBack" | "finalize", ... }
//
// All decisions are made in lib/docintel/service.ts. The engine's storage
// reference never leaves the server (publicJob).

import { NextRequest, NextResponse } from "next/server";
import { publicJob } from "@/lib/docintel/model";
import { IdpError, idpConfig, idpHealth } from "@/lib/docintel/idpClient";
import { deltaTarget } from "@/lib/docintel/delta";
import {
  ALLOWED_TYPES,
  DEFAULT_CAPABILITIES,
  DEFAULT_METHODS,
  DocIntelError,
  MAX_UPLOAD_BYTES,
  createJob,
  finalize,
  getFinalized,
  getJob,
  listJobs,
  saveReview,
  sendBack,
  startRun,
  submitForFinalization,
} from "@/lib/docintel/service";

export const runtime = "nodejs";
export const maxDuration = 120;

function errorResponse(e: unknown): NextResponse {
  if (e instanceof DocIntelError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (e instanceof IdpError) {
    const status = e.code === "IDP_NOT_CONFIGURED" ? 503 : 502;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  return NextResponse.json({ error: (e as Error).message ?? "internal error" }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  try {
    if (q.get("health")) {
      const delta = deltaTarget();
      return NextResponse.json({
        idp: { configured: Boolean(idpConfig()), ...(await idpHealth()) },
        delta: delta ? { configured: true, table: `${delta.catalog}.${delta.schema}.finalized_documents` } : { configured: false },
        limits: { maxUploadBytes: MAX_UPLOAD_BYTES, types: Object.keys(ALLOWED_TYPES) },
        defaults: { methods: DEFAULT_METHODS, capabilities: DEFAULT_CAPABILITIES },
      });
    }
    const personaId = q.get("personaId") ?? "";
    const fdId = q.get("finalizedDocumentId");
    if (fdId) return NextResponse.json(getFinalized(fdId, personaId));
    const documentId = q.get("documentId");
    if (documentId) return NextResponse.json({ job: publicJob(getJob(documentId, personaId)) });
    const jobs = listJobs(personaId, q.get("tenantId") || undefined);
    return NextResponse.json({ jobs: jobs.map(publicJob) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new DocIntelError("BAD_REQUEST", "a 'file' part is required");
      if (file.size > MAX_UPLOAD_BYTES) throw new DocIntelError("BAD_SIZE", `file exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
      const job = await createJob({
        tenantId: String(form.get("tenantId") ?? ""),
        personaId: String(form.get("personaId") ?? ""),
        fileName: file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
      return NextResponse.json({ job: publicJob(job) }, { status: 201 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const documentId = String(body.documentId ?? "");
    const personaId = String(body.personaId ?? "");
    const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
    switch (body.op) {
      case "run":
        return NextResponse.json({ job: publicJob(startRun({
          documentId, personaId, methods: strings(body.methods), capabilities: strings(body.capabilities),
        })) }, { status: 202 });
      case "review":
        return NextResponse.json({ job: publicJob(saveReview({
          documentId, personaId,
          selectedMethod: typeof body.selectedMethod === "string" ? body.selectedMethod : undefined,
          edits: (body.edits ?? {}) as Parameters<typeof saveReview>[0]["edits"],
        })) });
      case "submit":
        return NextResponse.json({ job: publicJob(submitForFinalization(documentId, personaId)) });
      case "sendBack":
        return NextResponse.json({ job: publicJob(sendBack(documentId, personaId, String(body.note ?? ""))) });
      case "finalize": {
        const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 1000) : null;
        const rec = await finalize(documentId, personaId, note);
        return NextResponse.json({ finalized: rec, job: publicJob(getJob(documentId, personaId)) });
      }
      default:
        throw new DocIntelError("BAD_REQUEST", `unknown op '${String(body.op)}'`);
    }
  } catch (e) {
    return errorResponse(e);
  }
}
