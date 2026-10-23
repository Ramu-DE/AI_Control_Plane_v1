// Offline tests for the model broker, the tenant model allowlist, and the
// Unity Catalog scope allowlist.
//
// These three were adopted from the Secure-AI-Agents-on-EKS workshop, where
// the lesson sits in the IAM rather than the diagram: the agent's own role
// carries three DynamoDB actions on one table ARN and NO Bedrock permission,
// and model access exists only behind a gateway scoped to ten named model ARNs.
//
// This control plane had the inverse shape. Two API routes each imported
// `runStepOnBedrock` / `runStepOnDatabricks` and called the provider directly,
// so any code path that could reach them could invoke any model the process
// credential permitted — and `uc_query`, though read-only, could read any
// table that credential could see.
//
// THE MOST IMPORTANT TEST IN THIS FILE is `no_route_imports_a_provider`. We
// cannot separate credentials by IAM role inside a single Next.js process, so
// the chokepoint is enforced by that assertion rather than by the runtime. If
// it is deleted, `modelBroker.ts` degrades from a boundary into a convention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  authorizeModel,
  effectiveModelAllowlist,
  modelsForTenant,
} from "../src/lib/modelAccess.ts";
import {
  UC_SCOPES_VAR,
  allowedScopes,
  checkScopePair,
  checkSqlScope,
  extractTableRefs,
  isReadOnlySql,
} from "../src/lib/tools/uc.ts";
import type { CatalogModel, Tenant } from "../src/lib/types.ts";

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: "t1", tenantId: "t1", tenantName: "T1", parentId: null, type: "bu",
    tier: "pro", isolation: "silo", resourcePool: "p", createdAt: "", updatedAt: "",
    ...over,
  } as Tenant;
}

function model(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "m-dbx", name: "Llama", modelProvider: "Meta",
    modelId: "databricks-meta-llama-3-3-70b-instruct",
    inferenceProvider: "Databricks Model Serving", createdAt: "",
    ...over,
  } as CatalogModel;
}

const MODELS = [
  model(),
  model({ id: "m-bedrock", name: "Claude", inferenceProvider: "Amazon Bedrock" }),
];

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --------------------------------------------------------------------------- //
// The chokepoint
// --------------------------------------------------------------------------- //
test("no route imports a provider module directly", () => {
  // The whole point of the broker. Two routes used to do this, and a third
  // would have been added by the next feature with its own chance of
  // forgetting the allowlist, the audit entry, or the plane check.
  const root = join(import.meta.dirname, "..", "src", "app");
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry)) continue;
      const text = readFileSync(full, "utf8");
      // `newStepRun` is a pure helper that mints a StepRun record; it touches
      // no credential, so importing it is not a provider call.
      const bad = /from\s+"@\/lib\/(databricks|bedrock)"/.exec(text);
      if (!bad) continue;
      const line = text.split("\n").find((l) => /@\/lib\/(databricks|bedrock)/.test(l)) ?? "";
      const onlyPureHelpers = /^\s*import\s*\{\s*newStepRun\s*\}/.test(line);
      if (!onlyPureHelpers) {
        offenders.push(`${full.replace(root, "src/app")}: ${line.trim()}`);
      }
    }
  };
  walk(root);

  assert.deepEqual(
    offenders, [],
    "every model call must go through lib/modelBroker.ts, which enforces the " +
    "tenant allowlist, the plane check and the audit entry:\n  " +
      offenders.join("\n  ")
  );
});

// --------------------------------------------------------------------------- //
// Allowlist inheritance
// --------------------------------------------------------------------------- //
test("an unset allowlist inherits from the nearest ancestor that sets one", () => {
  const tenants = [
    tenant({ id: "org", parentId: null, allowedModelIds: ["m-dbx"] }),
    tenant({ id: "bu", parentId: "org" }),                 // inherits
    tenant({ id: "sub", parentId: "bu" }),                 // inherits via bu
  ];
  for (const id of ["org", "bu", "sub"]) {
    const a = effectiveModelAllowlist(id, tenants);
    assert.deepEqual(a.modelIds, ["m-dbx"], `${id} inherits`);
    assert.equal(a.inheritedFrom, "org", `${id} records where the rule came from`);
  }
});

