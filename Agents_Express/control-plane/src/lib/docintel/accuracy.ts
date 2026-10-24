// Measured, calibrated extraction accuracy (ML-1 … ML-4). Pure.
//
// The IDP engine's "confidence" is a self-report or a fixed fallback, so it
// says nothing about correctness. Everything here is learned from what the
// platform already has: every finalized document is ground truth approved by
// two people, and every method's raw output is stored on the job, so each
// finalized field is a LABEL for each method ("did method m get field f
// right?"). From those labels:
//
//   ML-1  accuracy per Document Type x field x method (normalised exact match)
//   ML-2  grounding: is the value actually present in the extracted text?
//   ML-3  consensus: weighted vote across methods, weights = log-odds of each
//         method's historical accuracy for that field (Beta-smoothed)
//   ML-4  a logistic-regression calibrator P(correct | features), trained on
//         out-of-fold predictions, and an auto-accept threshold t chosen so
//         that precision >= target with 95% confidence (Clopper–Pearson lower
//         bound, fixed-sequence from high t downwards). Too little evidence
//         means NO threshold: nothing is auto-accepted.
//
// Deterministic: no randomness except a hash-based fold assignment.

import { createHash } from "node:crypto";
import type { FdField } from "./contract";
import type { MethodRun } from "./model";
import { draftReview } from "./review";
import { mapFieldsToSchema, normName, parseDate, parseNumber } from "./validation";
import type { FieldSpec } from "./validation";

// --------------------------------------------------------------------------- //
// Normalisation and matching
// --------------------------------------------------------------------------- //

/** Canonical form for comparing two values of a field type. */
export function normalizeValue(v: unknown, type: FieldSpec["type"] = "text"): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v.trim() : JSON.stringify(v);
  if (!s) return null;
  if (type === "date") {
    const d = parseDate(s);
    return d === null ? `t:${normName(s)}` : `d:${new Date(d).toISOString().slice(0, 10)}`;
  }
  if (type === "number" || type === "money" || type === "percent") {
    const n = parseNumber(s);
    const cur = /\b(USD|EUR|GBP|JPY|CHF)\b|[$€£¥]/i.exec(s)?.[0]?.toUpperCase() ?? "";
    return n === null ? `t:${normName(s)}` : `n:${Math.round(n * 1e6) / 1e6}${cur ? `:${cur}` : ""}`;
  }
  return `t:${s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim()}`;
}

export function sameValue(a: unknown, b: unknown, type: FieldSpec["type"]): boolean {
  const x = normalizeValue(a, type);
  const y = normalizeValue(b, type);
  if (x === null || y === null) return false;
  if (x === y) return true;
  // A currency present on one side only is not a disagreement about the number.
  return x.startsWith("n:") && y.startsWith("n:") && x.split(":")[1] === y.split(":")[1] && (x.split(":").length === 2 || y.split(":").length === 2);
}

/** ML-2: is the value supported by the extracted text? 1 = verbatim / same number / same date. */
export function grounded(value: unknown, type: FieldSpec["type"], sourceText: string): boolean {
  if (value === null || value === undefined || value === "") return false;
  const v = String(typeof value === "string" ? value : JSON.stringify(value));
  const squash = (s: string) => s.toLowerCase().replace(/[\s,]/g, "");
  if (squash(sourceText).includes(squash(v))) return true;
  if (type === "number" || type === "money" || type === "percent") {
    const n = parseNumber(v);
    if (n === null) return false;
    return (sourceText.match(/-?\d[\d.,]*/g) ?? []).some((t) => parseNumber(t) === n);
  }
  if (type === "date") {
    const d = parseDate(v);
    if (d === null) return false;
    const candidates = sourceText.match(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}[./]\d{4}|\d{1,2}[\s-][A-Za-z]{3,9}[\s-,]+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/g) ?? [];
    return candidates.some((c) => parseDate(c) === d);
  }
  // text: every word of the value appears in the source
  const words = v.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const src = sourceText.toLowerCase();
  return words.length > 0 && words.every((w) => src.includes(w));
}

