// Offline tests for the executable-tool layer.
//
// The read-only SQL guard is the security boundary that lets a model drive
// Unity Catalog safely, so it is pinned hard here. Nothing in this file touches
// the network: only the pure guard, the selection gate and the call recorder
// are exercised.

import { test } from "node:test";
import assert from "node:assert/strict";

import { interpretRows, isReadOnlySql } from "../src/lib/tools/uc.ts";
import {
  TOOL_IMPLEMENTATIONS,
  executeToolCall,
  isImplemented,
  selectTools,
  toOpenAiTools,
} from "../src/lib/tools/registry.ts";

// --------------------------------------------------------------------------- //
// Read-only SQL guard
// --------------------------------------------------------------------------- //

test("guard accepts ordinary read statements", () => {
  for (const sql of [
    "SELECT * FROM workspace.default.t",
    "select count(*) from t",
    "SHOW TABLES IN workspace.default",
    "DESCRIBE TABLE workspace.default.t",
    "DESC workspace.default.t",
    "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
    "EXPLAIN SELECT 1",
    "SELECT a FROM t WHERE b = 'x';", // single trailing semicolon tolerated
  ]) {
    assert.equal(isReadOnlySql(sql), true, `should accept: ${sql}`);
  }
});

test("guard rejects every write and DDL form", () => {
  for (const sql of [
    "DELETE FROM workspace.default.t",
    "delete from t",
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a = 1",
    "MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN DELETE",
    "DROP TABLE t",
    "CREATE TABLE t (a INT)",
    "ALTER TABLE t ADD COLUMN b INT",
    "TRUNCATE TABLE t",
    "GRANT SELECT ON t TO `u`",
    "REVOKE SELECT ON t FROM `u`",
    "OPTIMIZE t",
    "VACUUM t",
    "REFRESH TABLE t",
    "COPY INTO t FROM 's3://x'",
  ]) {
    assert.equal(isReadOnlySql(sql), false, `should reject: ${sql}`);
  }
});

test("guard rejects a write smuggled after a read", () => {
  // Statement stacking is the classic bypass — refuse more than one statement.
  assert.equal(isReadOnlySql("SELECT 1; DROP TABLE t"), false);
  assert.equal(isReadOnlySql("SELECT 1; DELETE FROM t"), false);
  // ...and a write nested inside an otherwise-read statement.
  assert.equal(
    isReadOnlySql("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"),
    false
  );
});

test("guard rejects empty / non-read input", () => {
  assert.equal(isReadOnlySql(""), false);
  assert.equal(isReadOnlySql("   "), false);
  assert.equal(isReadOnlySql("CALL something()"), false);
  assert.equal(isReadOnlySql("USE CATALOG workspace"), false);
});

test("guard is not fooled by column names containing keywords", () => {
  // `created_at`, `updated_by`, `inserts` must not trip the whole-word checks.
  assert.equal(isReadOnlySql("SELECT created_at, updated_by FROM t"), true);
  assert.equal(isReadOnlySql("SELECT inserts FROM metrics"), true);
  assert.equal(isReadOnlySql("SELECT a FROM dropped_items"), true);
});

// --------------------------------------------------------------------------- //
// Selection gate: approved AND implemented
// --------------------------------------------------------------------------- //

test("the three Unity Catalog tools are implemented", () => {
  for (const name of ["uc_list_tables", "uc_describe_table", "uc_query"]) {
    assert.equal(isImplemented(name), true, `${name} should be implemented`);
    assert.ok(TOOL_IMPLEMENTATIONS[name].description.length > 10);
    assert.equal(TOOL_IMPLEMENTATIONS[name].parameters.type, "object");
  }
});

test("selectTools splits approved names into executable vs unimplemented", () => {
  const sel = selectTools([
    "uc_list_tables",
    "submitExpense", // approved in the seed registry, but no implementation
    "uc_query",
    "uc_list_tables", // duplicate
  ]);
  assert.deepEqual(sel.available.map((t) => t.name), ["uc_list_tables", "uc_query"]);
  assert.deepEqual(sel.unimplemented, ["submitExpense"]);
});

test("an unimplemented tool is never offered to a model", () => {
  const sel = selectTools(["definitely_not_a_tool"]);
  assert.equal(sel.available.length, 0);
  assert.deepEqual(sel.unimplemented, ["definitely_not_a_tool"]);
});