test("a nearer declaration overrides an ancestor's", () => {
  const tenants = [
    tenant({ id: "org", parentId: null, allowedModelIds: ["m-dbx"] }),
    tenant({ id: "bu", parentId: "org", allowedModelIds: ["m-bedrock"] }),
    tenant({ id: "sub", parentId: "bu" }),
  ];
  assert.deepEqual(effectiveModelAllowlist("sub", tenants).modelIds, ["m-bedrock"]);
  assert.equal(effectiveModelAllowlist("sub", tenants).inheritedFrom, "bu");
});

test("no declaration anywhere means unrestricted, not empty", () => {
  const tenants = [tenant({ id: "a", parentId: null }), tenant({ id: "b", parentId: "a" })];
  const a = effectiveModelAllowlist("b", tenants);
  assert.equal(a.modelIds, null, "null means unrestricted");
  assert.equal(a.inheritedFrom, null);
});

test("an explicit empty allowlist means NO models, which is different", () => {
  // Conflating `[]` with "inherit" would make it impossible to freeze a tenant
  // without deleting it.
  const tenants = [tenant({ id: "frozen", parentId: null, allowedModelIds: [] })];
  const a = effectiveModelAllowlist("frozen", tenants);
  assert.deepEqual(a.modelIds, [], "empty, not null");
  const d = authorizeModel({
    tenantId: "frozen", modelId: "m-dbx", tenants, models: MODELS,
  });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /not on the allowlist/);
});

test("a cycle in parentId terminates", () => {
  const tenants = [
    tenant({ id: "x", parentId: "y" }),
    tenant({ id: "y", parentId: "x" }),
  ];
  const a = effectiveModelAllowlist("x", tenants);
  assert.equal(a.modelIds, null, "must return, not hang");
});

// --------------------------------------------------------------------------- //
// Authorization
// --------------------------------------------------------------------------- //
test("a model absent from the catalog is refused before any credential is used", () => {
  const d = authorizeModel({
    tenantId: "t1", modelId: "m-nope", tenants: [tenant()], models: MODELS,
  });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /not in the platform catalog/);
});

test("an allowlisted model on the right plane is permitted", () => {
  const tenants = [tenant({ id: "t1", allowedModelIds: ["m-dbx"] })];
  const d = authorizeModel({
    tenantId: "t1", modelId: "m-dbx", tenants, models: MODELS,
    modelRuntimeId: "databricks-fm-api-pay-per-token",
  });
  assert.equal(d.allowed, true, d.reason);
  assert.equal(d.decidedBy, "t1");
});

test("the plane check still applies to an allowlisted model", () => {
  // Being permitted to USE a model does not make a mismatched runtime valid.
  const tenants = [tenant({ id: "t1", allowedModelIds: ["m-dbx"] })];
  const d = authorizeModel({
    tenantId: "t1", modelId: "m-dbx", tenants, models: MODELS,
    modelRuntimeId: "aws-bedrock",
  });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /Databricks Model Serving|not a Databricks runtime/);
});

test("an unrestricted subtree still permits, and says why", () => {
  const d = authorizeModel({
    tenantId: "t1", modelId: "m-dbx", tenants: [tenant()], models: MODELS,
  });
  assert.equal(d.allowed, true);
  assert.match(d.reason, /no model allowlist is set/);
});

test("modelsForTenant narrows a picker to what will actually work", () => {
  const tenants = [tenant({ id: "t1", allowedModelIds: ["m-bedrock"] })];
  assert.deepEqual(
    modelsForTenant(MODELS, "t1", tenants).map((m) => m.id), ["m-bedrock"]);
  // Unrestricted returns everything rather than nothing.
  assert.equal(modelsForTenant(MODELS, "t1", [tenant()]).length, MODELS.length);
});

