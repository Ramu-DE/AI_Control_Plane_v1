// Offline tests for registry validation and referential integrity.
//
// These exist because of two reported production problems: duplicate entries
// accumulating with nothing to stop them, and no way to remove anything. The
// rules are pure, so they are tested directly — which is also why the gap
// survived, since there was nowhere these rules were expected to live.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RegistryValidationError,
  assertName,
  assertRecordNameFree,
  assertRegistryNameFree,
  assertRegistryRemovable,
  decideRecordDeletion,
  describeUsage,
  findRecordUsage,
  isUsed,
  normalizeName,
} from "../src/lib/registry/validate.ts";
import type {
  AgentConfig,
  Registry,
  RegistryRecord,
  Workflow,
} from "../src/lib/types.ts";

function rec(over: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    id: "rec-1",
    registryId: "registry-a",
    name: "uc-readonly",
    description: "",
    recordSource: "define-manually",
    type: "MCP",
    credentialType: "No authorization",
    status: "Draft",
    tools: ["uc_query"],
    owner: "console-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as RegistryRecord;
}

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-1",
    name: "Sales Agent",
    description: "",
    tenantId: "fn-supply",
    modelId: "model-1",
    systemPrompt: "",
    toolRefs: [],
    knowledgeRefs: [],
    memoryRefs: [],
    compute: { agentRuntimeId: "aws-agentcore-runtime", modelRuntimeId: "aws-bedrock" },
    visibility: "private",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as AgentConfig;
}

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    name: "Fulfilment decision",
    description: "",
    tenantId: "fn-supply",
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Workflow;
}

// --------------------------------------------------------------------------- //
// Name normalisation — why duplicates got through
// --------------------------------------------------------------------------- //

test("names are compared the way a human reads them", () => {
  // These are the SAME name to a reviewer, so treating them as distinct is what
  // lets a list fill with entries that look identical.
  assert.equal(normalizeName("Supplier Tools"), normalizeName("supplier tools"));
  assert.equal(normalizeName("Supplier  Tools"), normalizeName("Supplier Tools"));
  assert.equal(normalizeName("  Supplier Tools  "), normalizeName("Supplier Tools"));
  assert.notEqual(normalizeName("Supplier Tools"), normalizeName("Supplier Tool"));
});

test("a name must be present and sane", () => {
  assert.throws(() => assertName("Record name", ""), /is required/);
  assert.throws(() => assertName("Record name", "   "), /is required/);
  assert.throws(() => assertName("Record name", "x".repeat(121)), /120 characters/);
  assert.throws(() => assertName("Record name", "bad<script>"), /may contain/);
  // Legitimate names must survive.
  for (const ok of ["uc-readonly", "Supplier Tools (EU)", "a.b/c+d", "KB_2026"]) {
    assert.equal(assertName("Record name", ok), ok);
  }
  // Whitespace is normalised, not rejected.
  assert.equal(assertName("Record name", "  Supplier   Tools "), "Supplier Tools");
});

// --------------------------------------------------------------------------- //
// Duplicates
// --------------------------------------------------------------------------- //

