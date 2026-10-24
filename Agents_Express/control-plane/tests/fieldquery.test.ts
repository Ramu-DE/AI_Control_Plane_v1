// Exact answers over finalized fields and tables (lib/ragfactory/fieldQuery.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

import { PlanError, checkPlan, corpusVocabulary, executePlan, requestedUnitMissing } from "../src/lib/ragfactory/fieldQuery.ts";
import type { FinalizedDocument } from "../src/lib/docintel/contract.ts";

function doc(id: string, docType: string, fields: Record<string, unknown>, tables: FinalizedDocument["content"]["tables"] = []): FinalizedDocument {
  return {
    schemaVersion: "finalized-document/v1", finalizedDocumentId: `fd-${id}`, version: 1, tenantId: "fn-rnd", documentId: `doc-${id}`,
    source: { fileName: `${id}.pdf`, mimeType: "application/pdf", sizeBytes: 1, sha256: "a".repeat(64) },
    classification: { docType, gxp: true, region: null },
    content: { text: "", fields: Object.entries(fields).map(([name, value]) => ({ name, value, edited: false })), tables },
    pii: { redaction: "none-detected", detected: [] },
    provenance: { methodsRun: [{ method: "m", status: "complete" }], selectedMethod: "m", capabilities: [],
      submittedBy: { personaId: "a", name: "A" }, submittedAt: "2026-10-24T00:00:00Z",
      finalizedBy: { personaId: "b", name: "B" }, finalizedAt: "2026-10-24T01:00:00Z" },
    contentSha256: "b".repeat(64),
  };
}

const results = (assay: string) => [{ columns: ["Test", "Specification", "Result"], rows: [
  ["Assay (HPLC)", "95.0 - 105.0 %", assay], ["Water content (KF)", "NMT 3.0 %", "1.4 %"], ["Appearance", "see method", "white"]] }];
const DOCS = [
  doc("c1", "Certificate of Analysis", { batch_number: "VF-24-0917", product: "Vonoprazan" }, results("99.4 %")),
  doc("c2", "Certificate of Analysis", { batch_number: "VF-24-0933", product: "Vonoprazan" }, results("94.1 %")),
  doc("i1", "Supplier invoice", { supplier_name: "ACME Lab Supplies", total_due: "745.00 USD" }),
  doc("i2", "Supplier invoice", { supplier_name: "Initech Labware", total_due: "200.00 USD" }),
];

test("a field lookup by identifier is exact and cited", () => {
  const r = executePlan({ documentFilters: [{ field: "batch_number", op: "eq", value: "vf 24 0917" }], select: { type: "fields", fields: ["product"] } }, DOCS);
  assert.equal(r.rows.length, 1);
  assert.match(r.answer, /fd-c1 v1\): product = Vonoprazan/);
  assert.deepEqual(r.citations.map((c) => c.ref), ["field product"]);
});

test("out-of-specification rows are computed, not read by a model; negation handled", () => {
  const oos = executePlan({ documentFilters: [], select: { type: "table_rows", spec: "out_of_spec" } }, DOCS);
  assert.equal(oos.rows.length, 1);
  assert.match(oos.answer, /fd-c2 v1\), table 1 row 1: Test = Assay \(HPLC\).*Result = 94.1 %/);
  assert.match(oos.answer, /could not be evaluated automatically/, "unparseable specs are disclosed, not hidden");
  const none = executePlan({ documentFilters: [{ field: "batch_number", op: "eq", value: "VF-24-0917" }],
    select: { type: "table_rows", spec: "out_of_spec" } }, DOCS);
  assert.equal(none.empty, true);
  assert.match(none.answer, /all 2 evaluated test\(s\) are within specification; 1 row\(s\) could not be evaluated/);
});

test("counts, aggregates and lists over fields", () => {
  assert.match(executePlan({ documentFilters: [{ field: "docType", op: "eq", value: "Supplier invoice" }], select: { type: "count" } }, DOCS).answer, /^2 finalized/);
  assert.match(executePlan({ documentFilters: [{ field: "docType", op: "eq", value: "supplier invoice" }],
    select: { type: "aggregate", fn: "sum", field: "total_due" } }, DOCS).answer, /= 945\./);
  assert.match(executePlan({ documentFilters: [{ field: "total_due", op: "gt", value: "500" }], select: { type: "list_documents" } }, DOCS).answer, /i1\.pdf/);
});

test("nothing matching says so instead of guessing; unknown names are refused", () => {
  const r = executePlan({ documentFilters: [{ field: "batch_number", op: "eq", value: "XX-00-0000" }], select: { type: "fields", fields: ["product"] } }, DOCS);
  assert.equal(r.empty, true);
  assert.match(r.answer, /^No finalized document in this corpus matching batch_number eq "XX-00-0000" was found\.$/);
  assert.deepEqual(checkPlan({ documentFilters: [{ field: "lot", op: "eq", value: "1" }], select: { type: "fields", fields: ["colour"] } }, DOCS),
    ["unknown field 'lot'", "unknown field 'colour'"]);
  assert.throws(() => executePlan({ documentFilters: [], select: { type: "aggregate", fn: "sum", field: "nope" } }, DOCS), PlanError);
});

test("the planner sees names, never values", () => {
  const v = corpusVocabulary(DOCS);
  assert.deepEqual(v.fields["Certificate of Analysis"], ["batch_number", "product"]);
  assert.ok(!JSON.stringify(v).includes("VF-24-0917"));
});

test("a question in another currency is refused, not answered with the wrong currency", () => {
  assert.match(requestedUnitMissing("price of the reagent kit in euros?", "Unit Price = 310.00, Amount = 620.00 USD") ?? "", /not state this in EUR \(the values are in USD/);
  assert.match(requestedUnitMissing("price in €?", "Unit Price = 310.00") ?? "", /no currency is stated/);
  assert.equal(requestedUnitMissing("total due in USD?", "total_due = 745.00 USD"), null);
  assert.equal(requestedUnitMissing("what is the total due?", "total_due = 745.00 USD"), null);
});