// --------------------------------------------------------------------------- //
// Per-method candidate values for a type's schema
// --------------------------------------------------------------------------- //

export interface Candidate {
  method: string;
  value: unknown;
  selfConfidence: number | null;
}

/** For each schema field: what each completed method extracted (after mapping to the schema). */
export function candidatesBySchemaField(runs: MethodRun[], schema: FieldSpec[]): Record<string, Candidate[]> {
  const out: Record<string, Candidate[]> = Object.fromEntries(schema.map((f) => [f.name, []]));
  for (const run of runs.filter((r) => r.status === "complete" && Object.keys(r.results).length)) {
    const fields = mapFieldsToSchema(draftReview(run, "accuracy").fields, schema);
    for (const spec of schema) {
      const f = fields.find((x) => x.name === spec.name);
      if (f && f.value !== null && f.value !== undefined && String(f.value).trim() !== "") {
        out[spec.name].push({ method: run.method, value: f.value, selfConfidence: typeof f.confidence === "number" ? f.confidence : null });
      }
    }
  }
  return out;
}

export function sourceTextOf(runs: MethodRun[]): string {
  return runs.filter((r) => r.status === "complete").map((r) => {
    const t = r.results.text_extraction?.data;
    return typeof t === "string" ? t : t ? JSON.stringify(t) : "";
  }).join("\n");
}

// --------------------------------------------------------------------------- //
// ML-1 reliability and ML-3 consensus
// --------------------------------------------------------------------------- //

/** Beta-smoothed accuracy of a method for a field; prior mean 0.8 with weight 5. */
export function smoothedAccuracy(correct: number, total: number, prior = 0.8, weight = 5): number {
  return (correct + prior * weight) / (total + weight);
}

export type Reliability = Record<string, Record<string, { correct: number; total: number }>>; // field -> method -> counts

export interface Consensus {
  value: unknown;
  method: string;
  /** Share of methods (by count) that agree with the chosen value. */
  agreement: number;
  methods: number;
  /** Normalised vote margin between the best and the runner-up value, 0..1. */
  margin: number;
  candidates: Candidate[];
}

export function consensus(cands: Candidate[], type: FieldSpec["type"], rel?: Record<string, { correct: number; total: number }>): Consensus | null {
  if (!cands.length) return null;
  const groups: { key: string; members: Candidate[]; score: number }[] = [];
  for (const c of cands) {
    const key = normalizeValue(c.value, type) ?? "";
    let g = groups.find((x) => sameValue(x.members[0].value, c.value, type) || x.key === key);
    if (!g) { g = { key, members: [], score: 0 }; groups.push(g); }
    g.members.push(c);
    const r = rel?.[c.method];
    const a = Math.min(0.999, Math.max(0.501, smoothedAccuracy(r?.correct ?? 0, r?.total ?? 0)));
    g.score += Math.log(a / (1 - a));
  }
  groups.sort((a, b) => b.score - a.score || b.members.length - a.members.length);
  const best = groups[0];
  const total = groups.reduce((s, g) => s + Math.max(g.score, 0), 0) || 1;
  const second = groups[1]?.score ?? 0;
  // Representative: the member from the most reliable method.
  const rep = [...best.members].sort((a, b) => smoothedAccuracy(rel?.[b.method]?.correct ?? 0, rel?.[b.method]?.total ?? 0)
    - smoothedAccuracy(rel?.[a.method]?.correct ?? 0, rel?.[a.method]?.total ?? 0))[0];
  return {
    value: rep.value, method: rep.method, agreement: best.members.length / cands.length, methods: cands.length,
    margin: Math.max(0, Math.min(1, (best.score - second) / total)), candidates: cands,
  };
}

// --------------------------------------------------------------------------- //
// Features, labels, calibrator
// --------------------------------------------------------------------------- //

