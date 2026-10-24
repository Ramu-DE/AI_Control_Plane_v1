// FinalizedDocument v1 — the contract between the control plane and every
// consumer of reviewed IDP results (RAG Factory, graph-utility, Delta).
//
// JSON Schema: docs/contracts/finalized-document.v1.schema.json (repo root).
// This file is the TypeScript mirror plus a dependency-free validator, so the
// control plane refuses to emit anything that does not match the schema.
//
// Two properties make it trustworthy downstream:
//   - IMMUTABLE: a change is a new `version` with `supersedes`;
//   - VERIFIABLE: `contentSha256` is the sha256 of the canonical JSON of
//     `content`, so a consumer can prove it received exactly what was approved.

import { createHash } from "node:crypto";

export const FINALIZED_DOCUMENT_SCHEMA = "finalized-document/v1" as const;

export interface FdActor {
  personaId: string;
  name: string;
}

export interface FdField {
  name: string;
  value: unknown;
  confidence?: number | null;
  method?: string | null;
  capability?: string | null;
  edited: boolean;
  originalValue?: unknown;
}

export interface FdTable {
  name?: string | null;
  columns: string[];
  rows: unknown[][];
}

export interface FdContent {
  text: string;
  pages?: { pageNumber: number; text: string }[];
  fields: FdField[];
  tables: FdTable[];
  summary?: string | null;
}

export interface FinalizedDocument {
  schemaVersion: typeof FINALIZED_DOCUMENT_SCHEMA;
  finalizedDocumentId: string;
  version: number;
  supersedes?: string | null;
  tenantId: string;
  documentId: string;
  source: { fileName: string; mimeType: string; sizeBytes: number; sha256: string; pageCount?: number };
  classification: { docType: string; gxp: boolean; region: "US" | "EU" | "JP" | null };
  content: FdContent;
  pii: { redaction: "none-detected" | "redacted" | "retained"; detected: { type: string; count: number }[] };
  provenance: {
    engine?: string;
    idpDocumentId?: string | null;
    methodsRun: { method: string; status: "complete" | "error"; latencyMs?: number | null; cost?: number | null; confidence?: number | null }[];
    selectedMethod: string;
    capabilities: string[];
    submittedBy: FdActor;
    submittedAt: string;
    finalizedBy: FdActor;
    finalizedAt: string;
    reviewNote?: string | null;
  };
  contentSha256: string;
}

/** JSON with object keys sorted at every level — the input to the content hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function contentSha256(content: FdContent): string {
  return sha256Hex(canonicalJson(content));
}

const HEX64 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Validate against v1. Returns every problem found (empty = valid), because a
 * reviewer fixing one issue should not discover the next on the following try.
 */
export function validateFinalizedDocument(doc: unknown): string[] {
  const errs: string[] = [];
  const d = doc as Partial<FinalizedDocument>;
  const need = (cond: unknown, msg: string) => { if (!cond) errs.push(msg); };
  if (!d || typeof d !== "object") return ["document must be an object"];

  need(d.schemaVersion === FINALIZED_DOCUMENT_SCHEMA, `schemaVersion must be "${FINALIZED_DOCUMENT_SCHEMA}"`);
  need(typeof d.finalizedDocumentId === "string" && /^fd-[a-z0-9]+$/.test(d.finalizedDocumentId), "finalizedDocumentId must match ^fd-[a-z0-9]+$");
  need(Number.isInteger(d.version) && (d.version as number) >= 1, "version must be an integer >= 1");
  need(typeof d.tenantId === "string" && d.tenantId.length > 0, "tenantId is required");
  need(typeof d.documentId === "string" && /^doc-[a-z0-9]+$/.test(d.documentId), "documentId must match ^doc-[a-z0-9]+$");

  const s = d.source;
  need(s && typeof s.fileName === "string" && s.fileName.length > 0, "source.fileName is required");
  need(s && typeof s.mimeType === "string", "source.mimeType is required");
  need(s && Number.isInteger(s.sizeBytes) && s.sizeBytes >= 0, "source.sizeBytes must be a non-negative integer");
  need(s && typeof s.sha256 === "string" && HEX64.test(s.sha256), "source.sha256 must be 64 hex chars");

  const c = d.classification;
  need(c && typeof c.docType === "string" && c.docType.length > 0, "classification.docType is required");
  need(c && typeof c.gxp === "boolean", "classification.gxp must be boolean");
  need(c && (c.region === null || ["US", "EU", "JP"].includes(c.region as string)), "classification.region must be US, EU, JP or null");

  const ct = d.content;
  need(ct && typeof ct.text === "string", "content.text must be a string");
  need(ct && Array.isArray(ct.fields), "content.fields must be an array");
  need(ct && Array.isArray(ct.tables), "content.tables must be an array");
  for (const [i, f] of (ct?.fields ?? []).entries()) {
    need(typeof f?.name === "string" && f.name.length > 0, `content.fields[${i}].name is required`);
    need(typeof f?.edited === "boolean", `content.fields[${i}].edited must be boolean`);
    need(!(f?.edited) || "originalValue" in (f ?? {}), `content.fields[${i}] is edited but has no originalValue`);
    need(f?.confidence === undefined || f.confidence === null || (typeof f.confidence === "number" && f.confidence >= 0 && f.confidence <= 1),
      `content.fields[${i}].confidence must be within 0..1`);
  }
  for (const [i, t] of (ct?.tables ?? []).entries()) {
    need(Array.isArray(t?.columns) && Array.isArray(t?.rows), `content.tables[${i}] needs columns and rows arrays`);
  }

  const p = d.pii;
  need(p && ["none-detected", "redacted", "retained"].includes(p.redaction), "pii.redaction must be none-detected, redacted or retained");
  need(p && Array.isArray(p.detected), "pii.detected must be an array");

  const pv = d.provenance;
  need(pv && Array.isArray(pv.methodsRun) && pv.methodsRun.length > 0, "provenance.methodsRun needs at least one method");
  need(pv && typeof pv.selectedMethod === "string" && pv.selectedMethod.length > 0, "provenance.selectedMethod is required");
  need(pv && Array.isArray(pv.capabilities), "provenance.capabilities must be an array");
  need(pv && pv.submittedBy?.personaId && pv.finalizedBy?.personaId, "provenance.submittedBy and finalizedBy are required");
  need(pv && pv.submittedBy?.personaId !== pv.finalizedBy?.personaId, "four eyes: submittedBy and finalizedBy must be different people");
  need(pv && typeof pv.submittedAt === "string" && ISO.test(pv.submittedAt), "provenance.submittedAt must be an ISO-8601 UTC timestamp");
  need(pv && typeof pv.finalizedAt === "string" && ISO.test(pv.finalizedAt), "provenance.finalizedAt must be an ISO-8601 UTC timestamp");

  need(typeof d.contentSha256 === "string" && HEX64.test(d.contentSha256), "contentSha256 must be 64 hex chars");
  if (ct && typeof d.contentSha256 === "string" && HEX64.test(d.contentSha256)) {
    need(contentSha256(ct as FdContent) === d.contentSha256, "contentSha256 does not match content");
  }
  return errs;
}
