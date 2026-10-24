// Validation of a document review against its Document Type.
//
// Rules are DECLARATIVE (a kind plus parameters), never expressions, so a
// Document Type can be authored in the console and approved without anyone
// being able to smuggle code into the platform. Everything here is pure
// except master-data checks, whose lookup is injected (Unity Catalog in
// production, a stub in tests).
//
// Outcome:
//   issues  every problem found, each "block" or "warn"
//   clean   no issues at all and every required field at or above the
//           type's confidence threshold, the precondition for
//           straight-through processing

import type { FdField, FdTable } from "./contract";
import type { DocumentReview } from "./model";

export type FieldType = "text" | "number" | "money" | "percent" | "date" | "enum";

export interface FieldSpec {
  name: string;
  label?: string;
  type: FieldType;
  required: boolean;
  /** Regular expression the text value must match (anchored by the author). */
  pattern?: string;
  /** For enum fields. Compared case-insensitively. */
  allowed?: string[];
  /** Other names the extraction may use for this field. */
  synonyms?: string[];
  /** Always needs a person (dose, lot, specification limit, release decision): never auto-accepted. */
  critical?: boolean;
}

export type Severity = "block" | "warn";

export type ValidationRule =
  | { id: string; kind: "date_order"; earlier: string; later: string; severity: Severity }
  | { id: string; kind: "range"; field: string; min?: number; max?: number; severity: Severity }
  | { id: string; kind: "sum_equals"; column: string; total: string; tolerance?: number; severity: Severity }
  | { id: string; kind: "spec_within"; specColumn: string; resultColumn: string; labelColumn?: string; severity: Severity }
  | {
      id: string; kind: "master_data"; field: string; table: string; column: string;
      statusColumn?: string; statusValue?: string; severity: Severity;
    };

export interface ValidationIssue {
  ruleId: string;
  severity: Severity;
  field?: string;
  message: string;
}

export interface ValidationResult {
  at: string;
  issues: ValidationIssue[];
  clean: boolean;
  /** Required fields present / required fields in the schema. */
  requiredPresent: number;
  requiredTotal: number;
  lowConfidence: string[];
  /** Rules whose check could not run (e.g. master data unreachable). */
  skipped: string[];
  /** Calibrated P(correct) per field, when the type has an active calibrator (ML-4). */
  fieldScores?: Record<string, FieldScore>;
  /** Whether auto-accept is available for this document, and why not. */
  autoAccept?: { available: boolean; threshold: number | null; calibratorVersion?: number; reason: string };
}

export interface FieldScore {
  /** Calibrated probability the value is correct; 1 when a person entered or confirmed it. */
  p: number | null;
  source: "calibrated" | "reviewer" | "uncalibrated";
  agreement: number;
  methods: number;
  grounded: boolean;
  /** The consensus value differed from what the review shows (a person may have chosen another). */
  consensusValue?: unknown;
}

/** Lookup for master_data rules: does `value` exist (with the status) in the table? */
export type MasterDataLookup = (q: {
  table: string; column: string; value: string; statusColumn?: string; statusValue?: string;
}) => Promise<boolean>;

// --------------------------------------------------------------------------- //
// Parsing
// --------------------------------------------------------------------------- //

/** "1,234.50 USD" -> 1234.5; "99.4 %" -> 99.4; "(12)" -> -12. Null when no number. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[\s ]/g, "");
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  const m = /\d[\d.,]*\d|\d/.exec(s);
  if (!m) return null;
  let num = m[0];
  const lastDot = num.lastIndexOf(".");
  const lastComma = num.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the later one is the decimal separator ("1,234.50" / "1.234,50").
    num = lastComma > lastDot ? num.replace(/\./g, "").replace(",", ".") : num.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Only commas: "12,5" / "12,50" is a decimal; "1,234" / "1,234,567" are thousands.
    num = /^\d+,\d{1,2}$/.test(num) ? num.replace(",", ".") : num.replace(/,/g, "");
  } else if ((num.match(/\./g) ?? []).length > 1) {
    num = num.replace(/\./g, ""); // "1.234.567"
  }
  const n = Number(num);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** ISO, D.M.Y, D/M/Y, "12 Sep 2026", "Sep 12, 2026" -> UTC date (ms). Null when unparseable. */