// --------------------------------------------------------------------------- //
// Unity Catalog scope allowlist
// --------------------------------------------------------------------------- //
test("table references are extracted from a statement", () => {
  assert.deepEqual(
    extractTableRefs("SELECT * FROM workspace.default.contract c JOIN workspace.default.site s ON 1=1"),
    ["workspace.default.contract", "workspace.default.site"]);
  // Databricks quotes with backticks; the same reference either way.
  assert.deepEqual(
    extractTableRefs("SELECT * FROM `cat`.`sch`.`tbl`"), ["cat.sch.tbl"]);
  assert.deepEqual(extractTableRefs("SELECT 1"), []);
});

test("an unset allowlist is permissive, and reports that it is", () => {
  withEnv({ [UC_SCOPES_VAR]: undefined }, () => {
    assert.deepEqual(allowedScopes(), []);
    const c = checkSqlScope("SELECT * FROM anything.at.all");
    assert.equal(c.ok, true, "existing deployments must not break");
    assert.deepEqual(c.scopes, [], "and the caller can see no limit was set");
  });
});

test("a configured allowlist refuses a table outside it", () => {
  withEnv({ [UC_SCOPES_VAR]: "workspace.default" }, () => {
    const inside = checkSqlScope("SELECT * FROM workspace.default.contract");
    assert.equal(inside.ok, true, inside.reason);

    const outside = checkSqlScope("SELECT * FROM finance.payroll.salaries");
    assert.equal(outside.ok, false);
    assert.deepEqual(outside.violations, ["finance.payroll.salaries"]);
    assert.match(outside.reason ?? "", /outside the permitted scope/);
  });
});

test("one out-of-scope table in a join refuses the whole statement", () => {
  withEnv({ [UC_SCOPES_VAR]: "workspace.default" }, () => {
    const c = checkSqlScope(
      "SELECT * FROM workspace.default.contract c " +
      "JOIN finance.payroll.salaries s ON c.id = s.id");
    assert.equal(c.ok, false, "a permitted table does not launder a forbidden one");
    assert.deepEqual(c.violations, ["finance.payroll.salaries"]);
  });
});

test("an unqualified statement is refused when an allowlist is set", () => {
  // For a scope check, "I cannot tell what this reads" has to mean no.
  withEnv({ [UC_SCOPES_VAR]: "workspace.default" }, () => {
    const c = checkSqlScope("SELECT * FROM contract");
    assert.equal(c.ok, false);
    assert.match(c.reason ?? "", /fully-qualified/);
  });
});

test("scope matching is case-insensitive and prefix-anchored", () => {
  withEnv({ [UC_SCOPES_VAR]: "Workspace.Default" }, () => {
    assert.equal(checkSqlScope("SELECT * FROM WORKSPACE.DEFAULT.contract").ok, true);
    // `workspace.default_secrets` must NOT match the `workspace.default` scope.
    const sneaky = checkSqlScope("SELECT * FROM workspace.default_secrets.t");
    assert.equal(sneaky.ok, false,
      "a prefix match must respect the dot boundary, or a sibling schema leaks");
  });
});

test("the listing tools check their own arguments", () => {
  withEnv({ [UC_SCOPES_VAR]: "workspace.default" }, () => {
    assert.equal(checkScopePair("workspace", "default").ok, true);
    const bad = checkScopePair("finance", "payroll");
    assert.equal(bad.ok, false);
    assert.match(bad.reason ?? "", /outside the permitted scope/);
  });
  withEnv({ [UC_SCOPES_VAR]: undefined }, () => {
    assert.equal(checkScopePair("anything", "goes").ok, true);
  });
});

test("the read-only guard is unchanged by the scope work", () => {
  // Two independent controls: in-bounds does not imply read-only.
  assert.equal(isReadOnlySql("SELECT 1"), true);
  assert.equal(isReadOnlySql("DROP TABLE workspace.default.contract"), false);
  assert.equal(isReadOnlySql("SELECT 1; DROP TABLE t"), false);
  withEnv({ [UC_SCOPES_VAR]: "workspace.default" }, () => {
    // In scope, but still a write — the read-only check must catch it.
    assert.equal(isReadOnlySql("DELETE FROM workspace.default.contract"), false);
  });
});
