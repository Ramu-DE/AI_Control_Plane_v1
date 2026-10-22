// Unity Catalog tools — the platform's first REAL tool implementations.
//
// Until now an agent's `toolRefs` were metadata: names were resolved and
// explicitly reported as "NOT invoked". These three tools are genuinely
// executed against Databricks, read-only:
//
//   uc_list_tables(catalog, schema)   -> UC REST: /api/2.1/unity-catalog/tables
//   uc_describe_table(full_name)      -> UC REST: single table + columns
//   uc_query(sql)                     -> SQL Statements API, READ-ONLY guarded
//
// SECURITY
//  - Credentials are resolved from the environment by reference
//    (DATABRICKS_HOST / DATABRICKS_TOKEN); never stored on a record.
//  - `uc_query` accepts only read statements (SELECT/SHOW/DESCRIBE/WITH/EXPLAIN)
//    and rejects anything else, so a model cannot mutate the lakehouse.
//  - Every result is row- and byte-capped before it reaches a prompt.
//  - The host is validated against the shared SSRF policy.

import { validateOutboundUrl } from "../graph/logic";

export class UcToolError extends Error {
  readonly code = "UC_TOOL";
  constructor(message: string) {
    super(message);
    this.name = "UcToolError";
  }
}

const MAX_ROWS = 50;
const MAX_TABLES = 200;
const MAX_BYTES = 256 * 1024;

/** Statements the query tool is allowed to run. Anything else is refused. */
const READ_ONLY_PREFIXES = ["SELECT", "SHOW", "DESCRIBE", "DESC", "WITH", "EXPLAIN"];

/** Clauses that must never appear, even nested in a read statement. */
const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "DROP", "CREATE", "ALTER", "TRUNCATE",
  "GRANT", "REVOKE", "COPY", "REFRESH", "OPTIMIZE", "VACUUM", "RESTORE",
];

export function isReadOnlySql(sql: string): boolean {
  const trimmed = (sql || "").trim().replace(/;+\s*$/, "");
  if (!trimmed) return false;
  // Reject multiple statements outright — one read per call.
  if (trimmed.includes(";")) return false;
  const upper = trimmed.toUpperCase();
  if (!READ_ONLY_PREFIXES.some((p) => upper.startsWith(p))) return false;
  for (const kw of FORBIDDEN) {
    if (new RegExp(`(^|[^A-Z_])${kw}([^A-Z_]|$)`).test(upper)) return false;
  }
  return true;
}

function host(): string {
  const raw = (process.env.DATABRICKS_HOST || "").trim().replace(/\/+$/, "");
  if (!raw) throw new UcToolError("DATABRICKS_HOST is not set in the server environment");
  const policy = validateOutboundUrl(raw);
  if (!policy.ok) throw new UcToolError(`DATABRICKS_HOST rejected: ${policy.reason}`);
  return raw;
}

function token(): string {
  const value = process.env.DATABRICKS_TOKEN;
  if (!value || value === "REPLACE_ME") {
    throw new UcToolError("DATABRICKS_TOKEN is not set in the server environment");
  }
  return value;
}

async function dbx(path: string, init?: { method?: string; body?: unknown }) {
  const url = `${host()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    throw new UcToolError(`could not reach Databricks: ${cause ?? (e as Error).message}`);
  }
  const text = (await res.text()).slice(0, MAX_BYTES);
  if (!res.ok) {
    throw new UcToolError(`Databricks ${path} returned HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new UcToolError(`Databricks ${path} returned a non-JSON response`);
  }
}

// --------------------------------------------------------------------------- //
// Warehouse resolution (needed only by uc_query)
// --------------------------------------------------------------------------- //

let _warehouseId: string | null = null;

/**
 * Resolve a SQL warehouse: the configured one, else the first one the
 * workspace exposes. Cached for the process.
 */
export async function resolveWarehouseId(): Promise<string> {
  const configured = (process.env.DATABRICKS_WAREHOUSE_ID || "").trim();
  if (configured) return configured;
  if (_warehouseId) return _warehouseId;
  const res = await dbx("/api/2.0/sql/warehouses");
  const list = (res.warehouses as Record<string, unknown>[]) ?? [];
  if (list.length === 0) {
    throw new UcToolError(
      "no SQL warehouse available; set DATABRICKS_WAREHOUSE_ID or create one"
    );
  }
  _warehouseId = String(list[0].id);
  return _warehouseId;
}

// --------------------------------------------------------------------------- //
// The tools
// --------------------------------------------------------------------------- //

export interface UcTable {
  fullName: string;
  tableType: string;
  comment?: string;
  columns: string[];
}

