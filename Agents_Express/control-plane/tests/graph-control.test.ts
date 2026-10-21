// Offline tests for the graph control plane:
//  - local store state transitions (source + proposals)
//  - conditional / optimistic-concurrency version conflicts
//  - approval gate (publish requires all approved + valid)
//  - tenant/status queries
//  - config fail-closed selection
//  - NO DynamoDB network in local mode (sentinel import guard)
//
// Pure, deterministic, no AWS, no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { LocalGraphControlStore } from "../src/lib/graph/localStore.ts";
import {
  resolveStoreKind,
  getGraphControlStore,
  __resetGraphControlStoreCache,
  GraphControlConfigError,
} from "../src/lib/graph/factory.ts";
import {
  evaluatePublishGate,
  isProposalValid,
  validateOutboundUrl,
  validateDecisionInput,
  canTransition,
  normalizeProposal,
} from "../src/lib/graph/logic.ts";
import {
  validateRegistration,
  addProposals,
  decideProposals,
  startBuildRun,
  registerGraphSource,
  transitionSource,
} from "../src/lib/graph/service.ts";
import {
  VersionConflictError,
  InvalidTransitionError,
  NotFoundError,
} from "../src/lib/graph/entities.ts";
import type {
  GraphSource,
  MappingProposal,
  BuildRun,
  ApprovalDecision,
} from "../src/lib/graph/entities.ts";

// --------------------------------------------------------------------------- //
// Builders
// --------------------------------------------------------------------------- //
function source(over: Partial<GraphSource> = {}): GraphSource {
  const now = new Date().toISOString();
  return {
    graphSourceId: "src-a",
    bu: "market-access",
    tenantId: "market-access",
    displayName: "Source A",
    description: "",
    ontology: { type: "neptune", sparqlUrl: "https://x:8182/sparql", graphUri: "g", namespace: "n" },
    backend: { type: "databricks-uc", catalog: "c", schema: "s", registryTable: "c.s.t", universalJoinKey: "k" },
    llmEndpoint: "llm",
    queryEngineUrl: "",
    tags: {},
    version: "1.0.0",
    status: "Draft",
    owner: "o",
    createdAt: now,
    updatedAt: now,
    rev: 1,
    ...over,
  };
}

function buildRun(over: Partial<BuildRun> = {}): BuildRun {
  return {
    buildRunId: "br-1",
    graphSourceId: "src-a",
    tenantId: "market-access",
    status: "pending",
    trigger: "test",
    startedAt: new Date().toISOString(),
    rev: 1,
    ...over,
  };
}

function proposal(over: Partial<MappingProposal> = {}): MappingProposal {
  const now = new Date().toISOString();
  return {
    proposalId: "pr-1",
    graphSourceId: "src-a",
    tenantId: "market-access",
    buildRunId: "br-1",
    status: "proposed",
    ontologyUri: "ns#therapeuticArea",
    ontologyLabel: "Therapeutic Area",
    entityType: "property",
    ucTable: "c.s.t",
    ucColumn: "therapeutic_area",
    confidence: 0.9,
    evidence: [{ kind: "alias-match", detail: "label≈column" }],
    issues: [],
    createdAt: now,
    updatedAt: now,
    rev: 1,
    ...over,
  };
}

function decision(over: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    decision: "approved",
    reviewer: "jane",
    note: "looks good",
    decidedAt: new Date().toISOString(),
    ...over,
  };
}

// --------------------------------------------------------------------------- //
// Local store: GraphSource state transitions
// --------------------------------------------------------------------------- //
test("local store: source lifecycle transitions follow the state machine", async () => {
  const store = new LocalGraphControlStore(true);
  const created = await store.createGraphSource(source());
  assert.equal(created.status, "Draft");
  assert.equal(created.rev, 1);

  const pending = await store.transitionGraphSource("src-a", "Pending approval", 1);
  assert.equal(pending.status, "Pending approval");
  assert.equal(pending.rev, 2);

  const approved = await store.transitionGraphSource("src-a", "Approved", 2);
  assert.equal(approved.status, "Approved");
  assert.equal(approved.rev, 3);
});

