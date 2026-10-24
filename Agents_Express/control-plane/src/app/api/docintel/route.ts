// Document Intelligence API: upload → extract → review → submit → finalize.
//
//   GET  ?personaId=…[&tenantId=…]                 -> jobs the persona may view
//   GET  ?personaId=…&documentId=…                 -> one job
//   GET  ?personaId=…&finalizedDocumentId=…        -> one FinalizedDocument v1
//   GET  ?health=1                                 -> IDP engine reachability
//   GET  ?personaId=…&types=1[&tenantId=…]          -> Document Types (manageable + published for the tenant)
//   GET  ?personaId=…&analytics=1[&tenantId=…]      -> quality analytics over documents the persona may view
//   POST multipart { file, tenantId, personaId }   -> new job (uploaded)
//   POST { op: "run" | "review" | "validate" | "submit" | "sendBack" | "finalize", ... }
//   POST { op: "typeCreate" | "typeUpdate" | "typeSubmit" | "typeApprove" | "typeReject" | "typeDeprecate", ... }
//
// All decisions are made in lib/docintel/service.ts. The engine's storage
// reference never leaves the server (publicJob).

import { NextRequest, NextResponse } from "next/server";
import { publicJob } from "@/lib/docintel/model";
import { IdpError, idpConfig, idpHealth } from "@/lib/docintel/idpClient";
import { deltaTarget } from "@/lib/docintel/delta";
import { computeAnalytics } from "@/lib/docintel/analytics";
import {
  DocTypeError, availableTypes, createType, decideType, deprecateType, listTypes, submitType, updateType,
} from "@/lib/docintel/doctypes";
import type { DocTypeSpec } from "@/lib/docintel/doctypes";
import { store } from "@/lib/store";
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
  revalidate,
  startRun,
  submitForFinalization,
} from "@/lib/docintel/service";

export const runtime = "nodejs";
export const maxDuration = 120;

function errorResponse(e: unknown): NextResponse {
  if (e instanceof DocIntelError || e instanceof DocTypeError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
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
    const tenantId = q.get("tenantId") || undefined;
    if (q.get("types")) {
      return NextResponse.json({
        types: listTypes(personaId),
        available: tenantId ? availableTypes(tenantId).map((t) => ({ id: t.id, key: t.key, name: t.published!.spec.name,
          version: t.published!.version, tenantId: t.tenantId, spec: t.published!.spec })) : [],
      });
    }
    if (q.get("analytics")) {
      const jobs = listJobs(personaId, tenantId);
      const ids = new Set(jobs.map((j) => j.documentId));
      const fds = store.finalizedDocuments.filter((r) => ids.has(r.doc.documentId)).map((r) => r.doc);
      const name = (id?: string) => (id ? store.documentTypes.find((t) => t.id === id)?.draft.name ?? id : "(no type)");
      return NextResponse.json(computeAnalytics(jobs, fds, name));
    }
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
        documentTypeId: String(form.get("documentTypeId") ?? "") || undefined,
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
        return NextResponse.json({ job: publicJob(await saveReview({
          documentId, personaId,
          selectedMethod: typeof body.selectedMethod === "string" ? body.selectedMethod : undefined,
          edits: (body.edits ?? {}) as Parameters<typeof saveReview>[0]["edits"],
        })) });
      case "validate":
        return NextResponse.json({ job: publicJob(await revalidate(documentId, personaId)) });
      case "submit":
        return NextResponse.json({ job: publicJob(await submitForFinalization(documentId, personaId,
          typeof body.justification === "string" ? body.justification : undefined)) });
      case "typeCreate":
        return NextResponse.json({ type: createType({ tenantId: String(body.tenantId ?? ""), personaId,
          key: String(body.key ?? ""), spec: body.spec as DocTypeSpec }) }, { status: 201 });
      case "typeUpdate":
        return NextResponse.json({ type: updateType(String(body.typeId ?? ""), personaId, body.spec as DocTypeSpec) });
      case "typeSubmit":
        return NextResponse.json({ type: submitType(String(body.typeId ?? ""), personaId) });
      case "typeApprove":
      case "typeReject":
        return NextResponse.json({ type: decideType(String(body.typeId ?? ""), personaId,
          body.op === "typeApprove" ? "approve" : "reject", typeof body.note === "string" ? body.note : undefined) });
      case "typeDeprecate":
        return NextResponse.json({ type: deprecateType(String(body.typeId ?? ""), personaId, body.deprecated !== false) });
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