/** List tables in a UC schema. Read-only. */
export async function ucListTables(catalog: string, schema: string): Promise<{
  catalog: string;
  schema: string;
  tableCount: number;
  tables: UcTable[];
}> {
  if (!catalog?.trim() || !schema?.trim()) {
    throw new UcToolError("uc_list_tables requires both 'catalog' and 'schema'");
  }
  const res = await dbx(
    `/api/2.1/unity-catalog/tables?catalog_name=${encodeURIComponent(catalog)}` +
      `&schema_name=${encodeURIComponent(schema)}`
  );
  const raw = ((res.tables as Record<string, unknown>[]) ?? []).slice(0, MAX_TABLES);
  return {
    catalog,
    schema,
    tableCount: raw.length,
    tables: raw.map((t) => ({
      fullName: String(t.full_name ?? ""),
      tableType: String(t.table_type ?? "UNKNOWN"),
      ...(t.comment ? { comment: String(t.comment) } : {}),
      columns: ((t.columns as Record<string, unknown>[]) ?? []).map(
        (c) => `${c.name}:${c.type_name}`
      ),
    })),
  };
}

/** Describe one table (columns + types + comment). Read-only. */
export async function ucDescribeTable(fullName: string): Promise<Record<string, unknown>> {
  if (!fullName?.trim() || fullName.split(".").length !== 3) {
    throw new UcToolError("uc_describe_table requires a 3-part name: catalog.schema.table");
  }
  const res = await dbx(`/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`);
  const cols = ((res.columns as Record<string, unknown>[]) ?? []).map((c) => ({
    name: c.name,
    type: c.type_name,
    nullable: c.nullable,
    comment: c.comment,
  }));
  return {
    fullName: res.full_name,
    tableType: res.table_type,
    comment: res.comment ?? null,
    columnCount: cols.length,
    columns: cols,
  };
}

/** Run a READ-ONLY SQL statement on a warehouse. Rows are capped. */
export async function ucQuery(sql: string): Promise<{
  sql: string;
  columns: string[];
  rowCount: number;
  rows: unknown[][];
  truncated: boolean;
  rowLimit: number;
  note?: string;
}> {
  if (!isReadOnlySql(sql)) {
    throw new UcToolError(
      "uc_query accepts a single read-only statement only " +
        "(SELECT / SHOW / DESCRIBE / WITH / EXPLAIN); writes and DDL are refused"
    );
  }
  const warehouseId = await resolveWarehouseId();
  const res = await dbx("/api/2.0/sql/statements", {
    method: "POST",
    body: {
      warehouse_id: warehouseId,
      statement: sql.trim(),
      wait_timeout: "50s",
      // Cap server-side as well as client-side.
      row_limit: MAX_ROWS,
    },
  });
  const status = (res.status as Record<string, unknown>) ?? {};
  if (status.state !== "SUCCEEDED") {
    const msg = ((status.error as Record<string, unknown>) ?? {}).message;
    throw new UcToolError(
      `query ${String(status.state)}${msg ? `: ${String(msg).slice(0, 240)}` : ""}`
    );
  }
  const manifest = (res.manifest as Record<string, unknown>) ?? {};
  const schema = (manifest.schema as Record<string, unknown>) ?? {};
  const columns = (((schema.columns as Record<string, unknown>[]) ?? []).map((c) =>
    String(c.name)
  ));
  const result = (res.result as Record<string, unknown>) ?? {};
  const all = (result.data_array as unknown[][]) ?? [];
  return {
    sql: sql.trim(),
    columns,
    ...interpretRows(all, manifest),
  };
}

/**
 * Decide what the model is told about completeness. PURE, so it is testable
 * without a warehouse — which is precisely why the original bug survived.
 *
 * TRUNCATION MUST BE VISIBLE. `row_limit` is sent to Databricks, so the
 * warehouse has ALREADY capped the result before it arrives here. Comparing
 * what arrived against our own cap therefore always said "not truncated": a
 * 376-row result came back as 50 rows with `truncated: false`, and an agent
 * reading that answers as though it had seen everything. Verified against a
 * live warehouse.
 *
 * The authority is `manifest.truncated`, which the API sets when it applied the
 * cap. The local length comparison is kept only as a backstop for a backend
 * that ignores `row_limit`.
 */
export function interpretRows(
  all: unknown[][],
  manifest: Record<string, unknown>
): {
  rowCount: number;
  rows: unknown[][];
  truncated: boolean;
  rowLimit: number;
  note?: string;
} {
  const rows = all.slice(0, MAX_ROWS);
  const truncated = manifest.truncated === true || all.length > rows.length;
  return {
    rowCount: rows.length,
    rows,
    truncated,
    rowLimit: MAX_ROWS,
    // A flag alone leaves the model stuck. Give it the route back to a
    // complete answer: aggregate, or narrow the filter.
    ...(truncated
      ? {
          note:
            `Only the first ${rows.length} row(s) are shown; the query matched ` +
            `more. Do NOT treat these rows as the complete result — re-query ` +
            `with an aggregate (COUNT/SUM/GROUP BY) or a narrower WHERE clause ` +
            `to answer over the whole set.`,
        }
      : {}),
  };
}
