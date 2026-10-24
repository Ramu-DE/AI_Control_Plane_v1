// Document Intelligence quality analytics — computed from what the module
// already records (jobs, method runs, review edits, validation, finalized
// documents). Nothing is sampled or estimated. Pure.
//
//   STP rate         finalized without a person editing it: straight-through
//                    or auto-finalized, over all finalized documents
//   correction rate  fields a reviewer changed, over fields finalized
//   exception rate   documents that needed review because validation failed

import type { FinalizedDocument } from "./contract";
import type { DocumentJob } from "./model";

export interface TypeStats {
  documentType: string; // name, or "(no type)"
  documents: number;
  finalized: number;
  straightThrough: number;
  autoFinalized: number;
  exceptions: number;
  overrides: number;
  stpRate: number | null;
  fieldsFinalized: number;
  fieldsCorrected: number;
  correctionRate: number | null;
  medianMinutesToFinalize: number | null;
  avgCostUsd: number | null;
}

export interface MethodStats {
  method: string;
  runs: number;
  completed: number;
  successRate: number;
  avgLatencyMs: number | null;
  avgCostUsd: number | null;
  avgConfidence: number | null;
  selected: number;
  /** Of fields finalized from this method's output, the share a reviewer changed. */
  correctionRate: number | null;
}