export function parseDate(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]); // day first (EU / JP forms)
  m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return Date.UTC(+m[3], MONTHS[m[2].toLowerCase()] - 1, +m[1]);
  m = /^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return Date.UTC(+m[3], MONTHS[m[1].toLowerCase()] - 1, +m[2]);
  return null;
}

export type Spec =
  | { kind: "range"; min: number; max: number }
  | { kind: "min"; min: number; inclusive: boolean }
  | { kind: "max"; max: number; inclusive: boolean }
  | { kind: "qualitative" };

/** "95.0 - 105.0 %", "NLT 80 %", "NMT 0.5 %", "≤ 3.0", "> 2", "Complies with Ph. Eur." */
export function parseSpec(v: unknown): Spec | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const range = /(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  if (range) return { kind: "range", min: +range[1], max: +range[2] };
  const lo = /^(?:NLT|not less than|≥|>=|min\.?|minimum)\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  if (lo) return { kind: "min", min: +lo[1], inclusive: true };
  const gt = /^>\s*(-?\d+(?:\.\d+)?)/.exec(s);
  if (gt) return { kind: "min", min: +gt[1], inclusive: false };
  const hi = /^(?:NMT|not more than|≤|<=|max\.?|maximum)\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  if (hi) return { kind: "max", max: +hi[1], inclusive: true };
  const lt = /^<\s*(-?\d+(?:\.\d+)?)/.exec(s);
  if (lt) return { kind: "max", max: +lt[1], inclusive: false };
  if (/complies|conforms|meets|pass|absent|clear|white|identif/i.test(s)) return { kind: "qualitative" };
  return null;
}

/** Does `result` satisfy `spec`? Null when it cannot be decided. */
export function meetsSpec(spec: Spec, result: unknown): boolean | null {
  if (spec.kind === "qualitative") {
    if (typeof result !== "string") return null;
    if (/does not|not compl|fail|out of spec|oos|reject/i.test(result)) return false;
    return /complies|conforms|meets|pass|absent|clear|positive|identif|white/i.test(result) ? true : null;
  }
  const n = parseNumber(result);
  if (n === null) return null;
  if (spec.kind === "range") return n >= spec.min && n <= spec.max;
  if (spec.kind === "min") return spec.inclusive ? n >= spec.min : n > spec.min;
  return spec.inclusive ? n <= spec.max : n < spec.max;
}

// --------------------------------------------------------------------------- //
// Field mapping (extraction names -> schema names)
// --------------------------------------------------------------------------- //

export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function candidates(f: FieldSpec): Set<string> {
  return new Set([f.name, f.label ?? "", ...(f.synonyms ?? [])].filter(Boolean).map(normName));
}

/**
 * Rename extracted fields to the schema's names (via name / label / synonyms,
 * also matching the last segment of a dotted name like `total.amount`), and
 * order schema fields first. Unmatched extracted fields are kept after them.
 * Pure; never drops a value.
 */
export function mapFieldsToSchema(fields: FdField[], schema: FieldSpec[]): FdField[] {
  const used = new Set<number>();
  const out: FdField[] = [];
  for (const spec of schema) {
    const want = candidates(spec);
    let idx = fields.findIndex((f, i) => !used.has(i) && want.has(normName(f.name)));
    if (idx < 0) idx = fields.findIndex((f, i) => !used.has(i) && want.has(normName(f.name.split(".").pop() ?? "")));
    if (idx >= 0) {
      used.add(idx);
      out.push({ ...fields[idx], name: spec.name });
    }
  }
  fields.forEach((f, i) => { if (!used.has(i)) out.push(f); });
  return out;
}

// --------------------------------------------------------------------------- //
// Validation
// --------------------------------------------------------------------------- //

const present = (v: unknown) => !(v === null || v === undefined || (typeof v === "string" && v.trim() === ""));

function findTable(tables: FdTable[], ...columnHints: string[]): { table: FdTable; cols: number[] } | null {
  for (const table of tables) {
    const cols = columnHints.map((h) => table.columns.findIndex((c) => normName(String(c)).includes(normName(h))));
    if (cols.every((c) => c >= 0)) return { table, cols };
  }
  return null;
}

