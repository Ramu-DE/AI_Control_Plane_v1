// Calibrators per Document Type: trained from finalized documents, activated
// by an approver. Only an ACTIVE calibrator influences routing, so a change in
// what gets auto-accepted is a governed, audited decision — never a side
// effect of the latest finalization.

import { evaluate } from "../evaluator";
import { logAudit, newId, store } from "../store";
import { DOCINTEL_TOOL } from "../regulatory";
import {
  FEATURES, calibration, chooseThreshold, mineLabels, outOfFold, predict, requiredZeroErrorSample, trainLogistic,
} from "./accuracy";
import type { LogisticModel, MethodFieldStat, Reliability, ThresholdChoice } from "./accuracy";
import type { LabelSource } from "./accuracy";

export interface Calibrator {
  id: string;
  typeId: string;
  typeVersion: number;
  version: number;
  status: "candidate" | "active" | "retired";
  trainedAt: string;
  documents: number;
  labels: number;
  positives: number;
  target: number;
  model: LogisticModel;
  features: readonly string[];
  threshold: ThresholdChoice;
  ece: number;
  reliabilityBins: { lo: number; hi: number; n: number; meanP: number; accuracy: number }[];
  reliability: Reliability;
  methodStats: MethodFieldStat[];
  consensusAccuracy: number | null;
  bestSingleMethodAccuracy: { method: string; accuracy: number } | null;
  requiredSample: number;
  /** Extracted names that carried a field's approved value but are not yet synonyms. */
  suggestedSynonyms: { field: string; name: string; count: number }[];
  activatedBy?: string;
  activatedAt?: string;
}

export const DEFAULT_PRECISION_TARGET = 0.995;

export class CalibrationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Latest finalized version of each document of a type, with its job's method runs. */
export function labelSources(typeId: string): LabelSource[] {
  const latest = new Map<string, (typeof store.finalizedDocuments)[number]>();
  for (const r of store.finalizedDocuments) {
    if (r.doc.documentType?.id !== typeId) continue;
    const cur = latest.get(r.doc.documentId);
    if (!cur || r.doc.version > cur.doc.version) latest.set(r.doc.documentId, r);
  }
  const out: LabelSource[] = [];
  for (const r of latest.values()) {
    const job = store.documentJobs.find((j) => j.documentId === r.doc.documentId);
    if (!job?.methodRuns.length) continue;
    out.push({ documentId: r.doc.documentId, runs: job.methodRuns, approved: r.doc.content.fields });
  }
  return out;
}

export function activeCalibrator(typeId: string): Calibrator | undefined {
  return store.calibrators.find((c) => c.typeId === typeId && c.status === "active");
}

/** Train (or retrain) the candidate calibrator for a type from its finalized documents. */
export function trainCandidate(typeId: string): Calibrator {
  const t = store.documentTypes.find((x) => x.id === typeId && x.published);
  if (!t) throw new CalibrationError(`document type '${typeId}' is not published`, 404);
  const spec = t.published!.spec;
  const sources = labelSources(typeId);
  const mined = mineLabels(sources, spec.fields);
  const target = spec.routing.precisionTarget ?? DEFAULT_PRECISION_TARGET;
  const oof = mined.labels.length ? outOfFold(mined.labels) : [];
  const scored = mined.labels.map((l, i) => ({ p: oof[i], y: l.y }));
  const model = trainLogistic(mined.labels);
  const cal = calibration(scored);
  const byMethod = new Map<string, { c: number; n: number }>();
  for (const s of mined.methodStats) {
    const m = byMethod.get(s.method) ?? { c: 0, n: 0 };
    m.c += s.correct;
    m.n += s.total;
    byMethod.set(s.method, m);
  }
  const best = [...byMethod].map(([method, m]) => ({ method, accuracy: m.n ? m.c / m.n : 0 })).sort((a, b) => b.accuracy - a.accuracy)[0] ?? null;
  const prev = store.calibrators.filter((c) => c.typeId === typeId);
  const cand: Calibrator = {
    id: newId("cal"),
    typeId,
    typeVersion: t.published!.version,
    version: (prev.reduce((m, c) => Math.max(m, c.version), 0)) + 1,
    status: "candidate",
    trainedAt: new Date().toISOString(),
    documents: sources.length,
    labels: mined.labels.length,
    positives: mined.labels.filter((l) => l.y === 1).length,
    target,
    model,
    features: FEATURES,
    threshold: chooseThreshold(scored, target),
    ece: cal.ece,
    reliabilityBins: cal.bins,
    reliability: mined.reliability,
    methodStats: mined.methodStats,
    consensusAccuracy: mined.consensusAccuracy,
    bestSingleMethodAccuracy: best,
    requiredSample: requiredZeroErrorSample(target),
    suggestedSynonyms: mined.suggestedSynonyms,
  };
  // One candidate per type: the newest replaces an unactivated older one.
  store.calibrators = store.calibrators.filter((c) => !(c.typeId === typeId && c.status === "candidate"));
  store.calibrators.unshift(cand);
  return cand;
}

export function activateCalibrator(id: string, personaId: string): Calibrator {
  const c = store.calibrators.find((x) => x.id === id);
  if (!c) throw new CalibrationError(`calibrator '${id}' not found`, 404);
  if (c.status !== "candidate") throw new CalibrationError(`a ${c.status} calibrator cannot be activated`, 409);
  const t = store.documentTypes.find((x) => x.id === c.typeId)!;
  const p = store.personas.find((x) => x.id === personaId && !x.disabled);
  if (!p) throw new CalibrationError("a valid personaId is required");
  const d = evaluate({ personaId, agentId: "docintel", action: "approveDocumentType", tool: DOCINTEL_TOOL, resource: c.id, tenantId: t.tenantId });
  if (!d.allowed) throw new CalibrationError(d.decisions[d.decisions.length - 1]?.reason ?? "denied", 403);
  for (const o of store.calibrators) if (o.typeId === c.typeId && o.status === "active") o.status = "retired";
  c.status = "active";
  c.activatedBy = p.id;
  c.activatedAt = new Date().toISOString();
  logAudit({ category: "agent", action: "calibrator-activate", actor: p.name, tenantId: t.tenantId,
    detail: `Calibrator v${c.version} for '${t.draft.name}' activated: ${c.labels} labels from ${c.documents} documents, ` +
      (c.threshold.threshold === null ? `no auto-accept (${c.threshold.reason})` :
        `auto-accept at P ≥ ${c.threshold.threshold.toFixed(3)} (precision ${((c.threshold.precision ?? 0) * 100).toFixed(1)}%, ` +
        `95% lower bound ${((c.threshold.lowerBound ?? 0) * 100).toFixed(2)}%)`) });
  return c;
}

/** Calibrated probability for one feature vector under the type's active calibrator. */
export function calibratedP(typeId: string, x: number[]): { p: number; calibrator: Calibrator } | null {
  const c = activeCalibrator(typeId);
  return c ? { p: predict(c.model, x), calibrator: c } : null;
}
