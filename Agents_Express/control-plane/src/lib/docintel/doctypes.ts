// Document Types — what a kind of document must contain, how it is checked,
// and how it is routed. The governed equivalent of an IDP vendor's "skills".
//
// A type is owned by a tenant and available to that tenant and everything
// beneath it (the org publishes a CoA type once, every BU inherits it).
// It is edited as a DRAFT and used only as a PUBLISHED version: approving a
// draft (four eyes, approver+ in the owning tenant) publishes it as version
// N+1. Jobs record the version they were checked against, so a later edit
// never changes what an earlier finalized document was validated with.

import { evaluate } from "../evaluator";
import { logAudit, newId, store } from "../store";
import { DOCINTEL_TOOL } from "../regulatory";
import { inTenantSubtree, tenantChain } from "../tenancy";
import { databricksRequest, resolveWarehouseId } from "../tools/uc";
import type { FieldSpec, MasterDataLookup, ValidationRule } from "./validation";
export { REFERENCE_SUPPLIERS_TABLE, seedDocumentTypes } from "./doctypes-seed";

export interface DocTypeRouting {
  /** Field confidence below this needs a person to confirm it. 0..1 */
  minConfidence: number;
  /** A clean document skips analyst editing and goes straight to finalization. */
  straightThrough: boolean;
  /**
   * A clean document is finalized without a person. Honoured ONLY in tenants
   * that are not GxP-regulated; a GxP tenant always has a human finalizer.
   */
  autoFinalize: boolean;
  /** Precision the calibrated auto-accept threshold must prove (default 0.995). */
  precisionTarget?: number;
  /** Share of would-be straight-through documents sent to a person anyway, for unbiased monitoring (default 0.05). */
  auditRate?: number;
}

export interface DocTypeSpec {
  name: string;
  description: string;
  /** Classification labels that identify this type (case-insensitive substring). */
  classifierHints: string[];
  fields: FieldSpec[];
  rules: ValidationRule[];
  methods: string[];
  capabilities: string[];
  routing: DocTypeRouting;
  /** Suggested RAG Factory pattern for corpora of this type. */
  ragPattern?: string;
}

export interface PublishedDocType {
  version: number;
  spec: DocTypeSpec;
  submittedBy: string;
  approvedBy: string;
  approvedAt: string;
}

export interface DocumentType {
  id: string; // dt-xxxx
  key: string; // slug, unique per owning tenant
  tenantId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  draft: DocTypeSpec;
  /** State of the draft. "Published" = the draft equals the latest published version. */
  status: "Draft" | "Pending approval" | "Published" | "Rejected";
  submittedBy?: string;
  submittedAt?: string;
  decisionNote?: string;
  deprecated?: boolean;
  published?: PublishedDocType;
  history: { version: number; approvedBy: string; approvedAt: string }[];
}

export class DocTypeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const KEY = /^[a-z0-9][a-z0-9-]{1,62}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const RULE_KINDS = ["date_order", "range", "sum_equals", "spec_within", "master_data"];
const FIELD_TYPES = ["text", "number", "money", "percent", "date", "enum"];

// --------------------------------------------------------------------------- //
// Spec validation (the author's input)
// --------------------------------------------------------------------------- //