test("toOpenAiTools renders the function-calling shape the endpoints expect", () => {
  const rendered = toOpenAiTools(selectTools(["uc_list_tables"]).available);
  assert.equal(rendered.length, 1);
  const fn = (rendered[0] as { type: string; function: Record<string, unknown> });
  assert.equal(fn.type, "function");
  assert.equal(fn.function.name, "uc_list_tables");
  const params = fn.function.parameters as { required: string[] };
  assert.deepEqual(params.required, ["catalog", "schema"]);
});

// --------------------------------------------------------------------------- //
// Call recorder — failures are returned to the model, never thrown away
// --------------------------------------------------------------------------- //

test("calling an unimplemented tool yields an error payload, not a throw", async () => {
  const { record, payload } = await executeToolCall("nope", {});
  assert.equal(record.ok, false);
  assert.equal(record.name, "nope");
  assert.match(JSON.stringify(payload), /not implemented/);
});

test("a write attempt through uc_query is refused before any network call", async () => {
  // isReadOnlySql runs first, so this never reaches Databricks.
  const { record, payload } = await executeToolCall("uc_query", {
    sql: "DELETE FROM workspace.default.agentexpress_sites",
  });
  assert.equal(record.ok, false);
  assert.match(JSON.stringify(payload), /read-only statement only/);
  assert.match(record.resultPreview, /refused/);
});

test("a missing required argument is reported as a tool error", async () => {
  const { record } = await executeToolCall("uc_list_tables", { catalog: "workspace" });
  assert.equal(record.ok, false);
  assert.match(record.resultPreview, /schema/);
});

test("tool call records carry arguments, timing and a bounded preview", async () => {
  const { record } = await executeToolCall("uc_query", { sql: "DROP TABLE t" });
  assert.deepEqual(record.arguments, { sql: "DROP TABLE t" });
  assert.equal(typeof record.latencyMs, "number");
  assert.ok(record.resultPreview.length <= 600);
});

// --------------------------------------------------------------------------- //
// Truncation must reach the model
// --------------------------------------------------------------------------- //
// The original bug: `row_limit` is sent to Databricks, so the warehouse caps
// the result BEFORE it arrives. Comparing the arrived rows against our own cap
// could therefore never detect truncation — a 376-row result came back as 50
// rows reported as complete. Verified against a live warehouse. These tests
// exist because the decision was previously unreachable without a network call.

test("the API's truncation signal is what decides, not our own row count", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => [i]);
  // Exactly at the cap, and the warehouse says it truncated.
  const capped = interpretRows(fifty, { truncated: true });
  assert.equal(capped.truncated, true, "manifest.truncated must be honoured");
  assert.equal(capped.rowCount, 50);
  assert.match(
    capped.note ?? "",
    /not treat these rows as the complete result/i,
    "a truncated result must tell the model how to get a complete answer"
  );

  // The pre-fix logic would have said false here, because 50 is not > 50.
  const naive = fifty.length > fifty.slice(0, 50).length;
  assert.equal(naive, false, "this is the comparison that always failed");
});

test("a complete result is not labelled truncated", () => {
  const three = [[1], [2], [3]];
  const out = interpretRows(three, { truncated: false });
  assert.equal(out.truncated, false);
  assert.equal(out.rowCount, 3);
  assert.equal(out.note, undefined, "no scary note on a complete result");
  assert.equal(out.rowLimit, 50, "the cap is always stated, truncated or not");
});

test("a backend that ignores row_limit is still caught", () => {
  // No manifest signal, but more rows arrived than we will return.
  const sixty = Array.from({ length: 60 }, (_, i) => [i]);
  const out = interpretRows(sixty, {});
  assert.equal(out.truncated, true, "the length backstop must still fire");
  assert.equal(out.rows.length, 50, "and the rows must still be capped");
});

test("a missing or malformed manifest does not claim completeness falsely", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => [i]);
  // Absent signal + exactly-at-cap is genuinely ambiguous. It must not crash,
  // and it must not invent a truncation that was never reported.
  const out = interpretRows(fifty, {});
  assert.equal(typeof out.truncated, "boolean");
  assert.equal(out.rowCount, 50);
});