test("local store: invalid transition is rejected", async () => {
  const store = new LocalGraphControlStore(true);
  await store.createGraphSource(source());
  await assert.rejects(
    () => store.transitionGraphSource("src-a", "Approved", 1),
    (e: unknown) => e instanceof InvalidTransitionError
  );
});

test("local store: transition on missing source throws NotFound", async () => {
  const store = new LocalGraphControlStore(true);
  await assert.rejects(
    () => store.transitionGraphSource("nope", "Pending approval", 1),
    (e: unknown) => e instanceof NotFoundError
  );
});

// --------------------------------------------------------------------------- //
// Optimistic concurrency / conditional version conflicts
// --------------------------------------------------------------------------- //
test("local store: stale rev on transition => VersionConflict", async () => {
  const store = new LocalGraphControlStore(true);
  await store.createGraphSource(source());
  await store.transitionGraphSource("src-a", "Pending approval", 1); // rev -> 2
  await assert.rejects(
    () => store.transitionGraphSource("src-a", "Approved", 1), // stale
    (e: unknown) => e instanceof VersionConflictError
  );
});

test("local store: stale rev on update => VersionConflict", async () => {
  const store = new LocalGraphControlStore(true);
  await store.createGraphSource(source());
  await store.updateGraphSource("src-a", { description: "x" }, 1); // rev -> 2
  await assert.rejects(
    () => store.updateGraphSource("src-a", { description: "y" }, 1),
    (e: unknown) => e instanceof VersionConflictError
  );
});

test("local store: duplicate create => VersionConflict", async () => {
  const store = new LocalGraphControlStore(true);
  await store.createGraphSource(source());
  await assert.rejects(
    () => store.createGraphSource(source()),
    (e: unknown) => e instanceof VersionConflictError
  );
});

test("local store: proposal decide bumps rev and conflicts on stale rev", async () => {
  const store = new LocalGraphControlStore(true);
  await store.createGraphSource(source());
  await store.createBuildRun(buildRun());
  await store.createProposal(proposal());
  const decided = await store.decideProposal("pr-1", decision(), 1);
  assert.equal(decided.status, "approved");
  assert.equal(decided.rev, 2);
  assert.equal(decided.decision?.reviewer, "jane");
  await assert.rejects(
    () => store.decideProposal("pr-1", decision({ decision: "rejected" }), 1),
    (e: unknown) => e instanceof VersionConflictError
  );
});

// --------------------------------------------------------------------------- //
// Approval gate / publish logic
// --------------------------------------------------------------------------- //
test("publish gate: requires at least one proposal", () => {
  const g = evaluatePublishGate([]);
  assert.equal(g.eligible, false);
  assert.match(g.reasons.join(" "), /no proposals/);
});

test("publish gate: blocks when a proposal is undecided (still proposed)", () => {
  const g = evaluatePublishGate([
    proposal({ proposalId: "a", status: "approved" }),
    proposal({ proposalId: "b", status: "proposed" }),
  ]);
  assert.equal(g.eligible, false);
  assert.match(g.reasons.join(" "), /undecided/);
});

test("publish gate: blocks when an approved proposal has a blocking issue", () => {
  const g = evaluatePublishGate([
    proposal({
      proposalId: "a",
      status: "approved",
      issues: [{ severity: "blocking", code: "NO_COLUMN", message: "column missing" }],
    }),
  ]);
  assert.equal(g.eligible, false);
  assert.match(g.reasons.join(" "), /blocking issues/);
});

test("publish gate: eligible when all approved and valid", () => {
  const g = evaluatePublishGate([
    proposal({ proposalId: "a", status: "approved" }),
    proposal({ proposalId: "b", status: "approved", issues: [{ severity: "warning", code: "W", message: "w" }] }),
  ]);
  assert.equal(g.eligible, true);
  assert.deepEqual(g.approvedProposalIds.sort(), ["a", "b"]);
});

test("isProposalValid: warnings ok, blocking not", () => {
  assert.equal(isProposalValid(proposal({ issues: [{ severity: "warning", code: "W", message: "w" }] })), true);
  assert.equal(isProposalValid(proposal({ issues: [{ severity: "blocking", code: "B", message: "b" }] })), false);
});

