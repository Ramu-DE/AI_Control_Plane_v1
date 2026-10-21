// Pure domain logic shared by both store back-ends and the API routes.
// No I/O, no AWS, deterministic — safe to unit test offline.

import type {
  MappingProposal,
  MappingEvidence,
  MappingIssue,
  MappingJoin,
  ProposalKind,
  ProfileSummary,
} from "./entities";
import type { RecordStatus } from "../types";

// --------------------------------------------------------------------------- //
// GraphSource state machine (mirrors the existing /api/graph PATCH transitions)
// --------------------------------------------------------------------------- //

export const GRAPH_TRANSITIONS: Record<RecordStatus, RecordStatus[]> = {
  Draft: ["Pending approval"],
  "Pending approval": ["Approved", "Rejected"],
  Approved: ["Deprecated"],
  Rejected: ["Draft"],
  Deprecated: [],
};

export function canTransition(from: RecordStatus, to: RecordStatus): boolean {
  return GRAPH_TRANSITIONS[from]?.includes(to) ?? false;
}

// --------------------------------------------------------------------------- //
// Publish gate — every included proposal must be approved AND valid.
// --------------------------------------------------------------------------- //

export interface PublishEligibility {
  eligible: boolean;
  reasons: string[];
  approvedProposalIds: string[];
}

/**
 * A proposal is "valid" when it carries no publish-blocking issue. Both the
 * control-plane severity ("blocking") and the graph-utility severity ("error")
 * are treated as blocking so build-plane proposals gate identically.
 */
export function isProposalValid(p: MappingProposal): boolean {
  return !p.issues.some((i) => i.severity === "blocking" || i.severity === "error");
}

/**
 * Determine whether a build run's proposals can be published. The gate treats
 * each proposal by its DECISION state:
 *   - "proposed" (undecided) BLOCKS — every proposal must have a completed
 *     decision before anything publishes.
 *   - "rejected" is a COMPLETED decision: it never blocks and is EXCLUDED from
 *     the published output.
 *   - "approved" is included, but only if VALID (no blocking issue); an
 *     approved-but-invalid proposal BLOCKS.
 * Publication additionally requires AT LEAST ONE approved + valid proposal
 * (publishing an empty set is not meaningful).
 */
export function evaluatePublishGate(
  proposals: MappingProposal[]
): PublishEligibility {
  const reasons: string[] = [];
  if (proposals.length === 0) {
    return { eligible: false, reasons: ["no proposals to publish"], approvedProposalIds: [] };
  }

  // Undecided proposals block — a completed decision (approved|rejected) is
  // required on every proposal.
  const undecided = proposals.filter((p) => p.status === "proposed");
  if (undecided.length > 0) {
    reasons.push(
      `${undecided.length} proposal(s) undecided (must be approved or rejected): ${undecided
        .map((p) => p.proposalId)
        .join(", ")}`
    );
  }

  // Approved-but-invalid proposals block.
  const approvedInvalid = proposals.filter((p) => p.status === "approved" && !isProposalValid(p));
  if (approvedInvalid.length > 0) {
    reasons.push(
      `${approvedInvalid.length} approved proposal(s) have blocking issues: ${approvedInvalid
        .map((p) => p.proposalId)
        .join(", ")}`
    );
  }

  // Must publish at least one approved + valid proposal.
  const approvedValid = proposals.filter((p) => p.status === "approved" && isProposalValid(p));
  if (approvedValid.length === 0) {
    reasons.push("no approved, valid proposal to publish");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    // Rejected proposals are a completed decision and are EXCLUDED from output.
    approvedProposalIds: approvedValid.map((p) => p.proposalId),
  };
}

// --------------------------------------------------------------------------- //
// Mandatory reviewer/note validation
// --------------------------------------------------------------------------- //

export function validateDecisionInput(input: {
  reviewer?: unknown;
  note?: unknown;
}): string | null {
  if (typeof input.reviewer !== "string" || !input.reviewer.trim()) {
    return "reviewer is required";
  }
  if (typeof input.note !== "string" || !input.note.trim()) {
    return "note is required";
  }
  return null;
}

// --------------------------------------------------------------------------- //
// SSRF defenses for outbound serving/ontology URLs
// --------------------------------------------------------------------------- //

/** RFC1918 / loopback / link-local / metadata host patterns we never allow. */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./, // link-local incl. 169.254.169.254 (cloud metadata)
  /^::1$/,
  /^fd[0-9a-f]{2}:/i, // unique-local IPv6
  /^fe80:/i, // link-local IPv6
  /\.local$/i,
  /\.internal$/i,
];