function fieldChecks(review: Pick<DocumentReview, "fields">, schema: FieldSpec[], minConfidence: number) {
  const issues: ValidationIssue[] = [];
  const lowConfidence: string[] = [];
  const byName = new Map(review.fields.map((f) => [f.name, f]));
  let requiredPresent = 0;
  for (const spec of schema) {
    const f = byName.get(spec.name);
    const label = spec.label ?? spec.name;
    if (!f || !present(f.value)) {
      if (spec.required) issues.push({ ruleId: `required:${spec.name}`, severity: "block", field: spec.name, message: `${label} is required but was not found` });
      continue;
    }
    if (spec.required) requiredPresent += 1;
    const v = f.value;
    if ((spec.type === "number" || spec.type === "money" || spec.type === "percent") && parseNumber(v) === null) {
      issues.push({ ruleId: `type:${spec.name}`, severity: "block", field: spec.name, message: `${label} should be a ${spec.type}, got "${String(v)}"` });
    }
    if (spec.type === "date" && parseDate(v) === null) {
      issues.push({ ruleId: `type:${spec.name}`, severity: "block", field: spec.name, message: `${label} is not a recognisable date: "${String(v)}"` });
    }
    if (spec.type === "enum" && spec.allowed?.length &&
        !spec.allowed.some((a) => a.toLowerCase() === String(v).trim().toLowerCase())) {
      issues.push({ ruleId: `enum:${spec.name}`, severity: "block", field: spec.name, message: `${label} must be one of ${spec.allowed.join(", ")}` });
    }
    if (spec.pattern) {
      let re: RegExp | null = null;
      try { re = new RegExp(spec.pattern); } catch { /* reported below */ }
      if (!re) issues.push({ ruleId: `pattern:${spec.name}`, severity: "warn", field: spec.name, message: `${label}: the type's pattern is not a valid regular expression` });
      else if (!re.test(String(v))) issues.push({ ruleId: `pattern:${spec.name}`, severity: "block", field: spec.name, message: `${label} "${String(v)}" does not match the expected format` });
    }
    // Machine confidence matters only for values a person has not confirmed.
    if (!f.edited && typeof f.confidence === "number" && f.confidence < minConfidence) {
      lowConfidence.push(spec.name);
      issues.push({ ruleId: `confidence:${spec.name}`, severity: "warn", field: spec.name,
        message: `${label} confidence ${f.confidence.toFixed(2)} is below ${minConfidence.toFixed(2)}; please confirm` });
    }
  }
  return { issues, lowConfidence, requiredPresent, requiredTotal: schema.filter((s) => s.required).length };
}

