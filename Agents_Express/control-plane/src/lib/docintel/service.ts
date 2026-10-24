// Document Intelligence lifecycle — upload, extract, review, submit, finalize.
//
// Every step is a governed action in the DOCUMENT'S tenant:
//   viewDocument      viewer+     list / read jobs and finalized documents
//   processDocument   analyst+    upload, run IDP methods
//   reviewDocument    analyst+    edit the review, submit for finalization
//   finalizeDocument  approver+   finalize or send back — never the submitter
// Membership, role minimums and the GxP / residency policies are applied by
// the evaluator, so an untrained persona cannot finalize a GxP document.
//
// The IDP engine extracts; this module decides. The finalized artifact is the
// FinalizedDocument v1 contract, validated before it is stored and published.

import { evaluate } from "../evaluator";
import { logAudit, newId, store } from "../store";
import type { FinalizedDocumentRecord } from "../store";
import { tenantPolicyAttributes } from "../tenancy";
import { DOCINTEL_TOOL } from "../regulatory";
import {
  FINALIZED_DOCUMENT_SCHEMA,
  contentSha256,
  sha256Hex,
  validateFinalizedDocument,
} from "./contract";
import type { FdContent, FinalizedDocument } from "./contract";
import { idpProcess, idpUpload } from "./idpClient";
import type { DocumentJob, DocumentReview, MethodRun } from "./model";
import { applyEdits, draftReview } from "./review";
import { publishToDelta } from "./delta";

export class DocIntelError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ALLOWED_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
};
/** Methods offered by default: ones that need no extra AWS setup (BDA profiles, Guardrails). */
export const DEFAULT_METHODS = ["claude-haiku", "claude-sonnet", "nova-lite", "textract-claude-haiku"];
export const DEFAULT_CAPABILITIES = [
  "text_extraction", "kv_extraction", "table_extraction", "document_classification", "pii_detection",
];
const SAFE_ID = /^[a-z0-9_-]{1,64}$/;

function persona(personaId: string) {
  const p = store.personas.find((x) => x.id === personaId && !x.disabled);
  if (!p) throw new DocIntelError("PERSONA_REQUIRED", "a valid personaId is required", 400);
  return p;
}

/** Cedar decision for one Document Intelligence action in one tenant; throws on deny. */
export function authorizeDoc(personaId: string, tenantId: string, action: string, resource: string) {
  const d = evaluate({
    personaId, agentId: "docintel", action, tool: DOCINTEL_TOOL, resource, tenantId,
  });
  if (!d.allowed) {
    const reason = d.decisions[d.decisions.length - 1]?.reason ?? "denied";
    logAudit({ category: "agent", action: `docintel-${action}-denied`, actor: persona(personaId).name,
      tenantId, detail: `DENY ${action} on ${resource}: ${reason}` });
    throw new DocIntelError("NOT_PERMITTED", reason, 403);
  }
}

function job(documentId: string): DocumentJob {
  const j = store.documentJobs.find((x) => x.documentId === documentId);
  if (!j) throw new DocIntelError("NOT_FOUND", `document '${documentId}' not found`, 404);
  return j;
}

function touch(j: DocumentJob) {
  j.updatedAt = new Date().toISOString();
}

// --------------------------------------------------------------------------- //
// Reads
// --------------------------------------------------------------------------- //

