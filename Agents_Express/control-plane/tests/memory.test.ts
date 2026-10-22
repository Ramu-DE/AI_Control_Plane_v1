// Offline tests for governed agent memory.
//
// Memory is a persistent store of personal data that shapes every future
// session, so the things worth testing hardest are the refusals: the namespace
// that isolates one tenant from another, the approval gate that stops an
// unreviewed memory being attached, the scope ceiling that stops a record being
// read wider than it was signed off for, and the cross-tenant boundary.
//
// The real failures this guards against are documented: a tenant isolation flaw
// in Asana's MCP server exposed other organisations' data (Jun 2025); a Redis
// bug showed ChatGPT users each other's chat titles (Mar 2023); a poisoned
// memory in Gemini persisted into every later session (Feb 2025).
//
// No AWS, no network: everything here is the pure governance layer.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTOR_SEPARATOR,
  MEMORY_SCOPES,
  MemoryNamespaceError,
  actorKey,
  assertSegment,
  isWithin,
  parseActorKey,
  partitionByScope,
  renderNamespace,
  templateScope,
  tenantOf,
} from "../src/lib/memory/namespace.ts";
import {
  MEMORY_ACTION,
  MEMORY_PERIMETER_TOOL,
  authorizeMemory,
  memoryScopedPolicyExists,
  memoryScopedTool,
  readMemoryConfig,
  tenantInSubtree,
} from "../src/lib/memory/logic.ts";
import { MemoryConfigError } from "../src/lib/memory/types.ts";
import { store } from "../src/lib/store.ts";
import type { RegistryRecord } from "../src/lib/types.ts";

// --------------------------------------------------------------------------- //
// Namespace — the isolation control
// --------------------------------------------------------------------------- //
// The template below is the one actually configured on the live AgentCore
// memory. AgentCore interpolates only {actorId} and {sessionId} — there is no
// tenant variable — so the tenant is encoded INTO the actor id. That is what
// makes a prefix comparison a real tenant check.
const TEMPLATE = "/agentexpress/strategy/semantic/actor/{actorId}/session/{sessionId}";

test("the rendered namespace carries the tenant inside the actor segment", () => {
  const ns = renderNamespace(TEMPLATE, {
    tenantId: "takeda",
    personaId: "persona-john",
    sessionId: "run-1",
  });
  assert.equal(
    ns,
    "/agentexpress/strategy/semantic/actor/takeda__persona-john/session/run-1"
  );
  assert.equal(
    tenantOf(ns),
    "takeda",
    "the tenant must be recoverable from the path, or isolation is unprovable"
  );
});

// The actor-scoped template actually configured on the live memory, for the
// user-preference strategy that serves cross-session recall.
const ACTOR_TEMPLATE = "/agentexpress/strategy/preferences/actor/{actorId}";

test("scope is a property of the TEMPLATE, never of a truncated path", () => {
  // This test exists because of a real bug. The first version rendered the
  // session namespace and cut it at '/session/' to make an "actor scope".
  // Verified against a live memory: that returns NOTHING, because
  // RetrieveMemoryRecords matches a namespace exactly and does not do prefix
  // search. A truncated path is a path nothing was written to, and the empty
  // result is indistinguishable from "this user has no memories".
  assert.equal(templateScope(TEMPLATE), "session");
  assert.equal(templateScope(ACTOR_TEMPLATE), "actor");

  const actorNs = renderNamespace(ACTOR_TEMPLATE, {
    tenantId: "takeda",
    personaId: "persona-john",
  });
  assert.equal(actorNs, "/agentexpress/strategy/preferences/actor/takeda__persona-john");
  assert.equal(tenantOf(actorNs), "takeda", "and it still names its tenant");

  const sessionNs = renderNamespace(TEMPLATE, {
    tenantId: "takeda",
    personaId: "persona-john",
    sessionId: "run-1",
  });
  // The session path LOOKS like it sits under an actor path, which is exactly
  // what made truncation seem reasonable. It does not help: these are two
  // different strategies with two different namespaces.
  assert.equal(isWithin(sessionNs, actorNs), false,
    "the two strategies are separate namespaces, not a hierarchy to walk");
});

test("an actor-scoped template does not require a sessionId", () => {
  assert.doesNotThrow(() =>
    renderNamespace(ACTOR_TEMPLATE, { tenantId: "takeda", personaId: "p" })
  );
  // But a session-scoped one must refuse rather than render a broken path.
  assert.throws(
    () => renderNamespace(TEMPLATE, { tenantId: "takeda", personaId: "p" }),
    /session-scoped, so a sessionId is required/
  );
});

test("only the two expressible scopes are offered", () => {
  // tenant and strategy scopes would render a path nothing was written to,
  // because the backend template cannot express them without one memory
  // resource per tenant. A scope that silently matches nothing is worse than
  // no scope at all.
  assert.deepEqual([...MEMORY_SCOPES], ["session", "actor"]);
});