// agreeGrounded is the interaction "methods agree AND the value is in the text":
// correctness is close to that conjunction, which an additive model cannot express.
export const FEATURES = ["agreement", "margin", "grounded", "agreeGrounded", "methods", "selfConfidence", "formatValid", "bias"] as const;
export type FeatureVector = number[];

export function features(c: Consensus, type: FieldSpec["type"], sourceText: string): FeatureVector {
  const v = c.value;
  const formatValid = type === "date" ? (parseDate(String(v)) !== null ? 1 : 0)
    : type === "number" || type === "money" || type === "percent" ? (parseNumber(v) !== null ? 1 : 0) : 1;
  const self = c.candidates.map((x) => x.selfConfidence).filter((x): x is number => x !== null);
  const g = grounded(v, type, sourceText) ? 1 : 0;
  return [
    c.agreement,
    c.margin,
    g,
    c.agreement * g,
    Math.min(c.methods, 4) / 4,
    self.length ? self.reduce((a, b) => a + b, 0) / self.length : 0.5,
    formatValid,
    1,
  ];
}

export interface Label {
  docKey: string; // fold assignment
  field: string;
  x: FeatureVector;
  y: 0 | 1;
}

export interface LogisticModel {
  weights: number[];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** L2-regularised logistic regression by full-batch gradient descent. Deterministic. */
export function trainLogistic(data: { x: FeatureVector; y: number }[], l2 = 0.1, iters = 3000, lr = 0.5): LogisticModel {
  const d = FEATURES.length;
  const w = new Array(d).fill(0);
  if (!data.length) return { weights: w };
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0);
    for (const { x, y } of data) {
      const p = sigmoid(x.reduce((s, xi, i) => s + xi * w[i], 0));
      for (let i = 0; i < d; i++) g[i] += (p - y) * x[i];
    }
    for (let i = 0; i < d; i++) w[i] -= lr * (g[i] / data.length + (i === d - 1 ? 0 : l2 * w[i] / data.length));
  }
  return { weights: w.map((x) => Math.round(x * 1e6) / 1e6) };
}

export function predict(m: LogisticModel, x: FeatureVector): number {
  return sigmoid(x.reduce((s, xi, i) => s + xi * (m.weights[i] ?? 0), 0));
}

function fold(key: string, k: number): number {
  return createHash("sha256").update(key).digest()[0] % k;
}

/** Out-of-fold probabilities (grouped by document, so a document never scores itself). */
export function outOfFold(labels: Label[], k = 5): number[] {
  const folds = labels.map((l) => fold(l.docKey, k));
  return labels.map((l, i) => {
    const train = labels.filter((_, j) => folds[j] !== folds[i]);
    // A fold with no training data falls back to the full model (only with tiny datasets).
    return predict(trainLogistic(train.length ? train : labels), l.x);
  });
}

// --------------------------------------------------------------------------- //
// Bounds and threshold selection
// --------------------------------------------------------------------------- //

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}