// Cross-track reconciliation: graph-utility (Python) emits ValidationIssue with
// severity "error" for publish-blocking issues; the control-plane term is
// "blocking". Both MUST gate publish identically, otherwise a build-plane
// invalid proposal could slip past the gate.
test("isProposalValid: graph-utility 'error' severity blocks like 'blocking'", () => {
  assert.equal(isProposalValid(proposal({ issues: [{ severity: "error", code: "type-mismatch", message: "x" }] })), false);
});

test("publish gate: blocks when an approved proposal has a graph-utility 'error' issue", () => {
  const g = evaluatePublishGate([
    proposal({
      proposalId: "a",
      status: "approved",
      issues: [{ severity: "error", code: "type-mismatch", message: "ontology range != column type" }],
    }),
  ]);
  assert.equal(g.eligible, false);
  assert.match(g.reasons.join(" "), /blocking issues/);
});

test("evidence: build-plane vocabulary + weight are accepted verbatim", () => {
  const p = proposal({
    evidence: [
      { kind: "name-similarity", detail: "label ~ column (jaccard=0.50)", weight: 0.5 },
      { kind: "type-compatibility", detail: "range string == column string", weight: 0.25 },
      { kind: "ontology-relationship", detail: "A -> B" },
      { kind: "key-metadata", detail: "join via [fk]->[pk]", weight: 0.2 },
    ],
  });
  assert.equal(p.evidence.length, 4);
  assert.equal(p.evidence[0].weight, 0.5);
  assert.equal(isProposalValid(p), true);
});

test("validateDecisionInput: reviewer and note mandatory", () => {
  assert.equal(validateDecisionInput({ reviewer: "a", note: "b" }), null);
  assert.match(validateDecisionInput({ reviewer: "", note: "b" })!, /reviewer/);
  assert.match(validateDecisionInput({ reviewer: "a", note: "  " })!, /note/);
});

// --------------------------------------------------------------------------- //
// Tenant / status queries
// --------------------------------------------------------------------------- //
test("local store: list by tenant and status", async () => {
  const store = new LocalGraphControlStore(true);
  await store.createGraphSource(source({ graphSourceId: "a", tenantId: "t1", status: "Approved" }));
  await store.createGraphSource(source({ graphSourceId: "b", tenantId: "t1", status: "Draft" }));
  await store.createGraphSource(source({ graphSourceId: "c", tenantId: "t2", status: "Approved" }));

  const t1 = await store.listGraphSources({ tenantId: "t1" });
  assert.deepEqual(t1.map((s) => s.graphSourceId).sort(), ["a", "b"]);

  const approved = await store.listGraphSources({ status: "Approved" });
  assert.deepEqual(approved.map((s) => s.graphSourceId).sort(), ["a", "c"]);

  const t1Approved = await store.listGraphSources({ tenantId: "t1", status: "Approved" });
  assert.deepEqual(t1Approved.map((s) => s.graphSourceId), ["a"]);
});

test("local store: list proposals by build run and status", async () => {
  const store = new LocalGraphControlStore(true);
  await store.createBuildRun(buildRun({ buildRunId: "br-1" }));
  await store.createBuildRun(buildRun({ buildRunId: "br-2" }));
  await store.createProposal(proposal({ proposalId: "p1", buildRunId: "br-1", status: "proposed" }));
  await store.createProposal(proposal({ proposalId: "p2", buildRunId: "br-1", status: "approved" }));
  await store.createProposal(proposal({ proposalId: "p3", buildRunId: "br-2", status: "proposed" }));

  const br1 = await store.listProposals({ buildRunId: "br-1" });
  assert.deepEqual(br1.map((p) => p.proposalId).sort(), ["p1", "p2"]);

  const approved = await store.listProposals({ status: "approved" });
  assert.deepEqual(approved.map((p) => p.proposalId), ["p2"]);
});

test("local store: mapping version numbering is per-source", async () => {
  const store = new LocalGraphControlStore(true);
  await store.createMappingVersion({
    mappingVersionId: "mv1",
    graphSourceId: "src-a",
    tenantId: "t1",
    version: 1,
    status: "published",
    buildRunId: "br-1",
    proposalIds: ["p1"],
    artifactRef: { registryTable: "c.s.t" },
    publishedBy: "jane",
    publishedAt: new Date().toISOString(),
    rev: 1,
  });
  const versions = await store.listMappingVersions("src-a");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);
});

