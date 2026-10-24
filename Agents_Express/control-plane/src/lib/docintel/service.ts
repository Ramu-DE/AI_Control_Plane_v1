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
import { onDocumentFinalized } from "../ragfactory/service";
import { availableTypes, classifyToType, ucMasterDataLookup, usableType } from "./doctypes";
import type { DocumentType } from "./doctypes";
import { blockingIssues, mapFieldsToSchema, validateReview } from "./validation";
import type { MasterDataLookup } from "./validation";

let masterDataLookup: MasterDataLookup = ucMasterDataLookup;
/** Tests replace the Unity Catalog lookup. */
export function setMasterDataLookup(l: MasterDataLookup) {
  masterDataLookup = l;
}

/** The service principal recorded when a clean, non-GxP document is auto-finalized. */
export const AUTO_FINALIZER = { id: "svc-docintel-auto", name: "Document Intelligence (auto-finalize)" };

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
/**
 * Methods run when the caller names none: ones that need no extra AWS setup
 * (BDA profiles, Guardrails) and accept multi-page PDFs. Textract-based
 * methods use Textract's synchronous API (single page, 5 MB) unless IDP has an
 * S3 bucket, so they stay opt-in.
 */
export const DEFAULT_METHODS = ["claude-haiku", "claude-sonnet", "nova-lite"];
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
  documentTypeId?: string;
}): Promise<DocumentJob> {
  const p = persona(input.personaId);
  if (!store.tenants.some((t) => t.id === input.tenantId)) {
    throw new DocIntelError("UNKNOWN_TENANT", `unknown tenant '${input.tenantId}'`);
  }
  authorizeDoc(p.id, input.tenantId, "processDocument", "new-document");
  let chosen: DocumentType | undefined;
  if (input.documentTypeId) {
    try {
      chosen = usableType(input.documentTypeId, input.tenantId);
    } catch (e) {
      throw new DocIntelError("BAD_TYPE", (e as Error).message);
    }
  }
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
    ...(chosen ? { documentTypeId: chosen.id, documentTypeVersion: chosen.published!.version, typeSource: "chosen" as const } : {}),
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
  const typeSpec = j.documentTypeId && j.typeSource === "chosen"
    ? store.documentTypes.find((t) => t.id === j.documentTypeId)?.published?.spec : undefined;
  const methods = (input.methods?.length ? input.methods : typeSpec?.methods ?? DEFAULT_METHODS)
    .filter((m) => SAFE_ID.test(m)).slice(0, 8);
  const capabilities = (input.capabilities?.length ? input.capabilities : typeSpec?.capabilities ?? DEFAULT_CAPABILITIES)
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
        if (!j.review || j.finalizedDocumentIds.length === 0) {
          j.review = prepareReview(j, best, p.id);
          await validateJob(j);
          await route(j, p.id);
        }
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
// Document Types: detect, map, validate, route
// --------------------------------------------------------------------------- //

function jobType(j: DocumentJob): DocumentType | undefined {
  return j.documentTypeId ? store.documentTypes.find((t) => t.id === j.documentTypeId && t.published) : undefined;
}

/** Draft a review from one method, detecting the type if none was chosen, and map fields to its schema. */
function prepareReview(j: DocumentJob, run: MethodRun, editor: string) {
  const review = draftReview(run, editor);
  if (j.typeSource !== "chosen") {
    const detected = classifyToType(review.docType, availableTypes(j.tenantId));
    j.documentTypeId = detected?.id;
    j.documentTypeVersion = detected?.published?.version;
    j.typeSource = detected ? "detected" : undefined;
  }
  const t = jobType(j);
  if (!t) return review;
  return { ...review, docType: t.published!.spec.name, fields: mapFieldsToSchema(review.fields, t.published!.spec.fields) };
}

/** Re-run the type's validation on the current review (no-op without a type). */
async function validateJob(j: DocumentJob) {
  const t = jobType(j);
  if (!t || !j.review) {
    j.validation = undefined;
    return;
  }
  const spec = t.published!.spec;
  j.documentTypeVersion = t.published!.version;
  j.validation = await validateReview(j.review, { fields: spec.fields, rules: spec.rules, minConfidence: spec.routing.minConfidence },
    masterDataLookup);
}

/**
 * After extraction: a clean document of a straight-through type is submitted
 * at once (the person who ran it is the maker); in a tenant that is NOT GxP,
 * a type that allows it is finalized by the auto-finalize principal. Anything
 * else is an exception for a person to review.
 */
async function route(j: DocumentJob, runnerId: string) {
  const t = jobType(j);
  if (!t) { j.route = "manual"; return; }
  const routing = t.published!.spec.routing;
  if (!j.validation?.clean) {
    j.route = "exception";
    logAudit({ category: "agent", action: "docintel-exception", actor: "Document Intelligence", tenantId: j.tenantId,
      detail: `${j.documentId} needs review against '${t.published!.spec.name}' v${t.published!.version}: ` +
        `${j.validation?.issues.length ?? 0} issue(s), ${blockingIssues(j.validation).length} blocking` });
    return;
  }
  if (!routing.straightThrough) { j.route = "manual"; return; }
  j.route = "straight-through";
  j.status = "pending-finalization";
  j.submittedBy = runnerId;
  j.submittedAt = new Date().toISOString();
  logAudit({ category: "agent", action: "docintel-straight-through", actor: persona(runnerId).name, tenantId: j.tenantId,
    detail: `${j.documentId} is clean against '${t.published!.spec.name}' v${t.published!.version}; submitted straight through` });
  const gxp = tenantPolicyAttributes(j.tenantId, store.tenants).gxp === "true";
  if (routing.autoFinalize && !gxp) await autoFinalize(j, t);
}

// --------------------------------------------------------------------------- //
// Review, submit, send back
// --------------------------------------------------------------------------- //

export async function saveReview(input: {
  documentId: string;
  personaId: string;
  selectedMethod?: string;
  edits?: Partial<Pick<DocumentReview, "docType" | "text" | "fields" | "tables" | "summary">>;
}): Promise<DocumentJob> {
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
    base = prepareReview(j, r, p.id);
  }
  if (!base) throw new DocIntelError("NO_RESULTS", "run extraction before reviewing", 409);
  j.review = applyEdits(base, input.edits ?? {}, p.id);
  j.status = "in-review";
  await validateJob(j);
  touch(j);
  logAudit({ category: "agent", action: "docintel-review", actor: p.name, tenantId: j.tenantId,
    detail: `Review of ${j.documentId} saved (method ${j.review.selectedMethod}, ` +
      `${j.review.fields.filter((f) => f.edited).length} edited field(s))` });
  return j;
}

