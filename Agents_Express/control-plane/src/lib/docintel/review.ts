// Turn one IDP method's output into an editable review draft.
//
// IDP's capability output is untyped (`data: unknown`): the LLM chooses the
// shape — a string, an object, a list of {key, value}, CSV, Markdown or HTML.
// This module normalises the common shapes into the contract's text / fields /
// tables, and never throws on an unexpected one: what it cannot interpret is
// kept as text, so nothing extracted is silently dropped. Pure.

import type { FdField, FdTable } from "./contract";
import type { DocumentReview, MethodRun } from "./model";

const FIELD_CAPS = [
  "kv_extraction", "entity_extraction", "invoice_processing", "receipt_parsing", "contract_analysis",
  "insurance_claims", "medical_records", "check_processing",
];

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["text", "content", "fullText", "full_text", "markdown"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}

/** Flatten an object / list-of-pairs into named fields (dotted names for nesting). */
export function fieldsFrom(data: unknown, method: string, capability: string, confidence: number | null): FdField[] {
  const out: FdField[] = [];
  const push = (name: string, value: unknown, conf: number | null = confidence) => {
    if (!name) return;
    out.push({ name, value, confidence: conf, method, capability, edited: false });
  };
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      // [{key|name|field|label, value}] pairs
      const pairs = v.every((x) => x && typeof x === "object" && !Array.isArray(x) &&
        ("value" in (x as object)) && ["key", "name", "field", "label", "entity", "type"].some((k) => k in (x as object)));
      if (pairs) {
        for (const x of v as Record<string, unknown>[]) {
          const key = String(x.key ?? x.name ?? x.field ?? x.label ?? x.entity ?? x.type);
          const conf = typeof x.confidence === "number" ? Math.max(0, Math.min(1, x.confidence)) : confidence;
          push(prefix ? `${prefix}.${key}` : key, x.value, conf);
        }
        return;
      }
      if (v.every((x) => typeof x !== "object" || x === null)) {
        push(prefix || capability, v);
        return;
      }
      v.forEach((x, i) => walk(x, `${prefix || capability}[${i}]`, depth + 1));
      return;
    }
    if (typeof v === "object") {
      if (depth > 3) { push(prefix, v); return; }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "confidence" || k === "raw" || k === "rawOutput") continue;
        walk(val, prefix ? `${prefix}.${k}` : k, depth + 1);
      }
      return;
    }
    push(prefix || capability, v);
  };
  if (typeof data === "string") {
    // "Key: value" lines
    for (const line of data.split("\n")) {
      const m = /^\s*[-*]?\s*([^:]{1,80}):\s*(.+)$/.exec(line);
      if (m) push(m[1].trim(), m[2].trim());
    }
    return out;
  }
  walk(data, "", 0);
  return out;
}

function splitRow(line: string, sep: string): string[] {
  return line.split(sep).map((c) => c.trim());
}

/** Tables from CSV, Markdown, simple HTML, or {columns, rows} / list-of-objects data. */
export function tablesFrom(data: unknown): FdTable[] {
  if (!data) return [];
  if (Array.isArray(data)) {
    if (data.length && data.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      const cols = [...new Set(data.flatMap((r) => Object.keys(r as object)))];
      if (cols.includes("columns") && cols.includes("rows")) return data.flatMap(tablesFrom);
      return [{ columns: cols, rows: data.map((r) => cols.map((c) => (r as Record<string, unknown>)[c] ?? null)) }];
    }
    return data.flatMap(tablesFrom);
  }
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.columns) && Array.isArray(o.rows)) {
      return [{ name: typeof o.name === "string" ? o.name : null, columns: o.columns.map(String), rows: o.rows as unknown[][] }];
    }
    if (Array.isArray(o.tables)) return o.tables.flatMap(tablesFrom);
    return [];
  }
  if (typeof data !== "string") return [];
  const s = data.trim();
  if (/<table/i.test(s)) {
    return [...s.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => {
      const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
        [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, "").trim()));
      return { columns: rows[0] ?? [], rows: rows.slice(1) };
    }).filter((t) => t.columns.length);
  }
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines[0].includes("|")) {
    const body = lines.filter((l) => l.includes("|") && !/^\|?\s*:?-{2,}/.test(l));
    const parse = (l: string) => splitRow(l.replace(/^\|/, "").replace(/\|$/, ""), "|");
    return body.length >= 1 ? [{ columns: parse(body[0]), rows: body.slice(1).map(parse) }] : [];
  }
  if (lines.length >= 2 && lines[0].includes(",")) {
    return [{ columns: splitRow(lines[0], ","), rows: lines.slice(1).map((l) => splitRow(l, ",")) }];
  }
  return [];
}