/** One-sided Clopper–Pearson lower bound on a proportion (k of n), confidence 1 - alpha. */
export function clopperPearsonLower(k: number, n: number, alpha = 0.05): number {
  if (n === 0 || k === 0) return 0;
  const tail = (p: number) => {
    let s = 0;
    for (let i = k; i <= n; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
    return s;
  };
  let lo = 0, hi = k / n;
  for (let it = 0; it < 80; it++) {
    const mid = (lo + hi) / 2;
    if (tail(mid) < alpha) lo = mid; else hi = mid;
  }
  return lo;
}

/** Smallest n (with zero errors) for which the lower bound reaches the target. */
export function requiredZeroErrorSample(target: number, alpha = 0.05): number {
  return Math.ceil(Math.log(alpha) / Math.log(target));
}

export interface ThresholdChoice {
  threshold: number | null;
  /** Precision and its lower bound among items at or above the threshold. */
  accepted: number;
  correctAccepted: number;
  precision: number | null;
  lowerBound: number | null;
  coverage: number; // share of labelled items that would be auto-accepted
  reason: string;
}

/**
 * Learn-then-Test style selection: walk candidate thresholds from the highest
 * score down; keep the lowest threshold whose accepted set still has a
 * Clopper–Pearson lower bound >= target; stop at the first failure.
 */
export function chooseThreshold(scored: { p: number; y: number }[], target: number, minAccepted?: number, alpha = 0.05): ThresholdChoice {
  const need = minAccepted ?? requiredZeroErrorSample(target, alpha);
  const sorted = [...scored].sort((a, b) => b.p - a.p);
  let best: ThresholdChoice | null = null;
  let k = 0;
  for (let i = 0; i < sorted.length; i++) {
    k += sorted[i].y;
    const n = i + 1;
    if (i + 1 < sorted.length && sorted[i + 1].p === sorted[i].p) continue; // ties: decide on the whole tie group
    const lb = clopperPearsonLower(k, n, alpha);
    if (n >= need && lb >= target) {
      best = { threshold: sorted[i].p, accepted: n, correctAccepted: k, precision: k / n, lowerBound: lb, coverage: n / sorted.length, reason: "" };
    } else if (best) {
      break; // fixed-sequence testing: the first failure after a pass ends the walk
    }
  }
  if (best) {
    best.reason = `precision ≥ ${(target * 100).toFixed(1)}% with 95% confidence on ${best.accepted} verified field(s)`;
    return best;
  }
  const total = sorted.length;
  const correct = sorted.reduce((s, x) => s + x.y, 0);
  return {
    threshold: null, accepted: 0, correctAccepted: 0, precision: total ? correct / total : null,
    lowerBound: total ? clopperPearsonLower(correct, total, alpha) : null, coverage: 0,
    reason: total < need
      ? `not enough evidence: ${total} verified field(s), at least ${need} error-free needed to show ≥ ${(target * 100).toFixed(1)}%`
      : `no threshold reaches ≥ ${(target * 100).toFixed(1)}% precision with 95% confidence`,
  };
}

/** Expected calibration error and reliability bins. */
export function calibration(scored: { p: number; y: number }[], bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, meanP: 0, accuracy: 0 }));
  for (const s of scored) {
    const b = out[Math.min(bins - 1, Math.floor(s.p * bins))];
    b.n += 1;
    b.meanP += s.p;
    b.accuracy += s.y;
  }
  let ece = 0;
  for (const b of out) {
    if (b.n) {
      b.meanP /= b.n;
      b.accuracy /= b.n;
      ece += (b.n / Math.max(1, scored.length)) * Math.abs(b.accuracy - b.meanP);
    }
  }
  return { ece: Math.round(ece * 1e4) / 1e4, bins: out.filter((b) => b.n) };
}

// --------------------------------------------------------------------------- //
// Mining labels from finalized documents
// --------------------------------------------------------------------------- //

export interface LabelSource {
  documentId: string;
  runs: MethodRun[];
  approved: FdField[];
}

export interface MethodFieldStat { method: string; field: string; correct: number; total: number; accuracy: number }

/**
 * For one Document Type: per-method accuracy per field (ML-1), the reliability
 * table for consensus (ML-3), and calibrator training labels (ML-4).
 */