/**
 * Submit for finalization. Validation is re-run first (master data may have
 * changed). Blocking issues stop the submission unless the submitter records
 * a justification, which travels into the finalized record.
 */
export async function submitForFinalization(documentId: string, personaId: string, justification?: string): Promise<DocumentJob> {
  const j = job(documentId);
  const p = persona(personaId);
  authorizeDoc(p.id, j.tenantId, "reviewDocument", j.documentId);
  if (!j.review) throw new DocIntelError("NO_REVIEW", "save a review before submitting", 409);
  if (!["extracted", "in-review"].includes(j.status)) {
    throw new DocIntelError("NOT_SUBMITTABLE", `a ${j.status} document cannot be submitted`, 409);
  }
  await validateJob(j);
  const blocking = blockingIssues(j.validation);
  const why = (justification ?? "").trim();
  if (blocking.length && why.length < 10) {
    throw new DocIntelError("VALIDATION_BLOCKED",
      `${blocking.length} blocking issue(s): ${blocking.map((i) => i.message).join("; ")}. ` +
      "Fix them, or submit with a justification (10+ characters) that will be recorded.", 422);
  }
  j.override = blocking.length ? { by: p.id, justification: why.slice(0, 1000), at: new Date().toISOString() } : undefined;
  // A person submitted it: an exception stays one (for the STP numbers), anything else is manual.
  j.route = j.route === "exception" ? "exception" : "manual";
  j.status = "pending-finalization";
  j.submittedBy = p.id;
  j.submittedAt = new Date().toISOString();
  j.sentBackNote = undefined;
  touch(j);
  logAudit({ category: "agent", action: j.override ? "docintel-submit-override" : "docintel-submit", actor: p.name, tenantId: j.tenantId,
    detail: `${j.documentId} submitted for finalization by ${p.name}` +
      (j.override ? ` overriding ${blocking.length} blocking issue(s): ${j.override.justification}` : "") });
  return j;
}