export interface UrlPolicyResult {
  ok: boolean;
  reason?: string;
  /** True when the URL is a known placeholder (REPLACE-ME) — not configured. */
  placeholder?: boolean;
}

/**
 * Validate an outbound URL against SSRF rules:
 *  - must be HTTPS
 *  - host must not be a private/loopback/link-local/metadata address
 *  - if an allowlist is provided, host must be in it (suffix match)
 * Placeholder URLs (REPLACE-ME) are reported as `placeholder: true` with
 * ok:false so callers can treat them as "not configured" rather than invalid.
 */
export function validateOutboundUrl(
  value: string,
  allowedHosts?: string[]
): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "URL must use https" };
  }
  const host = url.hostname;
  if (host.toUpperCase().includes("REPLACE-ME")) {
    return { ok: false, reason: "placeholder host", placeholder: true };
  }
  for (const pat of PRIVATE_HOST_PATTERNS) {
    if (pat.test(host)) {
      return { ok: false, reason: `host '${host}' is not a permitted (private/metadata) address` };
    }
  }
  if (allowedHosts && allowedHosts.length > 0) {
    const normalized = host.toLowerCase();
    const allowed = allowedHosts.some((h) => {
      const a = h.trim().toLowerCase();
      return a && (normalized === a || normalized.endsWith(`.${a}`));
    });
    if (!allowed) {
      return { ok: false, reason: `host '${host}' is not in the allowlist` };
    }
  }
  return { ok: true };
}

/** True when a URL is HTTPS, configured (not placeholder), and SSRF-safe. */
export function isConfiguredServingUrl(
  value: string,
  allowedHosts?: string[]
): boolean {
  if (!value) return false;
  return validateOutboundUrl(value, allowedHosts).ok;
}

// --------------------------------------------------------------------------- //
// Cross-language proposal normalizer
// --------------------------------------------------------------------------- //
//
// graph-utility (Python) emits proposals as snake_case dicts (see
// MappingProposal.to_dict): kind, ontology_uri, ontology_label, ontology_type,
// target_table, target_column, logical_type, subject_columns, join (with
// left_table/left_columns/right_table/right_columns/cardinality/origin/name),
// evidence[], confidence, validation_issues[], source_fingerprint,
// proposal_fingerprint, mapping_version. The control plane persists camelCase.
//
// `normalizeProposal` is PURE (no I/O): it maps a build-plane dict onto the
// control-plane ProposalInput shape, PRESERVING kind, ontology type, logical
// type, subject columns, the composite relationship join, all fingerprints,
// evidence, and issues verbatim. It also accepts an already-camelCase object so
// control-plane callers can pass native inputs unchanged.

/** The normalized, control-plane-shaped proposal input. */
export interface NormalizedProposalInput {
  ontologyUri: string;
  ontologyLabel: string;
  entityType: "class" | "property";
  ucCatalog?: string;
  ucSchema?: string;
  ucTable?: string;
  ucColumn?: string | null;
  joinKey?: string;
  dataType?: string | null;
  confidence: number;
  evidence: MappingEvidence[];
  issues: MappingIssue[];
  proposalKind?: ProposalKind;
  ontologyType?: string;
  logicalType?: string;
  subjectColumns?: string[];
  join?: MappingJoin;
  mappingFingerprint?: string;
  sourceFingerprint?: string;
  proposalFingerprint?: string;
  profileSummary?: ProfileSummary;
}

type AnyRecord = Record<string, unknown>;

function pick<T>(obj: AnyRecord, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function normalizeJoin(raw: unknown): MappingJoin | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const j = raw as AnyRecord;
  const leftTable = asString(pick(j, "leftTable", "left_table"));
  const rightTable = asString(pick(j, "rightTable", "right_table"));
  const leftColumns = asStringArray(pick(j, "leftColumns", "left_columns")) ?? [];
  const rightColumns = asStringArray(pick(j, "rightColumns", "right_columns")) ?? [];
  if (!leftTable || !rightTable) return undefined;
  return {
    leftTable,
    leftColumns,
    rightTable,
    rightColumns,
    cardinality: asString(pick(j, "cardinality")) as MappingJoin["cardinality"],
    origin: asString(pick(j, "origin")) as MappingJoin["origin"],
    name: asString(pick(j, "name")),
  };
}

