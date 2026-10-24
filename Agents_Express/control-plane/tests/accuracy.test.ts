// ML accuracy layer (lib/docintel/accuracy.ts, calibration.ts): normalisation,
// grounding, consensus, calibration, bounds, threshold selection, routing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FEATURES, calibration, chooseThreshold, clopperPearsonLower, consensus, grounded, mineLabels, normalizeValue,
  outOfFold, predict, requiredZeroErrorSample, sameValue, trainLogistic,
} from "../src/lib/docintel/accuracy.ts";
import type { Label } from "../src/lib/docintel/accuracy.ts";
import { activateCalibrator, trainCandidate } from "../src/lib/docintel/calibration.ts";
import type { MethodRun } from "../src/lib/docintel/model.ts";
import type { FieldSpec } from "../src/lib/docintel/validation.ts";
import { store } from "../src/lib/store.ts";

test("values compare after normalisation, by type", () => {
  assert.ok(sameValue("2026-09-12", "12.09.2026", "date"));
  assert.ok(sameValue("12 Sep 2026", "2026-09-12", "date"));
  assert.ok(sameValue("745.00 USD", "745", "money"), "a currency on one side only is not a disagreement");
  assert.ok(!sameValue("745.00 USD", "745.00 EUR", "money"));
  assert.ok(sameValue("ACME Lab  Supplies.", "acme lab supplies", "text"));
  assert.ok(!sameValue("VF-24-0917", "VF-24-0918", "text"));
  assert.equal(normalizeValue("", "text"), null);
});

test("grounding finds the value in the source text, in any written form", () => {
  const src = "Batch Number: VF-24-0917\nExpiry Date: 11.09.2028\nTotal Due: 1,234.50 USD\nManufacturer: Takeda, Osaka Plant";
  assert.ok(grounded("VF-24-0917", "text", src));
  assert.ok(grounded("2028-09-11", "date", src));
  assert.ok(grounded("1234.5", "money", src));
  assert.ok(grounded("Osaka Plant Takeda", "text", src));
  assert.ok(!grounded("VF-24-0918", "text", src), "a near-miss identifier is not grounded");
  assert.ok(!grounded("2028-09-12", "date", src));
});

test("consensus weights methods by their measured reliability", () => {
  const cands = [
    { method: "nova-lite", value: "VF-24-0918", selfConfidence: 0.99 },
    { method: "claude-haiku", value: "VF-24-0917", selfConfidence: 0.5 },
  ];
  const rel = { "nova-lite": { correct: 2, total: 40 }, "claude-haiku": { correct: 39, total: 40 } };
  const c = consensus(cands, "text", rel)!;
  assert.equal(c.value, "VF-24-0917", "the reliable method wins despite lower self-confidence");
  assert.equal(c.agreement, 0.5);
  const three = consensus([...cands, { method: "claude-sonnet", value: "vf-24-0917", selfConfidence: 0.9 }], "text")!;
  assert.equal(three.agreement, 2 / 3);
  assert.ok(three.margin > 0);
});

test("Clopper–Pearson bounds and the zero-error sample size match the tables", () => {
  assert.equal(requiredZeroErrorSample(0.995), 598);
  assert.equal(requiredZeroErrorSample(0.999), 2995);
  assert.ok(Math.abs(clopperPearsonLower(598, 598) - 0.995) < 1e-4);
  assert.ok(clopperPearsonLower(946, 947) >= 0.995 - 1e-4 && clopperPearsonLower(945, 946) < 0.995);
  assert.equal(clopperPearsonLower(0, 10), 0);
});

test("threshold selection refuses without evidence and proves precision with it", () => {
  const small = chooseThreshold(Array.from({ length: 50 }, (_, i) => ({ p: 0.99 - i * 0.001, y: 1 })), 0.995);
  assert.equal(small.threshold, null);
  assert.match(small.reason, /not enough evidence: 50 verified field\(s\), at least 598/);
  // 700 high-score correct items, then a tail of mixed ones.
  const scored = [
    ...Array.from({ length: 700 }, (_, i) => ({ p: 0.999 - i * 1e-6, y: 1 })),
    ...Array.from({ length: 100 }, (_, i) => ({ p: 0.5 - i * 1e-3, y: i % 2 })),
  ];
  const ch = chooseThreshold(scored, 0.995);
  assert.ok(ch.threshold !== null && ch.threshold > 0.99, `threshold ${ch.threshold}`);
  assert.ok((ch.lowerBound ?? 0) >= 0.995);
  assert.equal(ch.accepted, 700);
});