export function checkSpec(spec: DocTypeSpec): string[] {
  const errs: string[] = [];
  if (!spec.name?.trim()) errs.push("name is required");
  const names = new Set<string>();
  for (const [i, f] of (spec.fields ?? []).entries()) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(f.name ?? "")) errs.push(`field ${i + 1}: name must be snake_case`);
    if (names.has(f.name)) errs.push(`field '${f.name}' is defined twice`);
    names.add(f.name);
    if (!FIELD_TYPES.includes(f.type)) errs.push(`field '${f.name}': unknown type '${f.type}'`);
    if (f.pattern) { try { new RegExp(f.pattern); } catch { errs.push(`field '${f.name}': pattern is not a valid regular expression`); } }
  }
  if (!spec.fields?.length) errs.push("at least one field is required");
  const ids = new Set<string>();
  for (const r of spec.rules ?? []) {
    if (!r.id || ids.has(r.id)) errs.push(`rule ids must be present and unique ('${r.id}')`);
    ids.add(r.id);
    if (!RULE_KINDS.includes(r.kind)) { errs.push(`rule '${r.id}': unknown kind '${(r as { kind: string }).kind}'`); continue; }
    if (!["block", "warn"].includes(r.severity)) errs.push(`rule '${r.id}': severity must be block or warn`);
    const needField = (n: string | undefined, what: string) => { if (!n || !names.has(n)) errs.push(`rule '${r.id}': ${what} '${n}' is not a field of this type`); };
    if (r.kind === "date_order") { needField(r.earlier, "earlier"); needField(r.later, "later"); }
    if (r.kind === "range") needField(r.field, "field");
    if (r.kind === "sum_equals") { needField(r.total, "total"); if (!r.column) errs.push(`rule '${r.id}': column is required`); }
    if (r.kind === "spec_within" && (!r.specColumn || !r.resultColumn)) errs.push(`rule '${r.id}': specColumn and resultColumn are required`);
    if (r.kind === "master_data") {
      needField(r.field, "field");
      if (!TABLE.test(r.table ?? "")) errs.push(`rule '${r.id}': table must be catalog.schema.table`);
      if (!IDENT.test(r.column ?? "")) errs.push(`rule '${r.id}': column must be an identifier`);
      if (r.statusColumn && !IDENT.test(r.statusColumn)) errs.push(`rule '${r.id}': statusColumn must be an identifier`);
    }
  }
  const rt = spec.routing;
  if (!rt || typeof rt.minConfidence !== "number" || rt.minConfidence < 0 || rt.minConfidence > 1) errs.push("routing.minConfidence must be within 0..1");
  if (rt?.precisionTarget !== undefined && !(rt.precisionTarget >= 0.9 && rt.precisionTarget < 1)) errs.push("routing.precisionTarget must be within 0.9..0.9999");
  if (rt?.auditRate !== undefined && !(rt.auditRate >= 0 && rt.auditRate <= 1)) errs.push("routing.auditRate must be within 0..1");
  if (!spec.methods?.length) errs.push("at least one method is required");
  if (!spec.capabilities?.length) errs.push("at least one capability is required");
  return errs;
}

// --------------------------------------------------------------------------- //
// Access and governance
// --------------------------------------------------------------------------- //

function persona(personaId: string) {
  const p = store.personas.find((x) => x.id === personaId && !x.disabled);
  if (!p) throw new DocTypeError("PERSONA_REQUIRED", "a valid personaId is required");
  return p;
}

function authorize(personaId: string, tenantId: string, action: string, resource: string) {
  const d = evaluate({ personaId, agentId: "docintel", action, tool: DOCINTEL_TOOL, resource, tenantId });
  if (!d.allowed) throw new DocTypeError("NOT_PERMITTED", d.decisions[d.decisions.length - 1]?.reason ?? "denied", 403);
}

function find(id: string): DocumentType {
  const t = store.documentTypes.find((x) => x.id === id);
  if (!t) throw new DocTypeError("NOT_FOUND", `document type '${id}' not found`, 404);
  return t;
}

/** Published, non-deprecated types usable in `tenantId` (own + ancestors'), nearest owner first. */
export function availableTypes(tenantId: string): DocumentType[] {
  const chain = tenantChain(tenantId, store.tenants);
  return store.documentTypes
    .filter((t) => t.published && !t.deprecated && chain.includes(t.tenantId))
    .sort((a, b) => chain.indexOf(a.tenantId) - chain.indexOf(b.tenantId) || a.draft.name.localeCompare(b.draft.name));
}

export function usableType(id: string, tenantId: string): DocumentType {
  const t = find(id);
  if (!availableTypes(tenantId).some((x) => x.id === id)) {
    throw new DocTypeError("TYPE_UNAVAILABLE", `document type '${t.draft.name}' is not published for tenant '${tenantId}'`);
  }
  return t;
}

/** Types a persona may see: everything owned in, above, or below a tenant they belong to (viewDocument). */
export function listTypes(personaId: string): DocumentType[] {
  persona(personaId);
  return store.documentTypes.filter((t) =>
    evaluate({ personaId, agentId: "docintel", action: "viewDocument", tool: DOCINTEL_TOOL, resource: t.id, tenantId: t.tenantId }).allowed ||
    store.tenants.some((ten) => inTenantSubtree(ten.id, t.tenantId, store.tenants) &&
      evaluate({ personaId, agentId: "docintel", action: "viewDocument", tool: DOCINTEL_TOOL, resource: t.id, tenantId: ten.id }).allowed));
}

