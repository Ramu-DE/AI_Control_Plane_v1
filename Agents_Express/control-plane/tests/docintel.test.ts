// Offline tests for Document Intelligence (lib/docintel/*).
//
// These pin the contract (FinalizedDocument v1 validation and the content
// hash the RAG Factory re-computes), the normalisation of IDP's untyped
// output into a review, SSE parsing, and the governance of the lifecycle:
// analyst+ to process and review, approver+ to finalize, never the submitter,
// GxP training in GxP tenants. The IDP engine and Delta are stubbed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, contentSha256, validateFinalizedDocument } from "../src/lib/docintel/contract.ts";
import type { FinalizedDocument } from "../src/lib/docintel/contract.ts";
import { fieldsFrom, tablesFrom, draftReview, applyEdits } from "../src/lib/docintel/review.ts";
import { methodRunsFromEvents, parseSse } from "../src/lib/docintel/idpClient.ts";
import type { DocumentJob, MethodRun } from "../src/lib/docintel/model.ts";
import { publicJob } from "../src/lib/docintel/model.ts";
import {
  DocIntelError, bestRun, buildFinalizedDocument, finalize, listJobs, saveReview, sendBack,
  setMasterDataLookup, startRun, submitForFinalization,
} from "../src/lib/docintel/service.ts";
import { store } from "../src/lib/store.ts";

const RUN: MethodRun = {
  method: "claude-haiku", status: "complete", latencyMs: 1200, cost: 0.0012, confidence: 0.91,
  results: {
    text_extraction: { data: "INVOICE 42\nTotal: 100 USD", confidence: 0.9, format: "text" },
    kv_extraction: { data: { invoiceNumber: "42", total: { amount: 100, currency: "USD" } }, confidence: 0.88, format: "json" },
    table_extraction: { data: "| item | qty |\n|---|---|\n| widget | 2 |", confidence: 0.8, format: "markdown" },
    document_classification: { data: { documentType: "invoice" }, confidence: 0.95, format: "json" },
    pii_detection: { data: { entities: [{ type: "NAME" }, { type: "NAME" }, { type: "EMAIL" }] }, confidence: 0.9, format: "json" },
  },
};

function job(over: Partial<DocumentJob> = {}): DocumentJob {
  const now = new Date().toISOString();
  return {
    documentId: `doc-t${Math.random().toString(36).slice(2, 8)}`, tenantId: "fn-rnd", createdBy: "persona-priya",
    createdAt: now, updatedAt: now, fileName: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1234,
    sha256: "a".repeat(64), idpDocumentId: "idp-1", idpRef: "local://uploads/fn-rnd/x/invoice.pdf",
    status: "extracted", capabilities: Object.keys(RUN.results), methodRuns: [RUN],
    review: draftReview(RUN, "persona-priya"), finalizedDocumentIds: [], ...over,
  };
}

// Never reach Unity Catalog from unit tests.
setMasterDataLookup(async () => true);

const noPublish = async () => ({ status: "skipped" as const, detail: "test" });

// ---------------------------------------------------------------- contract

test("canonical JSON sorts keys at every level and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson("é"), '"é"', "non-ASCII stays literal, like Python ensure_ascii=False");
});

test("the content hash ignores key order and changes with content", () => {
  const a = { text: "x", fields: [], tables: [] };
  const b = { tables: [], fields: [], text: "x" };
  assert.equal(contentSha256(a), contentSha256(b));
  assert.notEqual(contentSha256(a), contentSha256({ ...a, text: "y" }));
});

test("a built document is valid v1 and tampering is caught", () => {
  const j = job({ status: "pending-finalization", submittedBy: "persona-priya", submittedAt: new Date().toISOString() });
  const doc = buildFinalizedDocument(j, { id: "persona-daniel", name: "Daniel" }, { id: "persona-priya", name: "Priya" }, null);
  assert.deepEqual(validateFinalizedDocument(doc), []);
  assert.equal(doc.classification.gxp, true, "fn-rnd is a GxP tenant");
  assert.equal(doc.classification.docType, "invoice");
  assert.equal(doc.pii.redaction, "retained");
  assert.equal(doc.version, 1);

  const tampered: FinalizedDocument = structuredClone(doc);
  tampered.content.text = "changed after approval";
  assert.ok(validateFinalizedDocument(tampered).includes("contentSha256 does not match content"));

  const selfApproved = structuredClone(doc);
  selfApproved.provenance.finalizedBy = selfApproved.provenance.submittedBy;
  assert.ok(validateFinalizedDocument(selfApproved).some((e) => e.startsWith("four eyes")));

  const edited = structuredClone(doc);
  edited.content.fields[0] = { ...edited.content.fields[0], edited: true };
  delete edited.content.fields[0].originalValue;
  edited.contentSha256 = contentSha256(edited.content);
  assert.ok(validateFinalizedDocument(edited).some((e) => e.includes("no originalValue")));
});

