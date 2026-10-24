// Publish finalized documents to Databricks Delta — the shared, governed
// landing zone the RAG Factory and graph-utility read from.
//
//   <catalog>.idp_gold.finalized_documents
//     one row per (finalized_document_id) — every version is its own row,
//     never overwritten; `tenant_id` on every row so Unity Catalog row filters
//     can enforce tenant isolation for downstream readers.
//
// Only this module writes, only finalized documents, only parameterised
// statements (values never interpolated into SQL). Catalog and schema come
// from the environment and are validated as identifiers.

import { databricksRequest, resolveWarehouseId } from "../tools/uc";
import type { FinalizedDocument } from "./contract";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function deltaTarget(): { catalog: string; schema: string; table: string } | null {
  if (!process.env.DATABRICKS_HOST || !process.env.DATABRICKS_TOKEN) return null;
  const catalog = process.env.DOCINTEL_DELTA_CATALOG || "workspace";
  const schema = process.env.DOCINTEL_DELTA_SCHEMA || "idp_gold";
  if (!IDENT.test(catalog) || !IDENT.test(schema)) return null;
  return { catalog, schema, table: `${catalog}.${schema}.finalized_documents` };
}

type Param = { name: string; value: string | null; type?: string };

async function statement(sql: string, parameters: Param[] = []): Promise<void> {
  const warehouse = await resolveWarehouseId();
  const res = await databricksRequest("/api/2.0/sql/statements", {
    method: "POST",
    body: { warehouse_id: warehouse, statement: sql, parameters, wait_timeout: "50s" },
  });
  const status = (res.status as Record<string, unknown>) ?? {};
  if (status.state !== "SUCCEEDED") {
    const msg = ((status.error as Record<string, unknown>) ?? {}).message;
    throw new Error(`Delta statement ${String(status.state)}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`);
  }
}

let ensured = false;

/** Create the schema and table once per process (idempotent DDL). */
async function ensureTable(t: { catalog: string; schema: string; table: string }) {
  if (ensured) return;
  await statement(`CREATE SCHEMA IF NOT EXISTS ${t.catalog}.${t.schema}`);
  await statement(
    `CREATE TABLE IF NOT EXISTS ${t.table} (
       finalized_document_id STRING NOT NULL,
       version INT NOT NULL,
       supersedes STRING,
       tenant_id STRING NOT NULL,
       document_id STRING NOT NULL,
       doc_type STRING,
       gxp BOOLEAN,
       region STRING,
       source_file_name STRING,
       source_sha256 STRING,
       content_sha256 STRING NOT NULL,
       field_count INT,
       table_count INT,
       pii_redaction STRING,
       selected_method STRING,
       submitted_by STRING,
       finalized_by STRING,
       finalized_at TIMESTAMP,
       document_json STRING NOT NULL,
       published_at TIMESTAMP
     ) USING DELTA
     COMMENT 'FinalizedDocument v1 records published by the AI Control Plane (one row per version)'
     TBLPROPERTIES (delta.enableChangeDataFeed = true)`
  );
  ensured = true;
}

/** MERGE one finalized version (idempotent on finalized_document_id). */
export async function publishToDelta(doc: FinalizedDocument): Promise<{ status: "written" | "skipped"; detail: string }> {
  const t = deltaTarget();
  if (!t) return { status: "skipped", detail: "Databricks not configured (DATABRICKS_HOST / DATABRICKS_TOKEN)" };
  await ensureTable(t);
  const p = (name: string, value: string | number | boolean | null, type = "STRING"): Param => ({
    name, value: value === null || value === undefined ? null : String(value), type,
  });
  await statement(
    `MERGE INTO ${t.table} AS d
     USING (SELECT :fid AS finalized_document_id) AS s
     ON d.finalized_document_id = s.finalized_document_id
     WHEN NOT MATCHED THEN INSERT (
       finalized_document_id, version, supersedes, tenant_id, document_id, doc_type, gxp, region,
       source_file_name, source_sha256, content_sha256, field_count, table_count, pii_redaction,
       selected_method, submitted_by, finalized_by, finalized_at, document_json, published_at)
     VALUES (:fid, :version, :supersedes, :tenant, :doc, :doc_type, :gxp, :region,
       :file, :src_sha, :content_sha, :field_count, :table_count, :pii,
       :method, :submitted_by, :finalized_by, CAST(:finalized_at AS TIMESTAMP), :json, current_timestamp())`,
    [
      p("fid", doc.finalizedDocumentId),
      p("version", doc.version, "INT"),
      p("supersedes", doc.supersedes ?? null),
      p("tenant", doc.tenantId),
      p("doc", doc.documentId),
      p("doc_type", doc.classification.docType),
      p("gxp", doc.classification.gxp, "BOOLEAN"),
      p("region", doc.classification.region),
      p("file", doc.source.fileName),
      p("src_sha", doc.source.sha256),
      p("content_sha", doc.contentSha256),
      p("field_count", doc.content.fields.length, "INT"),
      p("table_count", doc.content.tables.length, "INT"),
      p("pii", doc.pii.redaction),
      p("method", doc.provenance.selectedMethod),
      p("submitted_by", doc.provenance.submittedBy.personaId),
      p("finalized_by", doc.provenance.finalizedBy.personaId),
      p("finalized_at", doc.provenance.finalizedAt),
      p("json", JSON.stringify(doc)),
    ]
  );
  return { status: "written", detail: `${t.table} (${doc.finalizedDocumentId})` };
}