export interface Analytics {
  totals: {
    documents: number;
    finalized: number;
    pending: number;
    exceptionsOpen: number;
    stpRate: number | null;
    correctionRate: number | null;
    medianMinutesToFinalize: number | null;
    totalCostUsd: number;
  };
  byType: TypeStats[];
  byMethod: MethodStats[];
  topCorrectedFields: { documentType: string; field: string; corrections: number; finalized: number; example?: { from: unknown; to: unknown } }[];
  topIssues: { documentType: string; ruleId: string; count: number; example: string }[];
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const jobCost = (j: DocumentJob) => j.methodRuns.reduce((s, r) => s + (r.cost ?? 0), 0);

export function computeAnalytics(jobs: DocumentJob[], finalized: FinalizedDocument[], typeName: (id?: string) => string): Analytics {
  const latestFd = new Map<string, FinalizedDocument>();
  for (const d of finalized) {
    const cur = latestFd.get(d.documentId);
    if (!cur || d.version > cur.version) latestFd.set(d.documentId, d);
  }
  const groups = new Map<string, DocumentJob[]>();
  for (const j of jobs) {
    const k = typeName(j.documentTypeId);
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }

  const minutesToFinalize = (j: DocumentJob) => {
    const d = latestFd.get(j.documentId);
    return d ? (Date.parse(d.provenance.finalizedAt) - Date.parse(j.createdAt)) / 60000 : null;
  };
  const corrections = (d: FinalizedDocument) => d.content.fields.filter((f) => f.edited).length;

  const byType: TypeStats[] = [...groups.entries()].map(([documentType, js]) => {
    const fin = js.filter((j) => latestFd.has(j.documentId));
    const fds = fin.map((j) => latestFd.get(j.documentId)!);
    const st = fin.filter((j) => j.route === "straight-through").length;
    const auto = fin.filter((j) => j.route === "auto-finalized").length;
    const fieldsFinalized = fds.reduce((s, d) => s + d.content.fields.length, 0);
    const fieldsCorrected = fds.reduce((s, d) => s + corrections(d), 0);
    return {
      documentType,
      documents: js.length,
      finalized: fin.length,
      straightThrough: st,
      autoFinalized: auto,
      exceptions: js.filter((j) => j.route === "exception").length,
      overrides: js.filter((j) => j.override).length,
      stpRate: ratio(st + auto, fin.length),
      fieldsFinalized,
      fieldsCorrected,
      correctionRate: ratio(fieldsCorrected, fieldsFinalized),
      medianMinutesToFinalize: median(fin.map(minutesToFinalize).filter((x): x is number => x !== null)),
      avgCostUsd: avg(js.filter((j) => j.methodRuns.length).map(jobCost)),
    };
  }).sort((a, b) => b.documents - a.documents);

  const methods = new Map<string, { runs: number; done: number; lat: number[]; cost: number[]; conf: number[]; selected: number; ff: number; fc: number }>();
  for (const j of jobs) {
    for (const r of j.methodRuns) {
      const m = methods.get(r.method) ?? { runs: 0, done: 0, lat: [], cost: [], conf: [], selected: 0, ff: 0, fc: 0 };
      m.runs += 1;
      if (r.status === "complete") {
        m.done += 1;
        if (r.latencyMs !== null) m.lat.push(r.latencyMs);
        if (r.cost !== null) m.cost.push(r.cost);
        if (r.confidence !== null) m.conf.push(r.confidence);
      }
      methods.set(r.method, m);
    }
    const d = latestFd.get(j.documentId);
    if (d) {
      const m = methods.get(d.provenance.selectedMethod);
      if (m) {
        m.selected += 1;
        m.ff += d.content.fields.length;
        m.fc += corrections(d);
      }
    }
  }
  const byMethod: MethodStats[] = [...methods.entries()].map(([method, m]) => ({
    method, runs: m.runs, completed: m.done, successRate: ratio(m.done, m.runs) ?? 0,
    avgLatencyMs: avg(m.lat), avgCostUsd: avg(m.cost), avgConfidence: avg(m.conf),
    selected: m.selected, correctionRate: ratio(m.fc, m.ff),
  })).sort((a, b) => b.runs - a.runs);

  const fieldMap = new Map<string, { documentType: string; field: string; corrections: number; finalized: number; example?: { from: unknown; to: unknown } }>();
  for (const j of jobs) {
    const d = latestFd.get(j.documentId);
    if (!d) continue;
    const t = typeName(j.documentTypeId);
    for (const f of d.content.fields) {
      const k = `${t}\u0000${f.name}`;
      const e = fieldMap.get(k) ?? { documentType: t, field: f.name, corrections: 0, finalized: 0 };
      e.finalized += 1;
      if (f.edited) {
        e.corrections += 1;
        e.example ??= { from: f.originalValue, to: f.value };
      }
      fieldMap.set(k, e);
    }
  }
  const topCorrectedFields = [...fieldMap.values()].filter((e) => e.corrections > 0)
    .sort((a, b) => b.corrections - a.corrections || a.field.localeCompare(b.field)).slice(0, 10);

  const issueMap = new Map<string, { documentType: string; ruleId: string; count: number; example: string }>();
  for (const j of jobs) {
    const t = typeName(j.documentTypeId);
    for (const i of j.validation?.issues ?? []) {
      const k = `${t}\u0000${i.ruleId}`;
      const e = issueMap.get(k) ?? { documentType: t, ruleId: i.ruleId, count: 0, example: i.message };
      e.count += 1;
      issueMap.set(k, e);
    }
  }
  const topIssues = [...issueMap.values()].sort((a, b) => b.count - a.count).slice(0, 10);

  const fin = jobs.filter((j) => latestFd.has(j.documentId));
  const fds = fin.map((j) => latestFd.get(j.documentId)!);
  const ff = fds.reduce((s, d) => s + d.content.fields.length, 0);
  return {
    totals: {
      documents: jobs.length,
      finalized: fin.length,
      pending: jobs.filter((j) => j.status === "pending-finalization").length,
      exceptionsOpen: jobs.filter((j) => j.route === "exception" && ["extracted", "in-review"].includes(j.status)).length,
      stpRate: ratio(fin.filter((j) => j.route === "straight-through" || j.route === "auto-finalized").length, fin.length),
      correctionRate: ratio(fds.reduce((s, d) => s + corrections(d), 0), ff),
      medianMinutesToFinalize: median(fin.map(minutesToFinalize).filter((x): x is number => x !== null)),
      totalCostUsd: Math.round(jobs.reduce((s, j) => s + jobCost(j), 0) * 10000) / 10000,
    },
    byType,
    byMethod,
    topCorrectedFields,
    topIssues,
  };
}
