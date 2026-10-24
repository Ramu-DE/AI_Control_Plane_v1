// Exact answers from finalized fields and tables — no model reads the data.
//
// Lookup, filter, out-of-specification and aggregate questions ("assay result
// for batch VF-24-0917", "which tests did not meet specification", "how many
// invoices from ACME", "total due across invoices") are answered by EXECUTING
// a small, validated plan over the corpus's four-eyes-finalized values. The
// language model only PLANS (lib/ragfactory/planner.ts); it never produces a
// value. The result is exact by construction and every value carries its
// citation (finalized document, version, field or table row).
//
// Pure: no I/O, so it can be tested exhaustively.

import type { FinalizedDocument } from "../docintel/contract";
import { meetsSpec, normName, parseNumber, parseSpec } from "../docintel/validation";

export type Op = "eq" | "contains" | "gt" | "lt" | "gte" | "lte";

export interface DocFilter {
  /** A field name, or "docType" / "fileName" / "documentId". */
  field: string;
  op: Op;
  value: string;
}

export type Select =
  | { type: "fields"; fields: string[] }
  | { type: "table_rows"; columns?: string[]; where?: { column: string; op: Op; value: string }[];
      spec?: "out_of_spec" | "within_spec"; specColumn?: string; resultColumn?: string }
  | { type: "count" }
  | { type: "aggregate"; fn: "sum" | "min" | "max" | "avg"; field: string }
  | { type: "list_documents" };

export interface FieldPlan {
  documentFilters: DocFilter[];
  select: Select;
}

export interface FieldCitation {
  finalizedDocumentId: string;
  documentId: string;
  version: number;
  docType: string;
  fileName: string;
  ref: string; // "field batch_number" | "table 1 row 2"
}

export interface FieldAnswer {
  answer: string;
  /** Machine-readable result rows (for a table in the UI). */
  rows: Record<string, unknown>[];
  citations: FieldCitation[];
  matchedDocuments: number;
  /** True when nothing matched: the answer says so instead of guessing. */
  empty: boolean;
}

export class PlanError extends Error {}

const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));

function fieldValue(d: FinalizedDocument, name: string): unknown {
  const n = normName(name);
  if (n === "doctype") return d.classification.docType;
  if (n === "filename") return d.source.fileName;
  if (n === "documentid") return d.documentId;
  return d.content.fields.find((f) => normName(f.name) === n)?.value;
}

function compare(actual: unknown, op: Op, expected: string): boolean {
  if (actual === null || actual === undefined) return false;
  const a = String(actual);
  if (op === "eq") return normName(a) === normName(expected);
  if (op === "contains") return normName(a).includes(normName(expected));
  const x = parseNumber(a);
  const y = parseNumber(expected);
  if (x === null || y === null) return false;
  return op === "gt" ? x > y : op === "lt" ? x < y : op === "gte" ? x >= y : x <= y;
}

function cite(d: FinalizedDocument, ref: string): FieldCitation {
  return {
    finalizedDocumentId: d.finalizedDocumentId, documentId: d.documentId, version: d.version,
    docType: d.classification.docType, fileName: d.source.fileName, ref,
  };
}

/** Field names and table columns present in the corpus — what the planner may reference. */
export function corpusVocabulary(docs: FinalizedDocument[]) {
  const fields = new Map<string, Set<string>>();
  const columns = new Map<string, Set<string>>();
  for (const d of docs) {
    const t = d.classification.docType;
    for (const f of d.content.fields) (fields.get(t) ?? fields.set(t, new Set()).get(t)!).add(f.name);
    for (const tb of d.content.tables) for (const c of tb.columns) (columns.get(t) ?? columns.set(t, new Set()).get(t)!).add(String(c));
  }
  return {
    docTypes: [...new Set(docs.map((d) => d.classification.docType))],
    fields: Object.fromEntries([...fields].map(([k, v]) => [k, [...v]])),
    tableColumns: Object.fromEntries([...columns].map(([k, v]) => [k, [...v]])),
  };
}