export function createType(input: { tenantId: string; personaId: string; key: string; spec: DocTypeSpec }): DocumentType {
  const p = persona(input.personaId);
  authorize(p.id, input.tenantId, "manageDocumentType", "new-document-type");
  if (!KEY.test(input.key)) throw new DocTypeError("BAD_KEY", "key must be a lowercase slug, e.g. 'deviation-report'");
  if (store.documentTypes.some((t) => t.tenantId === input.tenantId && t.key === input.key)) {
    throw new DocTypeError("DUPLICATE", `'${input.key}' already exists in ${input.tenantId}`, 409);
  }
  const errs = checkSpec(input.spec);
  if (errs.length) throw new DocTypeError("INVALID_SPEC", errs.join("; "));
  const now = new Date().toISOString();
  const t: DocumentType = {
    id: newId("dt"), key: input.key, tenantId: input.tenantId, createdBy: p.id, createdAt: now, updatedAt: now,
    draft: input.spec, status: "Draft", history: [],
  };
  store.documentTypes.unshift(t);
  logAudit({ category: "agent", action: "doctype-create", actor: p.name, tenantId: t.tenantId,
    detail: `Document type '${t.draft.name}' (${t.key}) drafted` });
  return t;
}

export function updateType(id: string, personaId: string, spec: DocTypeSpec): DocumentType {
  const t = find(id);
  const p = persona(personaId);
  authorize(p.id, t.tenantId, "manageDocumentType", t.id);
  if (t.status === "Pending approval") throw new DocTypeError("LOCKED", "a pending draft cannot be edited; reject it first", 409);
  const errs = checkSpec(spec);
  if (errs.length) throw new DocTypeError("INVALID_SPEC", errs.join("; "));
  t.draft = spec;
  t.status = "Draft";
  t.updatedAt = new Date().toISOString();
  logAudit({ category: "agent", action: "doctype-update", actor: p.name, tenantId: t.tenantId,
    detail: `Document type '${spec.name}' draft edited (published v${t.published?.version ?? 0} still in use)` });
  return t;
}

/** Add learned synonyms to a type's DRAFT (they apply once the draft is approved). */
export function addSynonyms(id: string, personaId: string, add: { field: string; name: string }[]): DocumentType {
  const t = find(id);
  const spec: DocTypeSpec = JSON.parse(JSON.stringify(t.draft));
  for (const a of add) {
    const f = spec.fields.find((x) => x.name === a.field);
    if (!f) throw new DocTypeError("BAD_FIELD", `'${a.field}' is not a field of ${spec.name}`);
    const name = a.name.trim().slice(0, 60);
    if (name && !(f.synonyms ?? []).some((y) => y.toLowerCase() === name.toLowerCase())) f.synonyms = [...(f.synonyms ?? []), name];
  }
  return updateType(id, personaId, spec);
}

export function submitType(id: string, personaId: string): DocumentType {
  const t = find(id);
  const p = persona(personaId);
  authorize(p.id, t.tenantId, "manageDocumentType", t.id);
  if (!["Draft", "Rejected"].includes(t.status)) throw new DocTypeError("NOT_SUBMITTABLE", `a ${t.status} type cannot be submitted`, 409);
  t.status = "Pending approval";
  t.submittedBy = p.id;
  t.submittedAt = new Date().toISOString();
  t.updatedAt = t.submittedAt;
  logAudit({ category: "agent", action: "doctype-submit", actor: p.name, tenantId: t.tenantId,
    detail: `Document type '${t.draft.name}' submitted for approval` });
  return t;
}