function docTypeFrom(data: unknown): string | null {
  if (!data) return null;
  if (typeof data === "string") return data.split("\n")[0].replace(/^[^:]*:\s*/, "").trim().slice(0, 60) || null;
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["documentType", "document_type", "type", "category", "class", "label"]) {
      if (typeof o[k] === "string") return (o[k] as string).slice(0, 60);
    }
  }
  return null;
}

function piiFrom(data: unknown): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  const add = (t: unknown) => { const k = String(t || "unknown"); counts.set(k, (counts.get(k) ?? 0) + 1); };
  const items = Array.isArray(data) ? data
    : data && typeof data === "object" ? ((data as Record<string, unknown>).entities ?? (data as Record<string, unknown>).pii ?? (data as Record<string, unknown>).findings ?? []) : [];
  for (const it of (Array.isArray(items) ? items : []) as Record<string, unknown>[]) add(it?.type ?? it?.category ?? it?.label);
  return [...counts].map(([type, count]) => ({ type, count }));
}

/** Build the initial review from one method's output. */
export function draftReview(run: MethodRun, editor: string, now = new Date().toISOString()): DocumentReview {
  const r = run.results;
  const text = asText(r.text_extraction?.data) || asText(r.ocr_enhancement?.data) || asText(r.document_summarization?.data);
  const fields: FdField[] = [];
  for (const cap of FIELD_CAPS) {
    if (r[cap]) fields.push(...fieldsFrom(r[cap].data, run.method, cap, r[cap].confidence));
  }
  const seen = new Set<string>();
  const unique = fields.filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)));
  const redacted = asText(r.pii_redaction?.data);
  return {
    selectedMethod: run.method,
    docType: docTypeFrom(r.document_classification?.data) ?? "document",
    text: redacted || text,
    fields: unique,
    tables: tablesFrom(r.table_extraction?.data),
    summary: r.document_summarization ? asText(r.document_summarization.data).slice(0, 4000) : null,
    piiDetected: piiFrom(r.pii_detection?.data),
    piiRedacted: Boolean(redacted),
    editedBy: editor,
    editedAt: now,
  };
}

/**
 * Apply a reviewer's edits. Any field whose value changed keeps the value IDP
 * produced in `originalValue`, so the finalized record shows what the machine
 * said and what the human changed.
 */
export function applyEdits(previous: DocumentReview, edits: Partial<DocumentReview>, editor: string, now = new Date().toISOString()): DocumentReview {
  const prevByName = new Map(previous.fields.map((f) => [f.name, f]));
  const fields = (edits.fields ?? previous.fields).map((f) => {
    const before = prevByName.get(f.name);
    const changed = !before || JSON.stringify(before.value) !== JSON.stringify(f.value);
    if (!changed) return before!;
    const original = before ? (before.edited ? before.originalValue : before.value) : null;
    return {
      name: f.name, value: f.value, confidence: before?.confidence ?? null,
      method: before?.method ?? null, capability: before?.capability ?? null,
      edited: true, originalValue: original,
    };
  });
  return {
    ...previous,
    ...(edits.docType !== undefined ? { docType: edits.docType } : {}),
    ...(edits.text !== undefined ? { text: edits.text } : {}),
    ...(edits.tables !== undefined ? { tables: edits.tables } : {}),
    ...(edits.summary !== undefined ? { summary: edits.summary } : {}),
    fields,
    editedBy: editor,
    editedAt: now,
  };
}