/** Reject plans that reference fields or columns the corpus does not have. */
export function checkPlan(plan: FieldPlan, docs: FinalizedDocument[]): string[] {
  const vocab = corpusVocabulary(docs);
  const allFields = new Set(Object.values(vocab.fields).flat().map(normName));
  ["doctype", "filename", "documentid"].forEach((x) => allFields.add(x));
  const allColumns = Object.values(vocab.tableColumns).flat().map(normName);
  const hasColumn = (c: string) => allColumns.some((x) => x.includes(normName(c)));
  const errs: string[] = [];
  for (const f of plan.documentFilters ?? []) {
    if (!allFields.has(normName(f.field))) errs.push(`unknown field '${f.field}'`);
    if (!["eq", "contains", "gt", "lt", "gte", "lte"].includes(f.op)) errs.push(`unknown operator '${f.op}'`);
  }
  const s = plan.select;
  if (!s || !["fields", "table_rows", "count", "aggregate", "list_documents"].includes(s.type)) errs.push("unknown select type");
  if (s?.type === "fields") {
    if (!s.fields?.length) errs.push("select.fields is empty");
    for (const f of s.fields ?? []) if (!allFields.has(normName(f))) errs.push(`unknown field '${f}'`);
  }
  if (s?.type === "aggregate" && !allFields.has(normName(s.field))) errs.push(`unknown field '${s.field}'`);
  if (s?.type === "table_rows") {
    for (const c of s.columns ?? []) if (!hasColumn(c)) errs.push(`unknown table column '${c}'`);
    for (const w of s.where ?? []) if (!hasColumn(w.column)) errs.push(`unknown table column '${w.column}'`);
    if (s.spec && (!hasColumn(s.specColumn ?? "spec") || !hasColumn(s.resultColumn ?? "result"))) {
      errs.push("specification check needs specification and result columns");
    }
  }
  return errs;
}

/** Execute a checked plan. Deterministic. */
export function executePlan(plan: FieldPlan, docs: FinalizedDocument[]): FieldAnswer {
  const errs = checkPlan(plan, docs);
  if (errs.length) throw new PlanError(errs.join("; "));
  const matched = docs.filter((d) => (plan.documentFilters ?? []).every((f) => compare(fieldValue(d, f.field), f.op, f.value)));
  const where = (plan.documentFilters ?? []).map((f) => `${f.field} ${f.op} "${f.value}"`).join(" and ");
  const scope = where ? ` matching ${where}` : "";
  const none = (what: string): FieldAnswer => ({
    answer: `No finalized document in this corpus${scope} ${what}.`, rows: [], citations: [], matchedDocuments: matched.length, empty: true,
  });
  if (!matched.length) return none("was found");
  const label = (d: FinalizedDocument) => `${d.classification.docType} ${d.source.fileName} (${d.finalizedDocumentId} v${d.version})`;
  const s = plan.select;

  if (s.type === "count") {
    return {
      answer: `${matched.length} finalized document(s)${scope}.`,
      rows: matched.map((d) => ({ document: label(d) })), citations: matched.map((d) => cite(d, "document")),
      matchedDocuments: matched.length, empty: false,
    };
  }
  if (s.type === "list_documents") {
    return {
      answer: `${matched.length} finalized document(s)${scope}: ${matched.map(label).join("; ")}.`,
      rows: matched.map((d) => ({ document: label(d), docType: d.classification.docType, finalizedAt: d.provenance.finalizedAt })),
      citations: matched.map((d) => cite(d, "document")), matchedDocuments: matched.length, empty: false,
    };
  }
  if (s.type === "fields") {
    const rows: Record<string, unknown>[] = [];
    const citations: FieldCitation[] = [];
    const lines: string[] = [];
    for (const d of matched) {
      const vals = s.fields.map((f) => [f, fieldValue(d, f)] as const);
      if (vals.every(([, v]) => v === undefined)) continue;
      rows.push({ document: label(d), ...Object.fromEntries(vals.map(([f, v]) => [f, v ?? null])) });
      vals.filter(([, v]) => v !== undefined).forEach(([f]) => citations.push(cite(d, `field ${f}`)));
      lines.push(`${label(d)}: ${vals.map(([f, v]) => `${f} = ${show(v)}`).join(", ")}`);
    }
    if (!rows.length) return none(`has ${s.fields.join(", ")}`);
    return { answer: lines.join("\n"), rows, citations, matchedDocuments: matched.length, empty: false };
  }
  if (s.type === "aggregate") {
    const vals = matched.map((d) => ({ d, n: parseNumber(fieldValue(d, s.field)) })).filter((x) => x.n !== null) as { d: FinalizedDocument; n: number }[];
    if (!vals.length) return none(`has a numeric ${s.field}`);
    const ns = vals.map((x) => x.n);
    const result = s.fn === "sum" ? ns.reduce((a, b) => a + b, 0) : s.fn === "min" ? Math.min(...ns)
      : s.fn === "max" ? Math.max(...ns) : ns.reduce((a, b) => a + b, 0) / ns.length;
    const rounded = Math.round(result * 1e6) / 1e6;
    const skipped = matched.length - vals.length;
    return {
      answer: `${s.fn} of ${s.field} over ${vals.length} finalized document(s)${scope} = ${rounded}` +
        (skipped ? ` (${skipped} matching document(s) have no numeric ${s.field} and were not counted)` : "") + ".",
      rows: vals.map((x) => ({ document: label(x.d), [s.field]: fieldValue(x.d, s.field) })),
      citations: vals.map((x) => cite(x.d, `field ${s.field}`)), matchedDocuments: matched.length, empty: false,
    };
  }
  // table_rows
  const rows: Record<string, unknown>[] = [];
  const citations: FieldCitation[] = [];
  const lines: string[] = [];
  let evaluated = 0;
  let unevaluable = 0;
  for (const d of matched) {
    d.content.tables.forEach((t, ti) => {
      const col = (name: string) => t.columns.findIndex((c) => normName(String(c)).includes(normName(name)));
      const specCol = col(s.specColumn ?? "spec");
      const resCol = col(s.resultColumn ?? "result");
      t.rows.forEach((r, ri) => {
        if (!(s.where ?? []).every((w) => { const c = col(w.column); return c >= 0 && compare(r[c], w.op, w.value); })) return;
        if (s.spec) {
          if (specCol < 0 || resCol < 0) return;
          const sp = parseSpec(r[specCol]);
          const ok = sp ? meetsSpec(sp, r[resCol]) : null;
          if (ok === null) { unevaluable += 1; return; }
          evaluated += 1;
          if (s.spec === "out_of_spec" ? ok : !ok) return;
        }
        const picked = (s.columns?.length ? s.columns.map((c) => [c, col(c)] as const) : t.columns.map((c, i) => [String(c), i] as const))
          .filter(([, i]) => i >= 0);
        const obj = Object.fromEntries(picked.map(([c, i]) => [c, r[i] ?? null]));
        rows.push({ document: label(d), ...obj });
        citations.push(cite(d, `table ${ti + 1} row ${ri + 1}`));
        lines.push(`${label(d)}, table ${ti + 1} row ${ri + 1}: ${picked.map(([c, i]) => `${c} = ${show(r[i])}`).join(", ")}`);
      });
    });
  }
  if (!rows.length) {
    if (s.spec === "out_of_spec" && evaluated > 0) {
      return { ...none("has a result outside its specification"),
        answer: `No result outside its specification in ${matched.length} finalized document(s)${scope}: all ${evaluated} evaluated test(s) are within specification` +
          (unevaluable ? `; ${unevaluable} row(s) could not be evaluated automatically and need a person` : "") + ".",
        citations: matched.map((d) => cite(d, "all specification rows")) };
    }
    if (s.spec && evaluated === 0) return none("has a specification row that can be evaluated automatically");
    return none("has a matching table row");
  }
  if (s.spec && unevaluable) lines.push(`(${unevaluable} further row(s) could not be evaluated automatically and need a person.)`);
  return { answer: lines.join("\n"), rows, citations, matchedDocuments: matched.length, empty: false };
}

