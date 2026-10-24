// Offline tests for Document Types, validation and routing (P1-P3) and the
// quality analytics (P7). The IDP engine, Unity Catalog and Delta are stubbed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mapFieldsToSchema, meetsSpec, parseDate, parseNumber, parseSpec, validateReview,
} from "../src/lib/docintel/validation.ts";
import type { FieldSpec } from "../src/lib/docintel/validation.ts";
import {
  DocTypeError, availableTypes, checkSpec, classifyToType, createType, decideType, submitType, updateType,
} from "../src/lib/docintel/doctypes.ts";
import type { DocTypeSpec } from "../src/lib/docintel/doctypes.ts";
import {
  AUTO_FINALIZER, DocIntelError, finalize, saveReview, setMasterDataLookup, startRun, submitForFinalization,
} from "../src/lib/docintel/service.ts";
import { validateFinalizedDocument } from "../src/lib/docintel/contract.ts";
import { computeAnalytics } from "../src/lib/docintel/analytics.ts";
import type { DocumentJob, MethodRun } from "../src/lib/docintel/model.ts";
import { store } from "../src/lib/store.ts";

const approvedSuppliers = new Set(["acme lab supplies"]);
setMasterDataLookup(async (q) => approvedSuppliers.has(q.value.toLowerCase()));

const coaRun = (over: { result?: string; expiry?: string; conf?: number } = {}): MethodRun => ({
  method: "claude-sonnet", status: "complete", latencyMs: 9000, cost: 0.05, confidence: 0.96,
  results: {
    text_extraction: { data: "CERTIFICATE OF ANALYSIS ...", confidence: 0.96, format: "text" },
    kv_extraction: { data: {
      "Product": "Vonoprazan 20 mg", "Batch Number": "VF-24-0917", "Manufacturing Date": "2026-09-12",
      "Expiry Date": over.expiry ?? "2028-09-11", "Manufacturer": "Osaka Plant", "Conclusion": "Released",
    }, confidence: over.conf ?? 0.95, format: "json" },
    table_extraction: { data: `| Test | Specification | Result |\n|---|---|---|\n| Assay | 95.0 - 105.0 % | ${over.result ?? "99.4 %"} |\n| Water | NMT 3.0 % | 1.4 % |\n| Microbial | Complies with Ph. Eur. | Complies |`, confidence: 0.9, format: "markdown" },
    document_classification: { data: { documentType: "Certificate of Analysis" }, confidence: 0.97, format: "json" },
  },
});

const invoiceRun = (supplier = "ACME Lab Supplies", total = "745.00 USD"): MethodRun => ({
  method: "claude-haiku", status: "complete", latencyMs: 4000, cost: 0.005, confidence: 0.95,
  results: {
    text_extraction: { data: "INVOICE ...", confidence: 0.95, format: "text" },
    kv_extraction: { data: { company_name: supplier, invoice_number: "INV-1", invoice_date: "2026-10-20", total_due: total },
      confidence: 0.93, format: "json" },
    table_extraction: { data: "| Item | Amount |\n|---|---|\n| Tips | 125.00 |\n| Kit | 620.00 |", confidence: 0.9, format: "markdown" },
    document_classification: { data: { documentType: "invoice" }, confidence: 0.95, format: "json" },
  },
});