/** Jobs the persona may view (viewDocument in each job's tenant). */
export function listJobs(personaId: string, tenantId?: string): DocumentJob[] {
  persona(personaId);
  return store.documentJobs
    .filter((j) => !tenantId || j.tenantId === tenantId)
    .filter((j) => evaluate({ personaId, agentId: "docintel", action: "viewDocument", tool: DOCINTEL_TOOL,
      resource: j.documentId, tenantId: j.tenantId }).allowed)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(documentId: string, personaId: string): DocumentJob {
  const j = job(documentId);
  authorizeDoc(personaId, j.tenantId, "viewDocument", j.documentId);
  return j;
}

export function getFinalized(finalizedDocumentId: string, personaId: string): FinalizedDocumentRecord {
  const rec = store.finalizedDocuments.find((r) => r.doc.finalizedDocumentId === finalizedDocumentId);
  if (!rec) throw new DocIntelError("NOT_FOUND", `finalized document '${finalizedDocumentId}' not found`, 404);
  authorizeDoc(personaId, rec.doc.tenantId, "viewDocument", rec.doc.documentId);
  return rec;
}

// --------------------------------------------------------------------------- //
// Upload and extraction
// --------------------------------------------------------------------------- //

export async function createJob(input: {
  tenantId: string;
  personaId: string;
  fileName: string;
  bytes: Buffer;
}): Promise<DocumentJob> {
  const p = persona(input.personaId);
  if (!store.tenants.some((t) => t.id === input.tenantId)) {
    throw new DocIntelError("UNKNOWN_TENANT", `unknown tenant '${input.tenantId}'`);
  }
  authorizeDoc(p.id, input.tenantId, "processDocument", "new-document");
  const name = input.fileName.replace(/[\\/]/g, "_").slice(0, 200);
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const mimeType = ALLOWED_TYPES[ext];
  if (!mimeType) {
    throw new DocIntelError("UNSUPPORTED_TYPE", `file type '.${ext}' is not accepted (${Object.keys(ALLOWED_TYPES).join(", ")})`);
  }
  if (input.bytes.length === 0 || input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new DocIntelError("BAD_SIZE", `file must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }
  const sha = sha256Hex(input.bytes);
  const up = await idpUpload(input.bytes, name, mimeType, { tenantId: input.tenantId, personaId: p.id });
  const now = new Date().toISOString();
  const j: DocumentJob = {
    documentId: newId("doc"),
    tenantId: input.tenantId,
    createdBy: p.id,
    createdAt: now,
    updatedAt: now,
    fileName: name,
    mimeType,
    sizeBytes: input.bytes.length,
    sha256: sha,
    ...(up.pageCount ? { pageCount: up.pageCount } : {}),
    idpDocumentId: up.documentId,
    idpRef: up.ref,
    status: "uploaded",
    capabilities: [],
    methodRuns: [],
    finalizedDocumentIds: [],
  };
  store.documentJobs.unshift(j);
  logAudit({ category: "agent", action: "docintel-upload", actor: p.name, tenantId: j.tenantId,
    detail: `Uploaded '${name}' (${j.sizeBytes} bytes, sha256 ${sha.slice(0, 12)}…) as ${j.documentId}` });
  return j;
}

/** Pick the method whose output is the best starting point for review. Pure. */
export function bestRun(runs: MethodRun[]): MethodRun | undefined {
  const ok = runs.filter((r) => r.status === "complete" && Object.keys(r.results).length > 0);
  return ok.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
}

/** Start extraction; returns immediately, the job moves to extracted | failed. */
export function startRun(input: {
  documentId: string;
  personaId: string;
  methods?: string[];
  capabilities?: string[];
}, run = idpProcess): DocumentJob {
  const j = job(input.documentId);
  const p = persona(input.personaId);
  authorizeDoc(p.id, j.tenantId, "processDocument", j.documentId);
  if (j.status === "processing") throw new DocIntelError("BUSY", "extraction is already running", 409);
  if (j.status === "pending-finalization") {
    throw new DocIntelError("LOCKED", "the document is awaiting finalization; send it back first", 409);
  }
  const methods = (input.methods?.length ? input.methods : DEFAULT_METHODS).filter((m) => SAFE_ID.test(m)).slice(0, 8);
  const capabilities = (input.capabilities?.length ? input.capabilities : DEFAULT_CAPABILITIES)
    .filter((c) => SAFE_ID.test(c)).slice(0, 16);
  if (!methods.length || !capabilities.length) throw new DocIntelError("BAD_REQUEST", "choose at least one method and capability");
  if (!j.idpDocumentId || !j.idpRef) throw new DocIntelError("NO_FILE", "the document has no engine reference", 409);

  j.status = "processing";
  j.capabilities = capabilities;
  j.runError = undefined;
  touch(j);
  logAudit({ category: "agent", action: "docintel-run", actor: p.name, tenantId: j.tenantId,
    detail: `Extraction of ${j.documentId} started: ${methods.join(", ")} × ${capabilities.join(", ")}` });

  void (async () => {
    try {
      const runs = await run({ idpDocumentId: j.idpDocumentId!, ref: j.idpRef!, methods, capabilities },
        { tenantId: j.tenantId, personaId: p.id });
      j.methodRuns = runs;
      const best = bestRun(runs);
      if (!best) {
        j.status = "failed";
        j.runError = runs.map((r) => `${r.method}: ${r.error ?? "no output"}`).join("; ").slice(0, 600);
      } else {
        j.status = "extracted";
        // A finalized document being re-reviewed keeps its review until changed.
        if (!j.review || j.finalizedDocumentIds.length === 0) j.review = draftReview(best, p.id);
      }
    } catch (e) {
      j.status = "failed";
      j.runError = (e as Error).message.slice(0, 600);
    }
    touch(j);
    logAudit({ category: "agent", action: `docintel-run-${j.status}`, actor: p.name, tenantId: j.tenantId,
      detail: `Extraction of ${j.documentId}: ${j.status}` +
        (j.status === "failed" ? ` — ${j.runError}` : ` (${j.methodRuns.filter((r) => r.status === "complete").length}/${j.methodRuns.length} methods)`) });
  })();
  return j;
}

// --------------------------------------------------------------------------- //
// Review, submit, send back
// --------------------------------------------------------------------------- //

export function saveReview(input: {
  documentId: string;
  personaId: string;
  selectedMethod?: string;
  edits?: Partial<Pick<DocumentReview, "docType" | "text" | "fields" | "tables" | "summary">>;
}): DocumentJob {
  const j = job(input.documentId);
  const p = persona(input.personaId);
  authorizeDoc(p.id, j.tenantId, "reviewDocument", j.documentId);
  if (!["extracted", "in-review", "finalized"].includes(j.status)) {
    throw new DocIntelError("NOT_REVIEWABLE", `a ${j.status} document cannot be reviewed`, 409);
  }
  let base = j.review;
  if (input.selectedMethod && input.selectedMethod !== base?.selectedMethod) {
    const r = j.methodRuns.find((m) => m.method === input.selectedMethod && m.status === "complete");
    if (!r) throw new DocIntelError("BAD_METHOD", `no completed result for method '${input.selectedMethod}'`);
    base = draftReview(r, p.id);
  }
  if (!base) throw new DocIntelError("NO_RESULTS", "run extraction before reviewing", 409);
  j.review = applyEdits(base, input.edits ?? {}, p.id);
  j.status = "in-review";
  touch(j);
  logAudit({ category: "agent", action: "docintel-review", actor: p.name, tenantId: j.tenantId,
    detail: `Review of ${j.documentId} saved (method ${j.review.selectedMethod}, ` +
      `${j.review.fields.filter((f) => f.edited).length} edited field(s))` });
  return j;
}

export function submitForFinalization(documentId: string, personaId: string): DocumentJob {
  const j = job(documentId);
  const p = persona(personaId);
  authorizeDoc(p.id, j.tenantId, "reviewDocument", j.documentId);
  if (!j.review) throw new DocIntelError("NO_REVIEW", "save a review before submitting", 409);
  if (!["extracted", "in-review"].includes(j.status)) {
    throw new DocIntelError("NOT_SUBMITTABLE", `a ${j.status} document cannot be submitted`, 409);
  }
  j.status = "pending-finalization";
  j.submittedBy = p.id;
  j.submittedAt = new Date().toISOString();
  j.sentBackNote = undefined;
  touch(j);
  logAudit({ category: "agent", action: "docintel-submit", actor: p.name, tenantId: j.tenantId,
    detail: `${j.documentId} submitted for finalization by ${p.name}` });
  return j;
}

export function sendBack(documentId: string, personaId: string, note: string): DocumentJob {
  const j = job(documentId);
  const p = persona(personaId);
  authorizeDoc(p.id, j.tenantId, "finalizeDocument", j.documentId);
  if (j.status !== "pending-finalization") throw new DocIntelError("NOT_PENDING", "only a pending document can be sent back", 409);
  j.status = "in-review";
  j.sentBackNote = note.slice(0, 1000);
  touch(j);
  logAudit({ category: "agent", action: "docintel-send-back", actor: p.name, tenantId: j.tenantId,
    detail: `${j.documentId} sent back by ${p.name}: ${j.sentBackNote}` });
  return j;
}

// --------------------------------------------------------------------------- //
// Finalize
// --------------------------------------------------------------------------- //

/** Build the v1 artifact from a job's review. Pure apart from the clock/id. */
export function buildFinalizedDocument(
  j: DocumentJob,
  approver: { id: string; name: string },
  submitter: { id: string; name: string },
  note: string | null,
  now = new Date().toISOString(),
  id = newId("fd")
): FinalizedDocument {
  const r = j.review!;
  const attrs = tenantPolicyAttributes(j.tenantId, store.tenants);
  const content: FdContent = {
    text: r.text,
    fields: r.fields,
    tables: r.tables,
    summary: r.summary,
  };
  const previous = j.finalizedDocumentIds[j.finalizedDocumentIds.length - 1] ?? null;
  return {
    schemaVersion: FINALIZED_DOCUMENT_SCHEMA,
    finalizedDocumentId: id,
    version: j.finalizedDocumentIds.length + 1,
    supersedes: previous,
    tenantId: j.tenantId,
    documentId: j.documentId,
    source: {
      fileName: j.fileName, mimeType: j.mimeType, sizeBytes: j.sizeBytes, sha256: j.sha256,
      ...(j.pageCount ? { pageCount: j.pageCount } : {}),
    },
    classification: {
      docType: r.docType || "document",
      gxp: attrs.gxp === "true",
      region: (["US", "EU", "JP"].includes(attrs.region) ? attrs.region : null) as "US" | "EU" | "JP" | null,
    },
    content,
    pii: {
      redaction: r.piiRedacted ? "redacted" : r.piiDetected.length ? "retained"
        : j.capabilities.includes("pii_detection") ? "none-detected" : "retained",
      detected: r.piiDetected,
    },
    provenance: {
      engine: "idp-unified-platform",
      idpDocumentId: j.idpDocumentId ?? null,
      methodsRun: j.methodRuns.map((m) => ({
        method: m.method, status: m.status, latencyMs: m.latencyMs, cost: m.cost,
        confidence: m.confidence === null ? null : Math.max(0, Math.min(1, m.confidence)),
      })),
      selectedMethod: r.selectedMethod,
      capabilities: j.capabilities,
      submittedBy: { personaId: submitter.id, name: submitter.name },
      submittedAt: j.submittedAt!,
      finalizedBy: { personaId: approver.id, name: approver.name },
      finalizedAt: now,
      reviewNote: note,
    },
    contentSha256: contentSha256(content),
  };
}

export async function finalize(
  documentId: string,
  personaId: string,
  note: string | null,
  publish = publishToDelta
): Promise<FinalizedDocumentRecord> {
  const j = job(documentId);
  const p = persona(personaId);
  if (j.status !== "pending-finalization" || !j.submittedBy) {
    throw new DocIntelError("NOT_PENDING", "submit the document for finalization first", 409);
  }
  if (j.submittedBy === p.id) {
    logAudit({ category: "agent", action: "docintel-finalize-denied", actor: p.name, tenantId: j.tenantId,
      detail: `DENY self-finalization of ${j.documentId}` });
    throw new DocIntelError("SELF_REVIEW", `${p.name} submitted this document and cannot also finalize it (four-eyes rule)`, 403);
  }
  authorizeDoc(p.id, j.tenantId, "finalizeDocument", j.documentId);
  const submitter = store.personas.find((x) => x.id === j.submittedBy)!;
  const doc = buildFinalizedDocument(j, { id: p.id, name: p.name }, { id: submitter.id, name: submitter.name }, note);
  const errors = validateFinalizedDocument(doc);
  if (errors.length) throw new DocIntelError("INVALID_DOCUMENT", `contract violation: ${errors.join("; ")}`, 500);

  const rec: FinalizedDocumentRecord = { doc, delta: { status: "pending" } };
  store.finalizedDocuments.unshift(rec);
  j.finalizedDocumentIds.push(doc.finalizedDocumentId);
  j.status = "finalized";
  touch(j);
  logAudit({ category: "agent", action: "docintel-finalize", actor: p.name, tenantId: j.tenantId,
    detail: `${j.documentId} finalized as ${doc.finalizedDocumentId} v${doc.version} by ${p.name} ` +
      `(submitted by ${submitter.name}; content sha256 ${doc.contentSha256.slice(0, 12)}…)` });

  // Publish to Delta; the record says what happened either way.
  try {
    const out = await publish(doc);
    rec.delta = { status: out.status, detail: out.detail, at: new Date().toISOString() };
  } catch (e) {
    rec.delta = { status: "failed", detail: (e as Error).message.slice(0, 400), at: new Date().toISOString() };
  }
  return rec;
}