// --------------------------------------------------------------------------- //
// SSRF / URL policy
// --------------------------------------------------------------------------- //
test("validateOutboundUrl: rejects non-https", () => {
  const r = validateOutboundUrl("http://example.com/x");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /https/);
});

test("validateOutboundUrl: rejects private/metadata hosts", () => {
  for (const u of [
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
    "https://foo.internal/x",
  ]) {
    assert.equal(validateOutboundUrl(u).ok, false, `${u} must be rejected`);
  }
});

test("validateOutboundUrl: placeholder flagged, not treated as valid", () => {
  const r = validateOutboundUrl("https://REPLACE-ME-host/x");
  assert.equal(r.ok, false);
  assert.equal(r.placeholder, true);
});

test("validateOutboundUrl: allowlist suffix match enforced", () => {
  assert.equal(validateOutboundUrl("https://ws.databricks.com/x", ["databricks.com"]).ok, true);
  assert.equal(validateOutboundUrl("https://evil.com/x", ["databricks.com"]).ok, false);
});

test("canTransition mirrors the state machine", () => {
  assert.equal(canTransition("Draft", "Pending approval"), true);
  assert.equal(canTransition("Draft", "Approved"), false);
  assert.equal(canTransition("Approved", "Deprecated"), true);
});

// --------------------------------------------------------------------------- //
// Config fail-closed selection
// --------------------------------------------------------------------------- //
test("factory: defaults to local when unset", () => {
  const prev = process.env.GRAPH_CONTROL_STORE;
  delete process.env.GRAPH_CONTROL_STORE;
  __resetGraphControlStoreCache();
  assert.equal(resolveStoreKind(), "local");
  const store = getGraphControlStore();
  assert.ok(store instanceof LocalGraphControlStore);
  if (prev !== undefined) process.env.GRAPH_CONTROL_STORE = prev;
});

test("factory: unknown kind fails closed", () => {
  const prev = process.env.GRAPH_CONTROL_STORE;
  process.env.GRAPH_CONTROL_STORE = "mysql";
  __resetGraphControlStoreCache();
  assert.throws(() => resolveStoreKind(), (e: unknown) => e instanceof GraphControlConfigError);
  if (prev !== undefined) process.env.GRAPH_CONTROL_STORE = prev;
  else delete process.env.GRAPH_CONTROL_STORE;
  __resetGraphControlStoreCache();
});

test("factory: dynamodb without table fails closed (no client built)", () => {
  const prev = { ...process.env };
  process.env.GRAPH_CONTROL_STORE = "dynamodb";
  delete process.env.GRAPH_CONTROL_TABLE;
  __resetGraphControlStoreCache();
  assert.throws(
    () => getGraphControlStore(),
    (e: unknown) => e instanceof GraphControlConfigError && (e as GraphControlConfigError).code === "TABLE_UNSET"
  );
  process.env = prev;
  __resetGraphControlStoreCache();
});

test("factory: dynamodb with table but no region fails closed", () => {
  const prev = { ...process.env };
  process.env.GRAPH_CONTROL_STORE = "dynamodb";
  process.env.GRAPH_CONTROL_TABLE = "my-table";
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  __resetGraphControlStoreCache();
  assert.throws(
    () => getGraphControlStore(),
    (e: unknown) => e instanceof GraphControlConfigError && (e as GraphControlConfigError).code === "REGION_UNSET"
  );
  process.env = prev;
  __resetGraphControlStoreCache();
});