const CURRENCIES: { code: string; asked: RegExp; present: RegExp }[] = [
  { code: "EUR", asked: /\b(eur|euros?)\b|€/i, present: /\bEUR\b|€|euro/i },
  { code: "USD", asked: /\b(usd|us dollars?|dollars?)\b|\$/i, present: /\bUSD\b|\$|dollar/i },
  { code: "GBP", asked: /\b(gbp|pounds? sterling|sterling)\b|£/i, present: /\bGBP\b|£|sterling/i },
  { code: "JPY", asked: /\b(jpy|yen)\b|¥/i, present: /\bJPY\b|¥|yen/i },
  { code: "CHF", asked: /\b(chf|swiss francs?)\b/i, present: /\bCHF\b|franc/i },
];

/**
 * A question that asks for a currency the exact result does not carry
 * ("price in euros" over USD values) must not be answered with the other
 * currency's number. Returns the reason to refuse, or null. Pure.
 */
export function requestedUnitMissing(question: string, answerText: string): string | null {
  for (const c of CURRENCIES) {
    if (c.asked.test(question) && !c.present.test(answerText)) {
      const found = CURRENCIES.filter((o) => o.code !== c.code && o.present.test(answerText)).map((o) => o.code);
      return `the finalized records do not state this in ${c.code}` +
        (found.length ? ` (the values are in ${found.join(", ")}; no conversion is made)` : " (no currency is stated with the value)");
    }
  }
  return null;
}