let n = 0;
function newJob(tenantId: string, createdBy: string, over: Partial<DocumentJob> = {}): DocumentJob {
  n += 1;
  const now = new Date().toISOString();
  const j: DocumentJob = {
    documentId: `doc-dt${n}x`, tenantId, createdBy, createdAt: now, updatedAt: now, fileName: `f${n}.pdf`,
    mimeType: "application/pdf", sizeBytes: 100, sha256: "c".repeat(64), idpDocumentId: "idp", idpRef: "local://x",
    status: "uploaded", capabilities: [], methodRuns: [], finalizedDocumentIds: [], ...over,
  };
  store.documentJobs.unshift(j);
  return j;
}
const noPublish = async () => ({ status: "skipped" as const, detail: "test" });
async function extract(j: DocumentJob, personaId: string, run: MethodRun) {
  startRun({ documentId: j.documentId, personaId }, async () => [run]);
  for (let i = 0; i < 50 && (j.status === "processing" || j.status === "uploaded"); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
}

// ---------------------------------------------------------------- parsers

test("numbers, dates and specifications parse the way documents write them", () => {
  assert.equal(parseNumber("1,234.50 USD"), 1234.5);
  assert.equal(parseNumber("1.234,50 €"), 1234.5);
  assert.equal(parseNumber("99.4 %"), 99.4);
  assert.equal(parseNumber("(12.00)"), -12);
  assert.equal(parseNumber("n/a"), null);
  assert.equal(parseDate("2026-09-12"), Date.UTC(2026, 8, 12));
  assert.equal(parseDate("12.09.2026"), Date.UTC(2026, 8, 12));
  assert.equal(parseDate("12 Sep 2026"), Date.UTC(2026, 8, 12));
  assert.equal(parseDate("Sep 12, 2026"), Date.UTC(2026, 8, 12));
  assert.equal(parseDate("soon"), null);
  assert.equal(meetsSpec(parseSpec("95.0 - 105.0 %")!, "99.4 %"), true);
  assert.equal(meetsSpec(parseSpec("95.0 - 105.0 %")!, "94.1 %"), false);
  assert.equal(meetsSpec(parseSpec("NLT 80 %")!, "92 %"), true);
  assert.equal(meetsSpec(parseSpec("NMT 0.5 %")!, "0.7 %"), false);
  assert.equal(meetsSpec(parseSpec("Complies with Ph. Eur.")!, "Complies"), true);
  assert.equal(meetsSpec(parseSpec("Complies with Ph. Eur.")!, "Does not comply"), false);
  assert.equal(parseSpec("see method"), null);
});

test("extracted field names map onto the schema via synonyms, keeping extras", () => {
  const schema: FieldSpec[] = [
    { name: "supplier_name", type: "text", required: true, synonyms: ["company name"] },
    { name: "total_due", type: "money", required: true, synonyms: ["total"] },
  ];
  const out = mapFieldsToSchema([
    { name: "Company Name", value: "ACME", edited: false },
    { name: "notes", value: "x", edited: false },
    { name: "total.amount", value: 5, edited: false },
    { name: "Total", value: 745, edited: false },
  ], schema);
  assert.deepEqual(out.map((f) => [f.name, f.value]), [["supplier_name", "ACME"], ["total_due", 745], ["notes", "x"], ["total.amount", 5]]);
});

// ---------------------------------------------------------------- rules

test("a CoA is clean in spec, and blocked out of spec or with reversed dates", async () => {
  const coa = store.documentTypes.find((t) => t.key === "certificate-of-analysis")!.published!.spec;
  const t = { fields: coa.fields, rules: coa.rules, minConfidence: coa.routing.minConfidence };
  const review = (fields: Record<string, unknown>, result = "99.4 %") => ({
    fields: Object.entries(fields).map(([name, value]) => ({ name, value, confidence: 0.95, edited: false })),
    tables: [{ columns: ["Test", "Specification", "Result"], rows: [["Assay", "95.0 - 105.0 %", result]] }],
  });
  const good = { product: "P", batch_number: "VF-24-0917", manufacturing_date: "2026-09-12", expiry_date: "2028-09-11", conclusion: "Released" };
  const ok = await validateReview(review(good), t);
  assert.equal(ok.clean, true, JSON.stringify(ok.issues));

  const oos = await validateReview(review(good, "94.1 %"), t);
  assert.equal(oos.clean, false);
  assert.match(oos.issues.find((i) => i.ruleId === "coa-spec")!.message, /Assay: result 94.1 % is out of specification/);

  const dates = await validateReview(review({ ...good, expiry_date: "2025-01-01" }), t);
  assert.ok(dates.issues.some((i) => i.ruleId === "coa-dates" && i.severity === "block"));

  const missing = await validateReview(review({ ...good, batch_number: "" }), t);
  assert.ok(missing.issues.some((i) => i.ruleId === "required:batch_number"));
  assert.equal(missing.requiredPresent, missing.requiredTotal - 1);

  const bad = await validateReview(review({ ...good, batch_number: "vf 24" }), t);
  assert.ok(bad.issues.some((i) => i.ruleId === "pattern:batch_number"));
});

test("invoice line items must add up and the supplier must be approved; lookup failures warn", async () => {
  const inv = store.documentTypes.find((t) => t.key === "supplier-invoice")!.published!.spec;
  const t = { fields: inv.fields, rules: inv.rules, minConfidence: 0.8 };
  const review = (supplier: string, total: string) => ({
    fields: [
      { name: "supplier_name", value: supplier, confidence: 0.9, edited: false },
      { name: "invoice_number", value: "INV-1", confidence: 0.9, edited: false },
      { name: "invoice_date", value: "2026-10-20", confidence: 0.9, edited: false },
      { name: "total_due", value: total, confidence: 0.9, edited: false },
    ],
    tables: [{ columns: ["Item", "Amount"], rows: [["a", "125.00"], ["b", "620.00"]] }],
  });
  const lookup = async (q: { value: string }) => approvedSuppliers.has(q.value.toLowerCase());
  assert.equal((await validateReview(review("ACME Lab Supplies", "745.00 USD"), t, lookup)).clean, true);
  const sum = await validateReview(review("ACME Lab Supplies", "800.00"), t, lookup);
  assert.match(sum.issues.find((i) => i.ruleId === "inv-sum")!.message, /add up to 745.00 but total_due is 800.00/);
  const sup = await validateReview(review("Initech Labware", "745.00"), t, lookup);
  assert.ok(sup.issues.some((i) => i.ruleId === "inv-supplier" && i.severity === "block"));
  const down = await validateReview(review("ACME Lab Supplies", "745.00"), t, async () => { throw new Error("warehouse down"); });
  assert.equal(down.clean, false);
  assert.ok(down.issues.some((i) => i.severity === "warn" && /unavailable/.test(i.message)));
  assert.ok(down.skipped.includes("inv-supplier"));
});

test("low machine confidence needs a person; a confirmed (edited) value does not", async () => {
  const fields: FieldSpec[] = [{ name: "a", type: "text", required: true }];
  const low = await validateReview({ fields: [{ name: "a", value: "x", confidence: 0.5, edited: false }], tables: [] },
    { fields, rules: [], minConfidence: 0.8 });
  assert.equal(low.clean, false);
  assert.deepEqual(low.lowConfidence, ["a"]);
  const confirmed = await validateReview({ fields: [{ name: "a", value: "x", confidence: 0.5, edited: true, originalValue: "y" }], tables: [] },
    { fields, rules: [], minConfidence: 0.8 });
  assert.equal(confirmed.clean, true);
});

// ---------------------------------------------------------------- types

test("type specs are checked, classification finds the type, and types inherit down the tree", () => {
  assert.ok(checkSpec({ name: "", description: "", classifierHints: [], fields: [], rules: [], methods: [], capabilities: [],
    routing: { minConfidence: 2, straightThrough: false, autoFinalize: false } }).length >= 4);
  const bad: DocTypeSpec = JSON.parse(JSON.stringify(store.documentTypes[0].draft));
  bad.rules = [{ id: "x", kind: "master_data", field: "product", table: "drop table; --", column: "name", severity: "block" }];
  assert.ok(checkSpec(bad).some((e) => /catalog\.schema\.table/.test(e)), "master-data identifiers are validated");
  const avail = availableTypes("fn-rnd");
  assert.deepEqual(new Set(avail.map((t) => t.key)), new Set(["certificate-of-analysis", "supplier-invoice"]), "org-root types reach a BF");
  assert.equal(classifyToType("Certificate of Analysis", avail)?.key, "certificate-of-analysis");
  assert.equal(classifyToType("Tax Invoice", avail)?.key, "supplier-invoice");
  assert.equal(classifyToType("Guide / Reference Book", avail), undefined);
});

test("a type is drafted, four-eyes approved as v1, edited without disturbing v1, then v2", () => {
  const spec: DocTypeSpec = {
    name: "Deviation report", description: "QA deviation", classifierHints: ["deviation"],
    fields: [{ name: "deviation_id", type: "text", required: true }], rules: [],
    methods: ["claude-sonnet"], capabilities: ["kv_extraction"], routing: { minConfidence: 0.9, straightThrough: false, autoFinalize: false },
  };
  assert.throws(() => createType({ tenantId: "fn-rnd", personaId: "persona-sofia", key: "deviation-report", spec }),
    (e: DocTypeError) => e.status === 403);
  const t = createType({ tenantId: "fn-rnd", personaId: "persona-priya", key: "deviation-report", spec });
  assert.equal(availableTypes("fn-rnd").some((x) => x.id === t.id), false, "a draft is not usable");
  submitType(t.id, "persona-priya");
  assert.throws(() => decideType(t.id, "persona-priya", "approve"), (e: DocTypeError) => e.code === "SELF_REVIEW");
  decideType(t.id, "persona-daniel", "approve");
  assert.equal(t.published?.version, 1);
  assert.ok(availableTypes("fn-rnd").some((x) => x.id === t.id));
  assert.equal(availableTypes("fn-supply").some((x) => x.id === t.id), false, "a sibling BF does not inherit it");

  updateType(t.id, "persona-priya", { ...spec, fields: [...spec.fields, { name: "severity", type: "enum", required: true, allowed: ["minor", "major", "critical"] }] });
  assert.equal(t.status, "Draft");
  assert.equal(t.published?.spec.fields.length, 1, "published v1 is unchanged by a draft edit");
  submitType(t.id, "persona-priya");
  decideType(t.id, "persona-daniel", "approve");
  assert.equal(t.published?.version, 2);
  assert.equal(t.published?.spec.fields.length, 2);
});

// ---------------------------------------------------------------- routing

test("a clean CoA in a GxP tenant goes straight through to a human finalizer", async () => {
  const j = newJob("fn-rnd", "persona-priya");
  await extract(j, "persona-priya", coaRun());
  assert.equal(j.documentTypeId, "dt-seed-coa");
  assert.equal(j.typeSource, "detected");
  assert.equal(j.validation?.clean, true, JSON.stringify(j.validation?.issues));
  assert.equal(j.route, "straight-through");
  assert.equal(j.status, "pending-finalization", "GxP: never auto-finalized");
  assert.equal(j.submittedBy, "persona-priya");
  assert.deepEqual(j.review!.fields.slice(0, 2).map((f) => f.name), ["product", "batch_number"]);
  const rec = await finalize(j.documentId, "persona-daniel", null, noPublish);
  assert.deepEqual(validateFinalizedDocument(rec.doc), []);
  assert.deepEqual(rec.doc.documentType, { id: "dt-seed-coa", key: "certificate-of-analysis", name: "Certificate of Analysis", version: 1 });
  assert.equal(rec.doc.validation?.route, "straight-through");
  assert.equal(rec.doc.validation?.clean, true);
});

test("an out-of-spec CoA is an exception; submitting needs a justification that is recorded", async () => {
  const j = newJob("fn-rnd", "persona-priya");
  await extract(j, "persona-priya", coaRun({ result: "94.1 %" }));
  assert.equal(j.route, "exception");
  assert.equal(j.status, "extracted");
  await assert.rejects(submitForFinalization(j.documentId, "persona-priya"), (e: DocIntelError) => e.code === "VALIDATION_BLOCKED" && e.status === 422);
  await assert.rejects(submitForFinalization(j.documentId, "persona-priya", "ok"), /justification/);
  await submitForFinalization(j.documentId, "persona-priya", "OOS investigation QA-123 closed; retest result attached");
  assert.equal(j.override?.by, "persona-priya");
  const rec = await finalize(j.documentId, "persona-daniel", null, noPublish);
  assert.deepEqual(validateFinalizedDocument(rec.doc), []);
  assert.equal(rec.doc.validation?.route, "exception");
  assert.match(rec.doc.validation?.override?.justification ?? "", /QA-123/);
  assert.ok(rec.doc.validation?.issues.some((i) => i.ruleId === "coa-spec"));
});

test("fixing the value in review clears the block; a chosen type drives the methods", async () => {
  const j = newJob("fn-rnd", "persona-priya", { documentTypeId: "dt-seed-coa", documentTypeVersion: 1, typeSource: "chosen" });
  let seenMethods: string[] = [];
  startRun({ documentId: j.documentId, personaId: "persona-priya" }, async (input) => { seenMethods = input.methods; return [coaRun({ expiry: "2020-01-01" })]; });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seenMethods, ["claude-sonnet", "claude-haiku"], "the type's methods");
  assert.equal(j.route, "exception");
  await saveReview({ documentId: j.documentId, personaId: "persona-priya",
    edits: { fields: j.review!.fields.map((f) => (f.name === "expiry_date" ? { ...f, value: "2028-09-11" } : f)) } });
  assert.equal(j.validation?.issues.length, 0);
  await submitForFinalization(j.documentId, "persona-priya");
  assert.equal(j.override, undefined);
  assert.equal(j.route, "exception", "it was an exception; STP numbers stay honest");
});