test("an unsupported placeholder is refused, not left in the path", () => {
  assert.throws(
    () =>
      renderNamespace("/app/strategy/s/tenant/{tenantId}/actor/{actorId}", {
        tenantId: "takeda",
        personaId: "p",
        sessionId: "r",
      }),
    /placeholder '\{tenantId\}' is not supported/,
    "AgentCore has no tenant variable; leaving it unrendered would produce a " +
      "namespace nothing ever wrote to"
  );
});

test("a path-traversal identifier is refused, not escaped", () => {
  for (const bad of ["../other-tenant", "a/b", "..", "", "x".repeat(200), "/abs"]) {
    assert.throws(
      () => assertSegment("tenantId", bad),
      MemoryNamespaceError,
      `'${bad}' must be refused as a namespace segment`
    );
  }
  // The realistic attack: climb out of your tenant into a sibling.
  assert.throws(
    () => actorKey("takeda/../acme", "persona-john"),
    MemoryNamespaceError,
    "a tenant id containing '/..' must never produce a sibling's namespace"
  );
  // The separator must not appear in either part, or the composite key could
  // not be split back apart unambiguously.
  assert.throws(() => actorKey(`a${ACTOR_SEPARATOR}b`, "p"), MemoryNamespaceError);
});

test("the composite actor id round-trips", () => {
  const key = actorKey("takeda", "persona-john");
  assert.deepEqual(parseActorKey(key), {
    tenantId: "takeda",
    personaId: "persona-john",
  });
  assert.equal(parseActorKey("no-separator"), null);
  assert.equal(parseActorKey(`${ACTOR_SEPARATOR}only`), null);
});

test("a tenant-less actor id yields no tenant, so it cannot pass a tenant check", () => {
  // This is the bug the composite key exists to prevent: if a bare persona were
  // sent to AgentCore as the actorId, extraction would write to a path with no
  // tenant in it, and every read-side test would still pass.
  const bare = "/agentexpress/strategy/semantic/actor/persona-john/session/run-1";
  assert.equal(
    tenantOf(bare),
    null,
    "a tenant-less namespace must report null rather than guessing"
  );
});

test("isWithin distinguishes a child scope from a sibling with a shared prefix", () => {
  const actor = "/agentexpress/strategy/semantic/actor/takeda__john";
  assert.equal(isWithin(`${actor}/session/1`, actor), true);
  assert.equal(isWithin(actor, actor), true);
  // The prefix trap: 'takeda-labs' starts with 'takeda'.
  const sibling = "/agentexpress/strategy/semantic/actor/takeda-labs__john";
  assert.equal(
    isWithin(sibling, actor),
    false,
    "'takeda-labs__john' must NOT be treated as inside 'takeda__john'"
  );
  // And a different persona in the same tenant is still a different actor.
  assert.equal(
    isWithin("/agentexpress/strategy/semantic/actor/takeda__mary", actor),
    false
  );
});

test("a record outside the requested scope is reported, never silently kept", () => {
  const scope = "/agentexpress/strategy/semantic/actor/takeda__john";
  const { kept, escaped } = partitionByScope(
    [
      { namespace: `${scope}/session/1`, id: "in" },
      {
        namespace: "/agentexpress/strategy/semantic/actor/acme__mary/session/1",
        id: "other-tenant",
      },
      { id: "no-namespace" },
    ] as { namespace?: string; id: string }[],
    scope
  );
  assert.deepEqual(kept.map((k) => k.id), ["in"]);
  assert.deepEqual(
    escaped.map((k) => k.id).sort(),
    ["no-namespace", "other-tenant"],
    "another tenant's record AND an unprovable one must both count as escapes"
  );
});

// --------------------------------------------------------------------------- //
// The approval gate — same as tools and knowledge bases
// --------------------------------------------------------------------------- //

function memRecord(over: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    id: "rec-mem-1",
    registryId: "registry-1",
    name: "Support memory",
    description: "",
    recordSource: "define-manually",
    type: "Memory",
    credentialType: "IAM Role",
    status: "Approved",
    tools: [],
    owner: "takeda",
    createdAt: "2026-01-01T00:00:00.000Z",
    memoryConfig: {
      memoryId: "mem-abc",
      region: "us-west-2",
      strategyId: "semantic-LYRQAaHrU6",
      namespaceTemplate: TEMPLATE,
      topK: 5,
    },
    ...over,
  } as RegistryRecord;
}