test("a second registry with the same name is refused", () => {
  const existing: Registry[] = [
    { id: "registry-a", name: "Supplier Tools", description: "", autoApproval: false,
      createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.throws(
    () => assertRegistryNameFree("supplier tools", existing),
    (e: RegistryValidationError) => e.status === 409 && /already exists/.test(e.message),
    "case alone must not make it a different registry"
  );
  // A genuinely different name is fine, and editing itself is allowed.
  assert.doesNotThrow(() => assertRegistryNameFree("Other Tools", existing));
  assert.doesNotThrow(() =>
    assertRegistryNameFree("Supplier Tools", existing, "registry-a")
  );
});

test("a duplicate record name is refused WITHIN a registry, allowed across them", () => {
  const records = [rec({ id: "rec-1", registryId: "registry-a", name: "uc-readonly" })];
  assert.throws(
    () => assertRecordNameFree("UC-ReadOnly", "registry-a", records),
    (e: RegistryValidationError) => e.status === 409,
    "same name in the same registry is a duplicate"
  );
  // Two business units may each own a 'uc-readonly'; forcing platform-wide
  // uniqueness would make one of them rename something they own.
  assert.doesNotThrow(() => assertRecordNameFree("uc-readonly", "registry-b", records));
});

test("the duplicate error names the existing record so it can be found", () => {
  const records = [rec({ id: "rec-99", name: "uc-readonly", status: "Approved" })];
  try {
    assertRecordNameFree("uc-readonly", "registry-a", records);
    assert.fail("should have thrown");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /rec-99/, "the id must be in the message");
    assert.match(msg, /Approved/, "and its status, so the operator knows what it is");
  }
});

// --------------------------------------------------------------------------- //
// Referential integrity
// --------------------------------------------------------------------------- //

test("usage is found across all three agent reference fields", () => {
  const agents = [
    agent({ id: "a-tool", name: "Tool user", toolRefs: ["rec-1"] }),
    agent({ id: "a-kb", name: "KB user", knowledgeRefs: ["rec-1"] }),
    agent({ id: "a-mem", name: "Memory user", memoryRefs: ["rec-1"] }),
    agent({ id: "a-none", name: "Unrelated" }),
  ];
  const usage = findRecordUsage("rec-1", agents, []);
  assert.equal(usage.agents.length, 3, "all three fields must be scanned");
  assert.deepEqual(
    usage.agents.map((a) => a.via).sort(),
    ["knowledgeRefs", "memoryRefs", "toolRefs"]
  );
  assert.ok(isUsed(usage));
});

test("usage is found in workflow steps too", () => {
  const wfs = [
    workflow({
      steps: [
        { id: "s1", name: "Demand signal", prompt: "", toolRefs: ["rec-1"],
          knowledgeRefs: [], reviewGate: false },
        { id: "s2", name: "Other", prompt: "", toolRefs: [], knowledgeRefs: [],
          reviewGate: false },
      ],
    } as never),
  ];
  const usage = findRecordUsage("rec-1", [], wfs);
  assert.equal(usage.workflowSteps.length, 1);
  assert.equal(usage.workflowSteps[0].stepName, "Demand signal");
  assert.match(describeUsage(usage), /workflow 'Fulfilment decision' step 'Demand signal'/);
});

test("an unreferenced record reports no usage", () => {
  const usage = findRecordUsage("rec-1", [agent()], [workflow()]);
  assert.equal(isUsed(usage), false);
  assert.equal(describeUsage(usage), "");
});

// --------------------------------------------------------------------------- //
// Deletion policy — three outcomes, not two
// --------------------------------------------------------------------------- //

test("a referenced record is REFUSED, and the reason names the dependant", () => {
  const usage = findRecordUsage(
    "rec-1",
    [agent({ name: "Sales Agent", toolRefs: ["rec-1"] })],
    []
  );
  const d = decideRecordDeletion(rec({ status: "Approved" }), usage);
  assert.equal(d.action, "refuse");
  assert.match(d.reason, /Sales Agent/, "the operator needs to know where to detach it");
  assert.match(d.reason, /toolRefs/, "and which field");
});

test("an Approved record is DEPRECATED, not deleted", () => {
  // It passed review and the audit trail points at it, so it must stay
  // resolvable even once it is no longer attachable.
  const d = decideRecordDeletion(rec({ status: "Approved" }), { agents: [], workflowSteps: [] });
  assert.equal(d.action, "deprecate");
  assert.match(d.reason, /audit trail/);
});

test("a Draft or Rejected record is actually deleted", () => {
  for (const status of ["Draft", "Rejected"] as const) {
    const d = decideRecordDeletion(rec({ status }), { agents: [], workflowSteps: [] });
    assert.equal(d.action, "delete", `${status} was never in force, so it may go`);
  }
});

test("an already-Deprecated record is a no-op, not a second deletion", () => {
  const d = decideRecordDeletion(rec({ status: "Deprecated" }), { agents: [], workflowSteps: [] });
  assert.equal(d.action, "refuse");
  assert.match(d.reason, /already Deprecated/);
});

test("usage outranks status: a referenced Draft is still refused", () => {
  const usage = findRecordUsage("rec-1", [agent({ toolRefs: ["rec-1"] })], []);
  const d = decideRecordDeletion(rec({ status: "Draft" }), usage);
  assert.equal(
    d.action,
    "refuse",
    "a dangling reference is a problem whatever the record's status"
  );
});

// --------------------------------------------------------------------------- //
// Registry removal never cascades
// --------------------------------------------------------------------------- //

test("a non-empty registry cannot be deleted", () => {
  const records = [rec({ registryId: "registry-a", name: "uc-readonly" })];
  assert.throws(
    () => assertRegistryRemovable("registry-a", records),
    (e: RegistryValidationError) =>
      e.status === 409 && /must not quietly delete reviewed records/.test(e.message),
    "cascading would destroy reviewed records as a side effect of tidying"
  );
  assert.doesNotThrow(() => assertRegistryRemovable("registry-empty", records));
});

test("the refusal lists what is still inside", () => {
  const records = [
    rec({ id: "r1", name: "alpha" }),
    rec({ id: "r2", name: "beta" }),
  ];
  try {
    assertRegistryRemovable("registry-a", records);
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /alpha/);
    assert.match((e as Error).message, /2 record/);
  }
});