test("a clean invoice in a non-GxP tenant is auto-finalized; an unapproved supplier is not", async () => {
  // fn-procurement is not GxP-regulated; Omar is an approver there.
  const j = newJob("fn-procurement", "persona-omar");
  await extract(j, "persona-omar", invoiceRun());
  assert.equal(j.route, "auto-finalized");
  assert.equal(j.status, "finalized");
  const rec = store.finalizedDocuments.find((r) => r.doc.documentId === j.documentId)!;
  assert.equal(rec.doc.provenance.finalizedBy.personaId, AUTO_FINALIZER.id);
  assert.equal(rec.doc.provenance.submittedBy.personaId, "persona-omar");
  assert.match(rec.doc.provenance.reviewNote ?? "", /Supplier invoice' v1/);
  assert.deepEqual(validateFinalizedDocument(rec.doc), []);

  const k = newJob("fn-procurement", "persona-omar");
  await extract(k, "persona-omar", invoiceRun("Initech Labware"));
  assert.equal(k.route, "exception");
  assert.equal(k.status, "extracted");

  const g = newJob("fn-supply", "persona-lena");
  await extract(g, "persona-lena", invoiceRun());
  assert.equal(g.route, "straight-through");
  assert.equal(g.status, "pending-finalization", "fn-supply is GxP: a person finalizes");
});

// ---------------------------------------------------------------- analytics

test("analytics report STP, corrections, exceptions and method quality from stored data", () => {
  const jobs = store.documentJobs.filter((j) => j.documentId.startsWith("doc-dt"));
  const ids = new Set(jobs.map((j) => j.documentId));
  const fds = store.finalizedDocuments.filter((r) => ids.has(r.doc.documentId)).map((r) => r.doc);
  const name = (id?: string) => (id ? store.documentTypes.find((t) => t.id === id)?.draft.name ?? id : "(no type)");
  const a = computeAnalytics(jobs, fds, name);
  const coa = a.byType.find((t) => t.documentType === "Certificate of Analysis")!;
  assert.equal(coa.finalized, 2);
  assert.equal(coa.straightThrough, 1);
  assert.equal(coa.stpRate, 0.5);
  assert.equal(coa.overrides, 1);
  const inv = a.byType.find((t) => t.documentType === "Supplier invoice")!;
  assert.equal(inv.autoFinalized, 1);
  assert.equal(inv.exceptions, 1);
  assert.ok(a.byMethod.some((m) => m.method === "claude-sonnet" && m.runs >= 3 && m.successRate === 1));
  assert.ok(a.topIssues.some((i) => i.ruleId === "coa-spec"));
  assert.ok(a.totals.exceptionsOpen >= 1);
  assert.ok(a.totals.totalCostUsd > 0);
});