function normalizeEvidence(raw: unknown): MappingEvidence[] {
  if (!Array.isArray(raw)) return [];
  const out: MappingEvidence[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as AnyRecord;
    const kind = asString(r.kind);
    const detail = asString(r.detail);
    if (!kind || detail === undefined) continue;
    const weight = typeof r.weight === "number" ? r.weight : undefined;
    out.push({ kind: kind as MappingEvidence["kind"], detail, ...(weight !== undefined ? { weight } : {}) });
  }
  return out;
}

function normalizeIssues(raw: unknown): MappingIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: MappingIssue[] = [];
  for (const i of raw) {
    if (!i || typeof i !== "object") continue;
    const r = i as AnyRecord;
    const severity = asString(r.severity);
    const code = asString(r.code);
    const message = asString(r.message);
    if (!severity || !code || message === undefined) continue;
    out.push({ severity: severity as MappingIssue["severity"], code, message });
  }
  return out;
}

function normalizeProfileSummary(raw: unknown): ProfileSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as AnyRecord;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const summary: ProfileSummary = {
    rowEstimate: num(pick(r, "rowEstimate", "row_estimate")),
    nonNullCount: num(pick(r, "nonNullCount", "non_null_count")),
    nullCount: num(pick(r, "nullCount", "null_count")),
    distinctEstimate: num(pick(r, "distinctEstimate", "distinct_estimate")),
    maskedSamples: asStringArray(pick(r, "maskedSamples", "masked_samples")),
  };
  return summary;
}

/** Map a graph-utility `ProposalKind` (or ontology type) onto the legacy
 * control-plane `entityType` (class|property). */
function deriveEntityType(
  kind: ProposalKind | undefined,
  ontologyType: string | undefined,
  fallback: unknown
): "class" | "property" {
  if (kind === "class") return "class";
  if (kind === "direct" || kind === "relationship") return "property";
  if (ontologyType === "class") return "class";
  if (ontologyType && ontologyType.includes("property")) return "property";
  const fb = asString(fallback);
  return fb === "class" ? "class" : "property";
}

/**
 * Normalize a single build-plane (Python snake_case) OR control-plane
 * (camelCase) proposal object into a control-plane ProposalInput. Pure: no I/O.
 */
export function normalizeProposal(raw: AnyRecord): NormalizedProposalInput {
  const proposalKind = asString(pick(raw, "proposalKind", "kind")) as ProposalKind | undefined;
  const ontologyType = asString(pick(raw, "ontologyType", "ontology_type"));
  const ontologyUri = asString(pick(raw, "ontologyUri", "ontology_uri")) ?? "";
  const ontologyLabel = asString(pick(raw, "ontologyLabel", "ontology_label")) ?? "";
  const logicalType = asString(pick(raw, "logicalType", "logical_type"));
  const targetTable = asString(pick(raw, "ucTable", "target_table"));
  const targetColumn = pick<string | null>(raw, "ucColumn", "target_column");
  const subjectColumns = asStringArray(pick(raw, "subjectColumns", "subject_columns"));
  const join = normalizeJoin(pick(raw, "join"));
  const confidenceRaw = pick<number>(raw, "confidence");
  const confidence = typeof confidenceRaw === "number" ? confidenceRaw : 0;

  return {
    ontologyUri,
    ontologyLabel,
    entityType: deriveEntityType(proposalKind, ontologyType, pick(raw, "entityType", "entity_type")),
    ucCatalog: asString(pick(raw, "ucCatalog", "uc_catalog")),
    ucSchema: asString(pick(raw, "ucSchema", "uc_schema")),
    ucTable: targetTable,
    ucColumn: targetColumn === undefined ? null : targetColumn,
    joinKey: asString(pick(raw, "joinKey", "join_key")),
    dataType: asString(pick(raw, "dataType", "data_type")) ?? logicalType ?? null,
    confidence,
    evidence: normalizeEvidence(pick(raw, "evidence")),
    issues: normalizeIssues(pick(raw, "issues", "validation_issues")),
    proposalKind,
    ontologyType,
    logicalType,
    subjectColumns,
    join,
    mappingFingerprint: asString(pick(raw, "mappingFingerprint", "mapping_fingerprint", "set_fingerprint")),
    sourceFingerprint: asString(pick(raw, "sourceFingerprint", "source_fingerprint")),
    proposalFingerprint: asString(pick(raw, "proposalFingerprint", "proposal_fingerprint")),
    profileSummary: normalizeProfileSummary(pick(raw, "profileSummary", "profile_summary")),
  };
}