function ruleChecks(review: Pick<DocumentReview, "fields" | "tables">, rules: ValidationRule[]): {
  issues: ValidationIssue[]; skipped: string[]; masterData: Extract<ValidationRule, { kind: "master_data" }>[];
} {
  const issues: ValidationIssue[] = [];
  const skipped: string[] = [];
  const masterData: Extract<ValidationRule, { kind: "master_data" }>[] = [];
  const val = (name: string) => review.fields.find((f) => f.name === name)?.value;
  for (const r of rules) {
    switch (r.kind) {
      case "date_order": {
        const a = parseDate(val(r.earlier));
        const b = parseDate(val(r.later));
        if (a === null || b === null) { skipped.push(r.id); break; }
        if (!(a < b)) issues.push({ ruleId: r.id, severity: r.severity, field: r.later, message: `${r.later} (${String(val(r.later))}) must be after ${r.earlier} (${String(val(r.earlier))})` });
        break;
      }
      case "range": {
        const n = parseNumber(val(r.field));
        if (n === null) { skipped.push(r.id); break; }
        if ((r.min !== undefined && n < r.min) || (r.max !== undefined && n > r.max)) {
          issues.push({ ruleId: r.id, severity: r.severity, field: r.field, message: `${r.field} ${n} is outside ${r.min ?? "−∞"}…${r.max ?? "∞"}` });
        }
        break;
      }
      case "sum_equals": {
        const total = parseNumber(val(r.total));
        const t = findTable(review.tables, r.column);
        if (total === null || !t) { skipped.push(r.id); break; }
        // Rows that are themselves totals ("Total Due", "Subtotal") are not line items.
        const isTotalRow = (row: unknown[]) => row.some((c) => typeof c === "string" && /\b(sub)?total\b|\bbalance\b|\bamount due\b|\bgrand\b/i.test(c));
        const nums = t.table.rows.filter((row) => !isTotalRow(row)).map((row) => parseNumber(row[t.cols[0]])).filter((n): n is number => n !== null);
        if (!nums.length) { skipped.push(r.id); break; }
        const sum = Math.round(nums.reduce((s, n) => s + n, 0) * 100) / 100;
        if (Math.abs(sum - total) > (r.tolerance ?? 0.01)) {
          issues.push({ ruleId: r.id, severity: r.severity, field: r.total, message: `line items add up to ${sum.toFixed(2)} but ${r.total} is ${total.toFixed(2)}` });
        }
        break;
      }
      case "spec_within": {
        const t = findTable(review.tables, r.specColumn, r.resultColumn);
        if (!t) { skipped.push(r.id); break; }
        const labelCol = r.labelColumn ? t.table.columns.findIndex((c) => normName(String(c)).includes(normName(r.labelColumn!))) : 0;
        let checked = 0;
        for (const row of t.table.rows) {
          const spec = parseSpec(row[t.cols[0]]);
          const label = String(row[labelCol >= 0 ? labelCol : 0] ?? "row");
          if (!spec) continue;
          const ok = meetsSpec(spec, row[t.cols[1]]);
          if (ok === null) {
            issues.push({ ruleId: r.id, severity: "warn", message: `${label}: cannot compare result "${String(row[t.cols[1]])}" with specification "${String(row[t.cols[0]])}"` });
            continue;
          }
          checked += 1;
          if (!ok) issues.push({ ruleId: r.id, severity: r.severity, message: `${label}: result ${String(row[t.cols[1]])} is out of specification (${String(row[t.cols[0]])})` });
        }
        if (!checked) skipped.push(r.id);
        break;
      }
      case "master_data":
        masterData.push(r);
        break;
    }
  }
  return { issues, skipped, masterData };
}

/** Validate a review against a type. Master-data rules use `lookup`, or are skipped without one. */
export async function validateReview(
  review: Pick<DocumentReview, "fields" | "tables">,
  type: { fields: FieldSpec[]; rules: ValidationRule[]; minConfidence: number },
  lookup?: MasterDataLookup,
  now = new Date().toISOString()
): Promise<ValidationResult> {
  const f = fieldChecks(review, type.fields, type.minConfidence);
  const r = ruleChecks(review, type.rules);
  const issues = [...f.issues, ...r.issues];
  const skipped = [...r.skipped];
  for (const rule of r.masterData) {
    const value = review.fields.find((x) => x.name === rule.field)?.value;
    if (!present(value)) { skipped.push(rule.id); continue; }
    if (!lookup) { skipped.push(rule.id); continue; }
    try {
      const ok = await lookup({ table: rule.table, column: rule.column, value: String(value).trim(),
        statusColumn: rule.statusColumn, statusValue: rule.statusValue });
      if (!ok) {
        issues.push({ ruleId: rule.id, severity: rule.severity, field: rule.field,
          message: `"${String(value)}" is not ${rule.statusValue ? `${rule.statusValue} ` : ""}in ${rule.table}` });
      }
    } catch (e) {
      skipped.push(rule.id);
      issues.push({ ruleId: rule.id, severity: "warn", field: rule.field, message: `master-data check unavailable: ${(e as Error).message.slice(0, 160)}` });
    }
  }
  return {
    at: now,
    issues,
    clean: issues.length === 0 && f.lowConfidence.length === 0 && f.requiredPresent === f.requiredTotal,
    requiredPresent: f.requiredPresent,
    requiredTotal: f.requiredTotal,
    lowConfidence: f.lowConfidence,
    skipped,
  };
}

export function blockingIssues(v: ValidationResult | undefined): ValidationIssue[] {
  return (v?.issues ?? []).filter((i) => i.severity === "block");
}