test("logistic calibration learns that agreement + grounding predict correctness", () => {
  const data: { x: number[]; y: number }[] = [];
  for (let i = 0; i < 200; i++) {
    const agree = i % 2;
    const ground = (i >> 1) % 2;
    data.push({ x: [agree, agree * 0.8, ground, agree * ground, 0.75, 0.9, 1, 1], y: agree && ground ? 1 : (i % 7 === 0 ? 1 : 0) });
  }
  const m = trainLogistic(data);
  assert.equal(m.weights.length, FEATURES.length);
  assert.ok(predict(m, [1, 0.8, 1, 1, 0.75, 0.9, 1, 1]) > 0.8);
  assert.ok(predict(m, [0, 0, 0, 0, 0.75, 0.9, 1, 1]) < 0.3);
  const cal = calibration(data.map((d) => ({ p: predict(m, d.x), y: d.y })));
  assert.ok(cal.ece < 0.1, `ECE ${cal.ece}`);
  const labels: Label[] = data.map((d, i) => ({ docKey: `doc-${i % 40}`, field: "f", x: d.x, y: d.y as 0 | 1 }));
  assert.deepEqual(outOfFold(labels), outOfFold(labels), "deterministic");
});

// ---------------------------------------------------------------- mining + lifecycle

const schema: FieldSpec[] = [
  { name: "batch_number", type: "text", required: true, synonyms: ["batch"] },
  { name: "expiry_date", type: "date", required: true, synonyms: ["expiry"] },
];
const run = (method: string, batch: string, expiry: string): MethodRun => ({
  method, status: "complete", latencyMs: 1, cost: 0.001, confidence: 0.9,
  results: {
    text_extraction: { data: `Batch: VF-1\nExpiry: 2028-09-11`, confidence: 0.9, format: "text" },
    kv_extraction: { data: { batch, expiry }, confidence: 0.9, format: "json" },
  },
});

test("labels are mined per method from finalized truth; the weak method is measured as weak", () => {
  const sources = Array.from({ length: 10 }, (_, i) => ({
    documentId: `doc-m${i}`,
    runs: [run("good", "VF-1", "2028-09-11"), run("bad", i % 2 ? "VF-7" : "VF-1", "2028-09-11")],
    approved: [{ name: "batch_number", value: "VF-1", edited: false }, { name: "expiry_date", value: "11.09.2028", edited: false }],
  }));
  const m = mineLabels(sources, schema);
  const acc = (method: string, field: string) => m.methodStats.find((s) => s.method === method && s.field === field)!.accuracy;
  assert.equal(acc("good", "batch_number"), 1);
  assert.equal(acc("bad", "batch_number"), 0.5);
  assert.equal(acc("bad", "expiry_date"), 1, "date formats are normalised before comparison");
  assert.equal(m.labels.length, 20);
  assert.equal(m.consensusAccuracy, 1, "consensus picks the reliable method's value");
});

test("a candidate calibrator is trained from finalized documents and activated only by an approver", () => {
  const typeId = "dt-seed-coa";
  const c = trainCandidate(typeId);
  assert.equal(c.status, "candidate");
  assert.equal(c.threshold.threshold, null, "no evidence in a fresh store: no auto-accept");
  assert.equal(c.requiredSample, 598);
  assert.throws(() => activateCalibrator(c.id, "persona-priya"), /not a member/, "an R&D analyst cannot activate an org-level calibrator");
  const a = activateCalibrator(c.id, "persona-john");
  assert.equal(a.status, "active");
  assert.equal(store.calibrators.filter((x) => x.typeId === typeId && x.status === "active").length, 1);
});

test("a method that misses a field counts as wrong, and the missed label is learned as a synonym", () => {
  const lot = (method: string, key: string): MethodRun => ({
    method, status: "complete", latencyMs: 1, cost: 0, confidence: 0.9,
    results: { kv_extraction: { data: { [key]: "VF-1", expiry: "2028-09-11" }, confidence: 0.9, format: "json" } },
  });
  const sources = Array.from({ length: 4 }, (_, i) => ({
    documentId: `doc-s${i}`, runs: [lot("a", "batch"), lot("b", "Lot No.")],
    approved: [{ name: "batch_number", value: "VF-1", edited: false }, { name: "expiry_date", value: "2028-09-11", edited: false }],
  }));
  const m = mineLabels(sources, schema);
  const b = m.methodStats.find((s) => s.method === "b" && s.field === "batch_number")!;
  assert.equal(b.accuracy, 0, "'Lot No.' is not mapped, so method b missed batch_number every time");
  assert.deepEqual(m.suggestedSynonyms, [{ field: "batch_number", name: "Lot No.", count: 4 }]);
});
