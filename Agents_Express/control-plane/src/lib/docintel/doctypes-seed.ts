// Seeded Document Types, published at the org root so every BU / BF inherits
// them. Kept free of runtime imports: the store calls this while it boots.

import type { DocTypeSpec, DocumentType } from "./doctypes";


export const REFERENCE_SUPPLIERS_TABLE = "workspace.idp_reference.suppliers";

export function seedDocumentTypes(at: string): DocumentType[] {
  const coa: DocTypeSpec = {
    name: "Certificate of Analysis",
    description: "Batch release certificate: product, batch, dates, and test results against specification.",
    classifierHints: ["certificate of analysis", "coa", "analysis certificate", "batch certificate"],
    fields: [
      { name: "product", label: "Product", type: "text", required: true, synonyms: ["product name", "material", "item"] },
      { name: "batch_number", label: "Batch number", type: "text", required: true, pattern: "^[A-Z0-9][A-Z0-9-]{2,}$",
        synonyms: ["batch", "batch no", "lot", "lot number", "batch id"] },
      { name: "manufacturing_date", label: "Manufacturing date", type: "date", required: true,
        synonyms: ["mfg date", "date of manufacture", "manufacture date", "production date"] },
      { name: "expiry_date", label: "Expiry date", type: "date", required: true,
        synonyms: ["exp date", "expiration date", "retest date", "use by"] },
      { name: "manufacturer", label: "Manufacturer", type: "text", required: false, synonyms: ["manufactured by", "site", "supplier"] },
      { name: "conclusion", label: "Conclusion", type: "text", required: true, synonyms: ["result", "disposition", "release decision", "statement"] },
    ],
    rules: [
      { id: "coa-dates", kind: "date_order", earlier: "manufacturing_date", later: "expiry_date", severity: "block" },
      { id: "coa-spec", kind: "spec_within", specColumn: "spec", resultColumn: "result", labelColumn: "test", severity: "block" },
    ],
    methods: ["claude-sonnet", "claude-haiku"],
    capabilities: ["text_extraction", "kv_extraction", "table_extraction", "document_classification"],
    routing: { minConfidence: 0.85, straightThrough: true, autoFinalize: false },
    ragPattern: "structured-fields",
  };
  const invoice: DocTypeSpec = {
    name: "Supplier invoice",
    description: "Invoice from an external supplier: identity, amounts and terms; supplier must be approved.",
    classifierHints: ["invoice", "bill", "tax invoice"],
    fields: [
      { name: "supplier_name", label: "Supplier", type: "text", required: true,
        synonyms: ["company name", "vendor", "seller", "supplier", "from", "company"] },
      { name: "invoice_number", label: "Invoice number", type: "text", required: true, synonyms: ["invoice no", "invoice #", "invoice id"] },
      { name: "invoice_date", label: "Invoice date", type: "date", required: true, synonyms: ["date", "issue date"] },
      { name: "total_due", label: "Total due", type: "money", required: true,
        synonyms: ["total", "amount due", "total amount", "grand total", "balance due"] },
      { name: "payment_terms", label: "Payment terms", type: "text", required: false, synonyms: ["terms"] },
      { name: "bill_to", label: "Bill to", type: "text", required: false, synonyms: ["customer", "billed to", "buyer"] },
    ],
    rules: [
      { id: "inv-sum", kind: "sum_equals", column: "amount", total: "total_due", tolerance: 0.01, severity: "block" },
      { id: "inv-supplier", kind: "master_data", field: "supplier_name", table: REFERENCE_SUPPLIERS_TABLE, column: "name",
        statusColumn: "status", statusValue: "approved", severity: "block" },
    ],
    methods: ["claude-haiku", "claude-sonnet"],
    capabilities: ["text_extraction", "kv_extraction", "table_extraction", "document_classification", "pii_detection"],
    routing: { minConfidence: 0.8, straightThrough: true, autoFinalize: true },
    ragPattern: "structured-fields",
  };
  return [coa, invoice].map((spec, i) => ({
    id: i === 0 ? "dt-seed-coa" : "dt-seed-invoice",
    key: i === 0 ? "certificate-of-analysis" : "supplier-invoice",
    tenantId: "takeda",
    createdBy: "platform-team",
    createdAt: at,
    updatedAt: at,
    draft: spec,
    status: "Published" as const,
    published: { version: 1, spec, submittedBy: "platform-team", approvedBy: "platform-team (seed)", approvedAt: at },
    history: [{ version: 1, approvedBy: "platform-team (seed)", approvedAt: at }],
  }));
}