// ---------------------------------------------------------------- review

test("IDP output shapes become fields and tables", () => {
  const f = fieldsFrom({ a: 1, nested: { b: "x" } }, "m", "kv_extraction", 0.5);
  assert.deepEqual(f.map((x) => [x.name, x.value]), [["a", 1], ["nested.b", "x"]]);
  const pairs = fieldsFrom([{ key: "Name", value: "Ann", confidence: 2 }], "m", "kv_extraction", null);
  assert.equal(pairs[0].confidence, 1, "confidence is clamped into 0..1");
  assert.deepEqual(fieldsFrom("Date: 2026-01-01\nnoise", "m", "kv_extraction", null).map((x) => x.name), ["Date"]);

  assert.deepEqual(tablesFrom("a,b\n1,2"), [{ columns: ["a", "b"], rows: [["1", "2"]] }]);
  assert.deepEqual(tablesFrom("<table><tr><th>h</th></tr><tr><td>v</td></tr></table>"), [{ columns: ["h"], rows: [["v"]] }]);
  assert.deepEqual(tablesFrom([{ x: 1 }, { x: 2, y: 3 }]), [{ columns: ["x", "y"], rows: [[1, null], [2, 3]] }]);
});

test("a draft review takes text, fields, tables, type and PII from one method", () => {
  const r = draftReview(RUN, "persona-priya");
  assert.equal(r.docType, "invoice");
  assert.match(r.text, /INVOICE 42/);
  assert.deepEqual(r.fields.map((f) => f.name), ["invoiceNumber", "total.amount", "total.currency"]);
  assert.deepEqual(r.tables[0], { columns: ["item", "qty"], rows: [["widget", "2"]] });
  assert.deepEqual(r.piiDetected, [{ type: "NAME", count: 2 }, { type: "EMAIL", count: 1 }]);
});

test("an edit keeps the machine's value as originalValue, across repeated edits", () => {
  const r = draftReview(RUN, "a");
  const once = applyEdits(r, { fields: r.fields.map((f) => (f.name === "invoiceNumber" ? { ...f, value: "43" } : f)) }, "b");
  const f1 = once.fields.find((f) => f.name === "invoiceNumber")!;
  assert.equal(f1.edited, true);
  assert.equal(f1.originalValue, "42");
  const twice = applyEdits(once, { fields: once.fields.map((f) => (f.name === "invoiceNumber" ? { ...f, value: "44" } : f)) }, "c");
  assert.equal(twice.fields.find((f) => f.name === "invoiceNumber")!.originalValue, "42");
  assert.equal(twice.fields.find((f) => f.name === "total.amount")!.edited, false);
});

// ---------------------------------------------------------------- SSE

test("SSE frames become one MethodRun per requested method", () => {
  const body = [
    `data: ${JSON.stringify({ type: "method_complete", method: "claude-haiku", data: {
      method: "claude-haiku", status: "complete", results: { text_extraction: { data: "t", confidence: 0.9, format: "text" } },
      metrics: { latencyMs: 10, cost: 0.1, confidence: 0.9 } } })}`,
    ": keepalive",
    `data: ${JSON.stringify({ type: "method_error", method: "nova-lite", error: "throttled" })}`,
    "data: {not json",
  ].join("\n\n");
  const events = parseSse(body);
  assert.equal(events.length, 2);
  const runs = methodRunsFromEvents(events, ["claude-haiku", "nova-lite", "claude-sonnet"]);
  assert.deepEqual(runs.map((r) => [r.method, r.status]), [["claude-haiku", "complete"], ["nova-lite", "error"], ["claude-sonnet", "error"]]);
  assert.equal(runs[1].error, "throttled");
  assert.equal(runs[2].error, "no result returned by the IDP engine");
  assert.equal(bestRun(runs)?.method, "claude-haiku");
});

test("the engine's storage reference is never public", () => {
  assert.equal("idpRef" in publicJob(job()), false);
});

// ---------------------------------------------------------------- governance