// --------------------------------------------------------------------------- //
// No DynamoDB network in local mode
// --------------------------------------------------------------------------- //
test("local mode: using the local store performs no network (full approve→publish flow)", async () => {
  // Patch global fetch to fail the test if any network call is attempted.
  const origFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (() => {
    called = true;
    throw new Error("network attempted in local mode");
  }) as typeof fetch;
  try {
    const store = new LocalGraphControlStore(true);
    await store.createGraphSource(source({ status: "Approved" }));
    await store.createBuildRun(buildRun());
    await store.createProposal(proposal({ proposalId: "p1" }));
    await store.createProposal(proposal({ proposalId: "p2" }));
    await store.decideProposal("p1", decision(), 1);
    await store.decideProposal("p2", decision(), 1);
    const all = await store.listProposals({ graphSourceId: "src-a" });
    const gate = evaluatePublishGate(all);
    assert.equal(gate.eligible, true);
    await store.createMappingVersion({
      mappingVersionId: "mv1",
      graphSourceId: "src-a",
      tenantId: "market-access",
      version: 1,
      status: "published",
      buildRunId: "br-1",
      proposalIds: gate.approvedProposalIds,
      artifactRef: {},
      publishedBy: "jane",
      publishedAt: new Date().toISOString(),
      rev: 1,
    });
    assert.equal(called, false, "no fetch should have been attempted");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --------------------------------------------------------------------------- //
// Publish gate: rejected is a completed decision excluded from output
// --------------------------------------------------------------------------- //
test("publish gate: rejected proposals are a completed decision, excluded not blocking", () => {
  const g = evaluatePublishGate([
    proposal({ proposalId: "a", status: "approved" }),
    proposal({ proposalId: "b", status: "rejected" }),
  ]);
  assert.equal(g.eligible, true, "a rejected (completed) decision must not block publish");
  assert.deepEqual(g.approvedProposalIds, ["a"], "rejected proposal must be excluded from output");
});

test("publish gate: all rejected -> blocked (no approved valid proposal to publish)", () => {
  const g = evaluatePublishGate([
    proposal({ proposalId: "a", status: "rejected" }),
    proposal({ proposalId: "b", status: "rejected" }),
  ]);
  assert.equal(g.eligible, false);
  assert.match(g.reasons.join(" "), /no approved, valid proposal/);
});

test("publish gate: approved-but-invalid blocks and is never in output", () => {
  const g = evaluatePublishGate([
    proposal({
      proposalId: "a",
      status: "approved",
      issues: [{ severity: "error", code: "type-mismatch", message: "x" }],
    }),
    proposal({ proposalId: "b", status: "approved" }),
  ]);
  assert.equal(g.eligible, false);
  assert.match(g.reasons.join(" "), /blocking issues/);
});

// --------------------------------------------------------------------------- //
// decideProposals refuses approval of invalid proposals (B)
// --------------------------------------------------------------------------- //
test("decideProposals: refuses to APPROVE an invalid proposal, allows REJECT", async () => {
  const prev = process.env.GRAPH_CONTROL_STORE;
  delete process.env.GRAPH_CONTROL_STORE;
  __resetGraphControlStoreCache();
  const gsid = `src-decide-${Math.random().toString(36).slice(2, 8)}`;
  await registerGraphSource(
    {
      graphSourceId: gsid,
      bu: "market-access",
      displayName: "Decide Src",
      ontology: { type: "neptune", sparqlUrl: "https://x:8182/sparql", graphUri: "g", namespace: "n" },
      backend: { type: "databricks-uc", catalog: "c", schema: "s", registryTable: "c.s.t", universalJoinKey: "k" },
      llmEndpoint: "llm",
    },
    "owner"
  );
  await transitionSource(gsid, "Pending approval");
  const run = await startBuildRun(gsid, "test");
  const created = await addProposals(gsid, run.buildRunId, [
    {
      kind: "direct",
      ontology_uri: "ns#x",
      ontology_label: "X",
      ontology_type: "datatype-property",
      target_table: "t",
      target_column: "total_amount",
      logical_type: "string",
      confidence: 0.9,
      validation_issues: [{ severity: "error", code: "type-mismatch", message: "range int != string" }],
    },
    {
      kind: "direct",
      ontology_uri: "ns#y",
      ontology_label: "Y",
      ontology_type: "datatype-property",
      target_table: "t",
      target_column: "x",
      logical_type: "integer",
      confidence: 0.9,
    },
  ]);
  const [invalid, valid] = created;

  const approveResults = await decideProposals(
    [invalid.proposalId, valid.proposalId],
    "approved",
    "jane",
    "note"
  );
  const invalidRes = approveResults.find((r) => r.proposalId === invalid.proposalId)!;
  const validRes = approveResults.find((r) => r.proposalId === valid.proposalId)!;
  assert.equal(invalidRes.ok, false, "invalid proposal must not be approvable");
  assert.match(invalidRes.error!, /blocking issue/);
  assert.equal(validRes.ok, true, "valid proposal approves fine");

  // Rejection of the invalid proposal is allowed (completed decision).
  const rejectResults = await decideProposals([invalid.proposalId], "rejected", "jane", "drop");
  assert.equal(rejectResults[0].ok, true, "rejecting an invalid proposal must be allowed");

  if (prev !== undefined) process.env.GRAPH_CONTROL_STORE = prev;
  __resetGraphControlStoreCache();
});

// --------------------------------------------------------------------------- //
// Cross-language normalizer (C)
// --------------------------------------------------------------------------- //
test("normalizeProposal: preserves a Python-shaped RELATIONSHIP proposal end-to-end", () => {
  // Shape mirrors graph-utility MappingProposal.to_dict() for a relationship.
  const pyRelationship = {
    id: "mp-0007",
    kind: "relationship",
    ontology_uri: "http://ex/ont#atSite",
    ontology_label: "at site",
    ontology_type: "object-property",
    target_table: "site",
    target_column: null,
    logical_type: "unknown",
    subject_columns: [],
    join: {
      left_table: "trial_site",
      left_columns: ["site_id", "trial_id"],
      right_table: "site",
      right_columns: ["site_id", "trial_id"],
      cardinality: "many-to-one",
      origin: "discovered",
      name: "at site",
    },
    evidence: [
      { kind: "ontology-relationship", detail: "trial_site -> site", weight: 0.4 },
      { kind: "key-metadata", detail: "join via composite FK", weight: 0.2 },
    ],
    confidence: 0.6,
    validation_issues: [{ severity: "warning", code: "review", message: "needs human review" }],
    source_fingerprint: "src123",
    proposal_fingerprint: "prop456",
    set_fingerprint: "setabc",
    mapping_version: "1.0",
  };

  const n = normalizeProposal(pyRelationship);
  assert.equal(n.proposalKind, "relationship");
  assert.equal(n.entityType, "property", "relationship maps to property entityType");
  assert.equal(n.ontologyType, "object-property");
  assert.equal(n.ontologyUri, "http://ex/ont#atSite");
  assert.equal(n.ucTable, "site");
  assert.equal(n.logicalType, "unknown");
  // Composite join preserved with columns/cardinality/origin/name.
  assert.ok(n.join);
  assert.deepEqual(n.join!.leftColumns, ["site_id", "trial_id"]);
  assert.deepEqual(n.join!.rightColumns, ["site_id", "trial_id"]);
  assert.equal(n.join!.leftTable, "trial_site");
  assert.equal(n.join!.rightTable, "site");
  assert.equal(n.join!.cardinality, "many-to-one");
  assert.equal(n.join!.origin, "discovered");
  assert.equal(n.join!.name, "at site");
  // Evidence (with weights) and issues preserved.
  assert.equal(n.evidence.length, 2);
  assert.equal(n.evidence[0].kind, "ontology-relationship");
  assert.equal(n.evidence[0].weight, 0.4);
  assert.equal(n.issues.length, 1);
  assert.equal(n.issues[0].code, "review");
  // Fingerprints preserved.
  assert.equal(n.sourceFingerprint, "src123");
  assert.equal(n.proposalFingerprint, "prop456");
  // set_fingerprint on the dict maps to mappingFingerprint.
  assert.equal(n.mappingFingerprint, "setabc");
});

test("normalizeProposal: a Python relationship flows through addProposals into the store", async () => {
  const prev = process.env.GRAPH_CONTROL_STORE;
  delete process.env.GRAPH_CONTROL_STORE;
  __resetGraphControlStoreCache();
  const gsid = `src-rel-${Math.random().toString(36).slice(2, 8)}`;
  await registerGraphSource(
    {
      graphSourceId: gsid,
      bu: "market-access",
      displayName: "Rel Src",
      ontology: { type: "neptune", sparqlUrl: "https://x:8182/sparql", graphUri: "g", namespace: "n" },
      backend: { type: "databricks-uc", catalog: "c", schema: "s", registryTable: "c.s.t", universalJoinKey: "k" },
      llmEndpoint: "llm",
    },
    "owner"
  );
  const run = await startBuildRun(gsid, "test");
  const created = await addProposals(gsid, run.buildRunId, [
    {
      kind: "relationship",
      ontology_uri: "http://ex/ont#atSite",
      ontology_label: "at site",
      ontology_type: "object-property",
      target_table: "site",
      join: {
        left_table: "trial_site",
        left_columns: ["site_id", "trial_id"],
        right_table: "site",
        right_columns: ["site_id", "trial_id"],
        cardinality: "many-to-one",
        origin: "discovered",
        name: "at site",
      },
      confidence: 0.6,
      evidence: [{ kind: "ontology-relationship", detail: "ts->site", weight: 0.4 }],
      source_fingerprint: "src123",
      proposal_fingerprint: "prop456",
    },
  ]);
  assert.equal(created.length, 1);
  const p = created[0];
  assert.equal(p.proposalKind, "relationship");
  assert.ok(p.join);
  assert.deepEqual(p.join!.leftColumns, ["site_id", "trial_id"]);
  assert.equal(p.join!.cardinality, "many-to-one");
  assert.equal(p.sourceFingerprint, "src123");
  assert.equal(p.proposalFingerprint, "prop456");
  assert.equal(p.evidence[0].kind, "ontology-relationship");
  if (prev !== undefined) process.env.GRAPH_CONTROL_STORE = prev;
  __resetGraphControlStoreCache();
});

// --------------------------------------------------------------------------- //
// SSRF registration: configured URL requires matching non-empty allowlist (D)
// --------------------------------------------------------------------------- //
function regInput(over: Record<string, unknown> = {}) {
  return {
    graphSourceId: "s1",
    bu: "bu",
    displayName: "S1",
    // Placeholder ontology URL so these tests isolate queryEngineUrl SSRF rules.
    ontology: { type: "neptune", sparqlUrl: "https://REPLACE-ME-neptune:8182/sparql", graphUri: "g", namespace: "n" },
    backend: { type: "databricks-uc", catalog: "c", schema: "s", registryTable: "c.s.t", universalJoinKey: "k" },
    llmEndpoint: "llm",
    ...over,
  } as Parameters<typeof validateRegistration>[0];
}

test("validateRegistration: placeholder queryEngineUrl stays previewable (no allowlist needed)", () => {
  const err = validateRegistration(
    regInput({
      queryEngineUrl: "https://REPLACE-ME-host/serving-endpoints/x/invocations",
      ontology: { type: "neptune", sparqlUrl: "https://REPLACE-ME-neptune:8182/sparql", graphUri: "g", namespace: "n" },
    })
  );
  assert.equal(err, null, "placeholder URL must remain registerable for preview");
});

test("validateRegistration: configured queryEngineUrl with EMPTY allowlist is rejected", () => {
  const err = validateRegistration(
    regInput({ queryEngineUrl: "https://ws.databricks.com/serving/x", allowedHosts: [] })
  );
  assert.ok(err, "a live URL without an allowlist must be rejected");
  assert.match(err!, /allowedHosts/);
});

test("validateRegistration: configured queryEngineUrl with NON-matching allowlist is rejected", () => {
  const err = validateRegistration(
    regInput({ queryEngineUrl: "https://ws.databricks.com/serving/x", allowedHosts: ["example.org"] })
  );
  assert.ok(err, "allowlist that does not match the host must be rejected");
  assert.match(err!, /allowlist|rejected/);
});

test("validateRegistration: configured queryEngineUrl with MATCHING allowlist is accepted", () => {
  const err = validateRegistration(
    regInput({ queryEngineUrl: "https://ws.databricks.com/serving/x", allowedHosts: ["databricks.com"] })
  );
  assert.equal(err, null, "matching allowlist (suffix) must be accepted");
});

test("validateRegistration: private/metadata queryEngineUrl rejected regardless of allowlist", () => {
  const err = validateRegistration(
    regInput({ queryEngineUrl: "https://169.254.169.254/latest", allowedHosts: ["169.254.169.254"] })
  );
  assert.ok(err, "metadata host must be rejected even if allowlisted");
});