/** Re-run validation now (e.g. after master data changed). */
export async function revalidate(documentId: string, personaId: string): Promise<DocumentJob> {
  const j = job(documentId);
  const p = persona(personaId);
  authorizeDoc(p.id, j.tenantId, "reviewDocument", j.documentId);
  await validateJob(j);
  touch(j);
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
    ...finalizedTypeInfo(j),
  };
}

function finalizedTypeInfo(j: DocumentJob): Pick<FinalizedDocument, "documentType" | "validation"> {
  const t = jobType(j);
  if (!t || !j.validation) return {};
  const overrider = j.override ? store.personas.find((p) => p.id === j.override!.by) : undefined;
  return {
    documentType: { id: t.id, key: t.key, name: t.published!.spec.name, version: j.documentTypeVersion ?? t.published!.version },
    validation: {
      clean: j.validation.clean,
      route: j.route ?? "manual",
      issues: j.validation.issues.map((i) => ({ ruleId: i.ruleId, severity: i.severity, ...(i.field ? { field: i.field } : {}), message: i.message })),
      override: j.override
        ? { by: { personaId: j.override.by, name: overrider?.name ?? j.override.by }, justification: j.override.justification, at: j.override.at }
        : null,
    },
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

  logAudit({ category: "agent", action: "docintel-finalize", actor: p.name, tenantId: j.tenantId,
    detail: `${j.documentId} finalized as ${doc.finalizedDocumentId} v${doc.version} by ${p.name} ` +
      `(submitted by ${submitter.name}; content sha256 ${doc.contentSha256.slice(0, 12)}…)` });
  return commitFinalized(j, doc, p.name, publish);
}

/**
 * Finalize a clean document with no person: only for an approved type that
 * allows it, in a tenant that is not GxP-regulated. The type's approval is the
 * authority, and the record names the type version and its approver.
 */
async function autoFinalize(j: DocumentJob, t: DocumentType, publish = publishToDelta) {
  if (tenantPolicyAttributes(j.tenantId, store.tenants).gxp === "true" || !t.published?.spec.routing.autoFinalize || !j.validation?.clean) return;
  const approver = store.personas.find((p) => p.id === t.published!.approvedBy)?.name ?? t.published!.approvedBy;
  const submitter = persona(j.submittedBy!);
  j.route = "auto-finalized";
  const doc = buildFinalizedDocument(j, AUTO_FINALIZER, { id: submitter.id, name: submitter.name },
    `Auto-finalized: clean against '${t.published.spec.name}' v${t.published.version} (approved by ${approver}); tenant is not GxP-regulated.`);
  const errors = validateFinalizedDocument(doc);
  if (errors.length) {
    j.route = "exception";
    logAudit({ category: "agent", action: "docintel-auto-finalize-failed", actor: AUTO_FINALIZER.name, tenantId: j.tenantId,
      detail: `${j.documentId}: ${errors.join("; ")}` });
    return;
  }
  logAudit({ category: "agent", action: "docintel-auto-finalize", actor: AUTO_FINALIZER.name, tenantId: j.tenantId,
    detail: `${j.documentId} auto-finalized as ${doc.finalizedDocumentId} v${doc.version} under '${t.published.spec.name}' v${t.published.version}` });
  await commitFinalized(j, doc, AUTO_FINALIZER.name, publish);
}

async function commitFinalized(
  j: DocumentJob, doc: FinalizedDocument, actor: string, publish = publishToDelta
): Promise<FinalizedDocumentRecord> {
  const rec: FinalizedDocumentRecord = { doc, delta: { status: "pending" } };
  store.finalizedDocuments.unshift(rec);
  j.finalizedDocumentIds.push(doc.finalizedDocumentId);
  j.status = "finalized";
  touch(j);

  // Corpora holding an older version consume the new one (RAG Factory).
  try {
    onDocumentFinalized(rec);
  } catch (e) {
    logAudit({ category: "kb", action: "corpus-follow-version-failed", actor, tenantId: j.tenantId,
      detail: `Could not hand ${doc.finalizedDocumentId} to corpora: ${(e as Error).message}` });
  }

  // Publish to Delta; the record says what happened either way.
  try {
    const out = await publish(doc);
    rec.delta = { status: out.status, detail: out.detail, at: new Date().toISOString() };
  } catch (e) {
    rec.delta = { status: "failed", detail: (e as Error).message.slice(0, 400), at: new Date().toISOString() };
  }
  return rec;
}