export function mineLabels(sources: LabelSource[], schema: FieldSpec[]) {
  const rel: Reliability = {};
  const stats = new Map<string, MethodFieldStat>();
  const labels: Label[] = [];
  const typeOf = (f: string) => schema.find((s) => s.name === f)?.type ?? "text";
  const synonymHits = new Map<string, { field: string; name: string; count: number }>();
  // Pass 1: per-method correctness. A completed method that produced NO value
  // for a field the document has is a miss (recall), not "no data".
  for (const src of sources) {
    const cands = candidatesBySchemaField(src.runs, schema);
    const completed = src.runs.filter((r) => r.status === "complete" && Object.keys(r.results).length).map((r) => r.method);
    for (const spec of schema) {
      const truth = src.approved.find((f) => f.name === spec.name)?.value;
      if (truth === undefined || truth === null || String(truth).trim() === "") continue;
      const produced = new Set(cands[spec.name].map((c) => c.method));
      const outcomes = [
        ...cands[spec.name].map((c) => ({ method: c.method, ok: sameValue(c.value, truth, spec.type) })),
        ...completed.filter((m) => !produced.has(m)).map((m) => ({ method: m, ok: false })),
      ];
      for (const c of outcomes) {
        const ok = c.ok;
        rel[spec.name] ??= {};
        rel[spec.name][c.method] ??= { correct: 0, total: 0 };
        rel[spec.name][c.method].total += 1;
        if (ok) rel[spec.name][c.method].correct += 1;
        const key = `${c.method}\u0000${spec.name}`;
        const st = stats.get(key) ?? { method: c.method, field: spec.name, correct: 0, total: 0, accuracy: 0 };
        st.total += 1;
        if (ok) st.correct += 1;
        st.accuracy = st.correct / st.total;
        stats.set(key, st);
      }
    }
  }
  // Synonym learning: extracted names that were NOT mapped to the schema but
  // carry a field's approved value (e.g. "Lot No." holding batch_number).
  for (const src of sources) {
    for (const run of src.runs.filter((r) => r.status === "complete")) {
      const raw = draftReview(run, "accuracy").fields;
      const mapped = new Set(mapFieldsToSchema(raw, schema).filter((f) => schema.some((s) => s.name === f.name)).map((f) => f.value));
      for (const f of raw) {
        if (mapped.has(f.value)) continue;
        if (schema.some((s) => normName(s.name) === normName(f.name) || (s.synonyms ?? []).some((y) => normName(y) === normName(f.name)))) continue;
        for (const spec of schema) {
          const truth = src.approved.find((a) => a.name === spec.name)?.value;
          if (truth === undefined || truth === null || !sameValue(f.value, truth, spec.type)) continue;
          // "total.amount" is a nested path (keep the leaf); "Lot No." is a label with a full stop.
          const leaf = /^[\w-]+(\.[\w-]+)+$/.test(f.name) ? f.name.split(".").pop()! : f.name;
          const label = leaf.replace(/_/g, " ").trim();
          if (!label) continue;
          const key = `${spec.name}\u0000${normName(label)}`;
          const e = synonymHits.get(key) ?? { field: spec.name, name: label, count: 0 };
          e.count += 1;
          synonymHits.set(key, e);
        }
      }
    }
  }

  // Pass 2: consensus value per field -> features + label.
  let consensusCorrect = 0;
  let consensusTotal = 0;
  for (const src of sources) {
    const cands = candidatesBySchemaField(src.runs, schema);
    const text = sourceTextOf(src.runs);
    for (const spec of schema) {
      const truth = src.approved.find((f) => f.name === spec.name)?.value;
      if (truth === undefined || truth === null || String(truth).trim() === "") continue;
      const c = consensus(cands[spec.name], spec.type, rel[spec.name]);
      if (!c) { consensusTotal += 1; continue; } // no method found it: a consensus miss
      const y = sameValue(c.value, truth, typeOf(spec.name)) ? 1 : 0;
      consensusTotal += 1;
      consensusCorrect += y;
      labels.push({ docKey: src.documentId, field: spec.name, x: features(c, spec.type, text), y: y as 0 | 1 });
    }
  }
  return {
    reliability: rel,
    methodStats: [...stats.values()].sort((a, b) => a.field.localeCompare(b.field) || b.accuracy - a.accuracy),
    labels,
    consensusAccuracy: consensusTotal ? consensusCorrect / consensusTotal : null,
    consensusTotal,
    suggestedSynonyms: [...synonymHits.values()].filter((x) => x.count >= 2).sort((a, b) => b.count - a.count),
  };
}