test("finalization is four-eyes, approver-only, and versioned", async () => {
  const j = job();
  store.documentJobs.unshift(j);
  await assert.rejects(submitForFinalization(j.documentId, "persona-sofia"), (e: DocIntelError) => e.status === 403,
    "a persona outside the tenant cannot submit");
  await submitForFinalization(j.documentId, "persona-priya");
  assert.equal(j.status, "pending-finalization");
  await assert.rejects(saveReview({ documentId: j.documentId, personaId: "persona-priya" }), /cannot be reviewed/,
    "a pending document is locked");

  await assert.rejects(finalize(j.documentId, "persona-priya", null, noPublish), (e: DocIntelError) => e.code === "SELF_REVIEW");
  await assert.rejects(finalize(j.documentId, "persona-omar", null, noPublish), (e: DocIntelError) => e.status === 403,
    "an approver from another tenant cannot finalize");

  const rec = await finalize(j.documentId, "persona-daniel", "checked", noPublish);
  assert.equal(j.status, "finalized");
  assert.equal(rec.doc.version, 1);
  assert.equal(rec.doc.provenance.finalizedBy.personaId, "persona-daniel");
  assert.equal(rec.delta.status, "skipped");
  assert.deepEqual(validateFinalizedDocument(rec.doc), []);

  // A correction is a new version that supersedes the first.
  await saveReview({ documentId: j.documentId, personaId: "persona-priya", edits: { docType: "credit-note" } });
  await submitForFinalization(j.documentId, "persona-priya");
  const v2 = await finalize(j.documentId, "persona-daniel", null, noPublish);
  assert.equal(v2.doc.version, 2);
  assert.equal(v2.doc.supersedes, rec.doc.finalizedDocumentId);
  assert.equal(v2.doc.classification.docType, "credit-note");
  assert.equal(rec.doc.classification.docType, "invoice", "v1 is unchanged");
});

test("an analyst cannot send back or finalize; a failed publish is recorded, not lost", async () => {
  const j = job();
  store.documentJobs.unshift(j);
  await submitForFinalization(j.documentId, "persona-priya");
  assert.throws(() => sendBack(j.documentId, "persona-priya", "no"), (e: DocIntelError) => e.status === 403);
  sendBack(j.documentId, "persona-daniel", "fix the total");
  assert.equal(j.status, "in-review");
  assert.equal(j.sentBackNote, "fix the total");

  await submitForFinalization(j.documentId, "persona-priya");
  const rec = await finalize(j.documentId, "persona-daniel", null, async () => { throw new Error("warehouse down"); });
  assert.equal(rec.delta.status, "failed");
  assert.match(rec.delta.detail ?? "", /warehouse down/);
});

test("a GxP tenant refuses an untrained approver; listing is tenant-scoped", async () => {
  // Kenji is an approver in bu-japan but not GxP-trained; make a GxP job there.
  const t = store.tenants.find((x) => x.id === "bu-japan")!;
  const before = t.gxp;
  t.gxp = true;
  try {
    const j = job({ tenantId: "bu-japan", submittedBy: "persona-other", status: "pending-finalization",
      submittedAt: new Date().toISOString() });
    store.documentJobs.unshift(j);
    await assert.rejects(finalize(j.documentId, "persona-kenji", null, noPublish), (e: DocIntelError) => e.status === 403);
    assert.equal(listJobs("persona-priya").some((x) => x.tenantId === "bu-japan"), false);
  } finally {
    t.gxp = before;
  }
});

test("extraction runs in the background and drafts a review from the best method", async () => {
  const j = job({ status: "uploaded", methodRuns: [], review: undefined });
  store.documentJobs.unshift(j);
  const weaker: MethodRun = { ...RUN, method: "nova-lite", confidence: 0.4 };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  startRun({ documentId: j.documentId, personaId: "persona-priya", methods: ["nova-lite", "claude-haiku"] },
    async () => { await gate; return [weaker, RUN]; });
  assert.equal(j.status, "processing");
  assert.throws(() => startRun({ documentId: j.documentId, personaId: "persona-priya" }, async () => []), /already running/);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(j.status, "extracted");
  assert.equal(j.review?.selectedMethod, "claude-haiku");

  const k = job({ status: "uploaded", methodRuns: [], review: undefined });
  store.documentJobs.unshift(k);
  assert.throws(() => startRun({ documentId: k.documentId, personaId: "persona-sofia" }, async () => []),
    (e: DocIntelError) => e.status === 403, "a viewer cannot run extraction");
  startRun({ documentId: k.documentId, personaId: "persona-priya" }, async () => [{ ...RUN, status: "error", results: {}, error: "boom" }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(k.status, "failed");
  assert.match(k.runError ?? "", /boom/);
});