test("only an Approved Memory record may be used", () => {
  assert.throws(() => readMemoryConfig(undefined), /not found/);
  assert.throws(
    () => readMemoryConfig(memRecord({ status: "Draft" })),
    /is Draft; only an Approved record/,
    "an unreviewed memory must not be usable — it holds personal data"
  );
  assert.throws(
    () => readMemoryConfig(memRecord({ status: "Pending approval" })),
    /only an Approved record/
  );
  assert.throws(
    () => readMemoryConfig(memRecord({ type: "Knowledge Base" })),
    /is type 'Knowledge Base', not 'Memory'/,
    "a KB must not be usable as a memory"
  );
  const ok = readMemoryConfig(memRecord());
  assert.equal(ok.memoryId, "mem-abc");
  assert.equal(ok.namespaceTemplate, TEMPLATE);
});

test("a memory record without config cannot be used", () => {
  assert.throws(
    () => readMemoryConfig(memRecord({ memoryConfig: undefined })),
    /has no memoryConfig/
  );
  assert.throws(
    () =>
      readMemoryConfig(
        memRecord({
          memoryConfig: { region: "us-west-2", strategyId: "s" } as never,
        })
      ),
    /needs memoryId, region and strategyId/
  );
});

test("recall is bounded — an unbounded topK is refused", () => {
  for (const topK of [0, -1, 1000, 2.5, Number.NaN]) {
    assert.throws(
      () =>
        readMemoryConfig(
          memRecord({ memoryConfig: { ...memRecord().memoryConfig!, topK } as never })
        ),
      /topK must be an integer 1\.\.50/,
      `topK ${topK} must be refused — unbounded recall replays the store into every prompt`
    );
  }
});

// --------------------------------------------------------------------------- //
// Cedar two-stage gate
// --------------------------------------------------------------------------- //

test("memory Cedar constants and the seeded perimeter policy line up", () => {
  assert.equal(MEMORY_ACTION, "useMemory");
  assert.equal(MEMORY_PERIMETER_TOOL, "memory");
  assert.equal(memoryScopedTool("rec-mem-1"), "memory:rec-mem-1");
  const a = authorizeMemory("rec-mem-1", "persona-john");
  assert.equal(a.perimeter.allowed, true);
  assert.equal(a.perimeter.matchedPolicyId, "pol-gw-memory-perimeter");
  assert.equal(a.recordScoped.evaluated, false, "stage 2 only runs when named");
  assert.equal(a.allowed, true);
});

test("a record-scoped policy becomes authoritative and can deny", () => {
  const recordId = "rec-mem-locked";
  store.policies.unshift({
    id: "pol-test-memory-scoped",
    name: "Test: only directors may recall this memory",
    layer: "gateway",
    description: "test-only",
    enabled: true,
    createdAt: new Date().toISOString(),
    cedar: `permit(
  principal,
  action == Action::"useMemory",
  resource == Tool::"${memoryScopedTool(recordId)}"
) when { principal.role == "director" };`,
  });
  try {
    assert.equal(memoryScopedPolicyExists(store.policies, recordId), true);
    assert.equal(
      authorizeMemory(recordId, "persona-john").allowed,
      false,
      "a manager must be denied a director-only memory"
    );
    assert.equal(authorizeMemory(recordId, "persona-mary").allowed, true);
  } finally {
    store.policies = store.policies.filter((p) => p.id !== "pol-test-memory-scoped");
  }
});

test("an unknown persona can never reach memory", () => {
  const a = authorizeMemory("rec-mem-1", "persona-ghost");
  assert.equal(a.allowed, false);
  assert.equal(a.recordScoped.evaluated, false, "stage 2 is skipped on a stage 1 deny");
});

// --------------------------------------------------------------------------- //
// Cross-tenant boundary
// --------------------------------------------------------------------------- //

test("memory follows the tenant tree: a parent may read down, a sibling never", () => {
  const tenants = [
    { id: "takeda", parentId: null },
    { id: "fn-supply", parentId: "takeda" },
    { id: "fn-finance", parentId: "takeda" },
    { id: "team-a", parentId: "fn-supply" },
    { id: "acme", parentId: null },
  ];
  assert.equal(tenantInSubtree("takeda", "takeda", tenants), true, "itself");
  assert.equal(tenantInSubtree("takeda", "fn-supply", tenants), true, "child");
  assert.equal(tenantInSubtree("takeda", "team-a", tenants), true, "grandchild");
  assert.equal(
    tenantInSubtree("fn-supply", "fn-finance", tenants),
    false,
    "a SIBLING must never reach across — this is the Asana failure mode"
  );
  assert.equal(tenantInSubtree("takeda", "acme", tenants), false, "unrelated org");
  assert.equal(
    tenantInSubtree("fn-supply", "takeda", tenants),
    false,
    "a child must not read its parent's wider scope"
  );
});

test("a cycle in the tenant tree terminates instead of hanging", () => {
  const cyclic = [
    { id: "a", parentId: "b" },
    { id: "b", parentId: "a" },
  ];
  assert.equal(tenantInSubtree("z", "a", cyclic), false);
});