export function decideType(id: string, personaId: string, decision: "approve" | "reject", note?: string): DocumentType {
  const t = find(id);
  const p = persona(personaId);
  if (t.status !== "Pending approval" || !t.submittedBy) throw new DocTypeError("NOT_PENDING", "submit the draft first", 409);
  if (t.submittedBy === p.id) {
    throw new DocTypeError("SELF_REVIEW", `${p.name} submitted this type and cannot also decide it (four-eyes rule)`, 403);
  }
  authorize(p.id, t.tenantId, "approveDocumentType", t.id);
  const now = new Date().toISOString();
  t.decisionNote = note?.slice(0, 500) || undefined;
  t.updatedAt = now;
  if (decision === "reject") {
    t.status = "Rejected";
    logAudit({ category: "agent", action: "doctype-reject", actor: p.name, tenantId: t.tenantId,
      detail: `Document type '${t.draft.name}' draft rejected${note ? `: ${note}` : ""}` });
    return t;
  }
  const version = (t.published?.version ?? 0) + 1;
  // A deep copy, not structuredClone: store objects are change-tracking Proxies, which structuredClone rejects.
  const spec = JSON.parse(JSON.stringify(t.draft)) as DocTypeSpec;
  t.published = { version, spec, submittedBy: t.submittedBy, approvedBy: p.id, approvedAt: now };
  t.history.push({ version, approvedBy: p.id, approvedAt: now });
  t.status = "Published";
  logAudit({ category: "agent", action: "doctype-publish", actor: p.name, tenantId: t.tenantId,
    detail: `Document type '${t.draft.name}' v${version} published (submitted by ${persona(t.submittedBy).name})` });
  return t;
}

export function deprecateType(id: string, personaId: string, deprecated: boolean): DocumentType {
  const t = find(id);
  const p = persona(personaId);
  authorize(p.id, t.tenantId, "approveDocumentType", t.id);
  t.deprecated = deprecated;
  t.updatedAt = new Date().toISOString();
  logAudit({ category: "agent", action: deprecated ? "doctype-deprecate" : "doctype-restore", actor: p.name, tenantId: t.tenantId,
    detail: `Document type '${t.draft.name}' ${deprecated ? "deprecated" : "restored"}` });
  return t;
}

// --------------------------------------------------------------------------- //
// Classification
// --------------------------------------------------------------------------- //

/** Pick the published type whose name / key / hints best match a classification label. Pure over `types`. */
export function classifyToType(label: string | null | undefined, types: DocumentType[]): DocumentType | undefined {
  if (!label) return undefined;
  const l = label.toLowerCase();
  let best: { t: DocumentType; score: number } | undefined;
  for (const t of types) {
    const spec = t.published!.spec;
    const hints = [spec.name, t.key.replace(/-/g, " "), ...spec.classifierHints].map((h) => h.toLowerCase()).filter(Boolean);
    for (const h of hints) {
      const score = l === h ? 100 : l.includes(h) ? h.length : h.includes(l) && l.length >= 3 ? l.length / 2 : 0;
      if (score > (best?.score ?? 0)) best = { t, score };
    }
  }
  return best?.t;
}

// --------------------------------------------------------------------------- //
// Master data (Unity Catalog, read-only, parameterised)
// --------------------------------------------------------------------------- //

/** Governed read: SELECT 1 … WHERE lower(col) = lower(:v) [AND status = :s] LIMIT 1. */
export const ucMasterDataLookup: MasterDataLookup = async (q) => {
  if (!TABLE.test(q.table) || !IDENT.test(q.column) || (q.statusColumn && !IDENT.test(q.statusColumn))) {
    throw new Error("invalid master-data identifiers");
  }
  if (!process.env.DATABRICKS_HOST || !process.env.DATABRICKS_TOKEN) throw new Error("Databricks is not configured");
  const where = [`lower(trim(${q.column})) = lower(:v)`];
  const parameters: { name: string; value: string }[] = [{ name: "v", value: q.value }];
  if (q.statusColumn && q.statusValue) {
    where.push(`lower(${q.statusColumn}) = lower(:s)`);
    parameters.push({ name: "s", value: q.statusValue });
  }
  const res = await databricksRequest("/api/2.0/sql/statements", {
    method: "POST",
    body: {
      warehouse_id: await resolveWarehouseId(),
      statement: `SELECT 1 FROM ${q.table} WHERE ${where.join(" AND ")} LIMIT 1`,
      parameters, wait_timeout: "30s",
    },
  });
  const status = (res.status as Record<string, unknown>) ?? {};
  if (status.state !== "SUCCEEDED") {
    const msg = ((status.error as Record<string, unknown>) ?? {}).message;
    throw new Error(`lookup ${String(status.state)}${msg ? `: ${String(msg).slice(0, 160)}` : ""}`);
  }
  const rows = ((res.result as Record<string, unknown>)?.data_array as unknown[]) ?? [];
  return rows.length > 0;
};
