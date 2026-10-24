// Document Intelligence — the control plane's own record of a document's
// journey through IDP, review and finalization.
//
// The IDP engine is stateless from the platform's point of view: it extracts
// and returns. Everything that makes a result governable — which tenant owns
// it, who ran it, what the reviewer changed, who finalized it — lives here.
//
// `idpRef` (the engine's storage reference) is SERVER-SIDE ONLY. It is never
// returned to a browser and never accepted from one: the control plane is the
// only party that may tell IDP which file to read.

import type { FdField, FdRoute, FdTable } from "./contract";
import type { ValidationResult } from "./validation";

export type DocumentJobStatus =
  | "uploaded"
  | "processing"
  | "extracted"
  | "failed"
  | "in-review"
  | "pending-finalization"
  | "finalized";

export interface CapabilityOutput {
  data: unknown;
  confidence: number | null;
  format: string;
}

export interface MethodRun {
  method: string;
  status: "complete" | "error";
  latencyMs: number | null;
  cost: number | null;
  confidence: number | null;
  error?: string;
  /** capability id -> output */
  results: Record<string, CapabilityOutput>;
}

export interface DocumentReview {
  selectedMethod: string;
  docType: string;
  text: string;
  fields: FdField[];
  tables: FdTable[];
  summary: string | null;
  piiDetected: { type: string; count: number }[];
  piiRedacted: boolean;
  editedBy: string;
  editedAt: string;
}

export interface DocumentJob {
  documentId: string; // doc-xxxx
  tenantId: string;
  createdBy: string; // personaId
  createdAt: string;
  updatedAt: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount?: number;
  /** IDP engine identifiers. Server-side only — see the module header. */
  idpDocumentId?: string;
  idpRef?: string;
  status: DocumentJobStatus;
  capabilities: string[];
  methodRuns: MethodRun[];
  runError?: string;
  review?: DocumentReview;
  submittedBy?: string;
  submittedAt?: string;
  sentBackNote?: string;
  /** Document Type in force: chosen at upload, or detected from classification. */
  documentTypeId?: string;
  documentTypeVersion?: number;
  typeSource?: "chosen" | "detected";
  /** Latest validation against that type (re-run on every review save). */
  validation?: ValidationResult;
  /** How the document travelled: straight-through, auto-finalized, exception, or manual (no type). */
  route?: FdRoute;
  /** Picked by the random audit slice: would have gone straight through, sent to a person to keep accuracy estimates unbiased. */
  auditSample?: boolean;
  /** Submitted despite blocking issues: who and why. */
  override?: { by: string; justification: string; at: string };
  /** Finalized versions, oldest first. */
  finalizedDocumentIds: string[];
}

/** What a browser may see of a job: everything except the engine's storage reference. */
export function publicJob(job: DocumentJob): Omit<DocumentJob, "idpRef"> {
  const { idpRef: _hidden, ...rest } = job;
  void _hidden;
  return rest;
}
