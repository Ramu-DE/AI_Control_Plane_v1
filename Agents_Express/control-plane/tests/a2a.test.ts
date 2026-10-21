// Offline tests for the A2A capability.
//
// Covers the pure trust boundaries and the governance gate:
//  - Agent Card normalization (hostile / malformed cards)
//  - JSON-RPC envelope construction
//  - reply flattening for both Message and Task shapes
//  - two-stage Cedar authorization incl. peer-scoped deny
//  - registration validation + SSRF allowlist pinning
//  - lifecycle state machine and optimistic concurrency
//  - credential handling: only references, resolved from env, never stored
//
// No network: nothing here calls fetch(). Deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeCard, wellKnownUrl, WELL_KNOWN_PATHS } from "../src/lib/a2a/card.ts";
import {
  buildSendEnvelope,
  normalizeReply,
  resolveAuthHeaders,
  A2A_METHOD,
} from "../src/lib/a2a/client.ts";
import {
  authorizeCall,
  canTransition,
  isPeerCallable,
  parseAllowedHosts,
  peerScopedPolicyExists,
  peerScopedTool,
  validateRegisterPeer,
} from "../src/lib/a2a/logic.ts";
import {
  A2ATransitionError,
  A2AVersionConflictError,
  createPeer,
  getPeer,
  listPeers,
  transitionPeer,
} from "../src/lib/a2a/store.ts";
import { A2AConfigError, A2ATransportError } from "../src/lib/a2a/types.ts";
import type { A2APeer } from "../src/lib/a2a/types.ts";
import { store } from "../src/lib/store.ts";

// --------------------------------------------------------------------------- //
// Agent Card normalization — the external trust boundary
// --------------------------------------------------------------------------- //

test("card: normalizes a well-formed card and keeps only known fields", () => {
  const card = normalizeCard(
    {
      name: "SupplyChainAgent",
      description: "routing",
      url: "https://peer.example.com",
      version: "1.2.3",
      capabilities: { streaming: true, pushNotifications: false },
      skills: [
        { id: "route_optimize", name: "Route optimization", description: "d", tags: ["eta"] },
      ],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      maliciousExtra: "<script>alert(1)</script>",
    },
    "https://peer.example.com/.well-known/agent-card.json"
  );
  assert.equal(card.name, "SupplyChainAgent");
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal(card.skills.length, 1);
  assert.equal(card.skills[0].id, "route_optimize");
  // Unknown fields must NOT be carried onto our type.
  assert.equal("maliciousExtra" in card, false);
});

test("card: accepts snake_case mode fields from older peers", () => {
  const card = normalizeCard(
    { name: "P", default_input_modes: ["text"], default_output_modes: ["text", "json"] },
    "https://p/.well-known/agent.json"
  );
  assert.deepEqual(card.defaultInputModes, ["text"]);
  assert.deepEqual(card.defaultOutputModes, ["text", "json"]);
});

test("card: rejects a card with no name, and a non-object body", () => {
  assert.throws(() => normalizeCard({ description: "x" }, "u"), A2ATransportError);
  assert.throws(() => normalizeCard("not-json", "u"), A2ATransportError);
  assert.throws(() => normalizeCard(null, "u"), A2ATransportError);
});

test("card: drops skills with no id and coerces bad field types", () => {
  const card = normalizeCard(
    {
      name: "P",
      capabilities: "not-an-object",
      skills: [
        { name: "no id here" },
        { id: "ok", tags: "not-an-array", description: 42 },
        "not-an-object",
      ],
    },
    "u"
  );
  assert.equal(card.skills.length, 1);
  assert.equal(card.skills[0].id, "ok");
  assert.deepEqual(card.skills[0].tags, []);
  assert.equal(card.skills[0].description, "");
  // A skill with no name falls back to its id.
  assert.equal(card.skills[0].name, "ok");
  assert.equal(card.capabilities.streaming, false);
});

test("card: well-known URL join does not double the slash", () => {
  assert.equal(
    wellKnownUrl("https://p.example.com/", "/.well-known/agent.json"),
    "https://p.example.com/.well-known/agent.json"
  );
  assert.equal(WELL_KNOWN_PATHS[0], "/.well-known/agent-card.json");
});

// --------------------------------------------------------------------------- //
// JSON-RPC envelope + reply flattening
// --------------------------------------------------------------------------- //

test("client: envelope is valid JSON-RPC 2.0 message/send", () => {
  const env = buildSendEnvelope({ text: "hello", messageId: "m1" });
  assert.equal(env.jsonrpc, "2.0");
  assert.equal(env.method, A2A_METHOD);
  assert.equal(env.id, "m1");
  const params = env.params as Record<string, unknown>;
  const msg = params.message as Record<string, unknown>;
  assert.equal(msg.role, "user");
  assert.deepEqual(msg.parts, [{ kind: "text", text: "hello" }]);
  // No skill requested -> no metadata key at all.
  assert.equal("metadata" in params, false);
});

test("client: skill and session are carried without breaking the protocol", () => {
  const env = buildSendEnvelope({
    text: "hi",
    messageId: "m2",
    skillId: "route_optimize",
    sessionId: "s1",
  });
  const params = env.params as Record<string, unknown>;
  assert.deepEqual(params.metadata, { skillId: "route_optimize" });
  assert.equal((params.message as Record<string, unknown>).contextId, "s1");
});

test("client: flattens a Message-shaped reply", () => {
  const reply = normalizeReply({
    kind: "message",
    parts: [
      { kind: "text", text: "line one" },
      { kind: "text", text: "line two" },
    ],
  });
  assert.equal(reply.text, "line one\nline two");
  assert.equal(reply.droppedParts, 0);
});

test("client: flattens a Task-shaped reply incl. artifacts, and counts non-text", () => {
  const reply = normalizeReply({
    id: "task-9",
    status: { state: "completed", message: { parts: [{ kind: "text", text: "done" }] } },
    artifacts: [{ parts: [{ kind: "text", text: "detail" }, { kind: "file", file: {} }] }],
  });
  assert.equal(reply.taskId, "task-9");
  assert.equal(reply.state, "completed");
  assert.equal(reply.text, "done\ndetail");
  assert.equal(reply.droppedParts, 1);
});

test("client: tolerates an empty or non-object result", () => {
  assert.equal(normalizeReply(undefined).text, "");
  assert.equal(normalizeReply({}).text, "");
  assert.equal(normalizeReply({ parts: "nope" }).text, "");
});

// --------------------------------------------------------------------------- //
// Credentials: references only, resolved from env, never persisted
// --------------------------------------------------------------------------- //

function peerFixture(over: Partial<A2APeer> = {}): A2APeer {
  const now = new Date().toISOString();
  return {
    peerId: "fixture-peer",
    displayName: "Fixture",
    description: "",
    tenantId: "takeda",
    endpoint: "https://peer.example.com",
    allowedHosts: ["peer.example.com"],
    auth: { kind: "none" },
    card: null,
    status: "Approved",
    owner: "test",
    createdAt: now,
    updatedAt: now,
    rev: 1,
    ...over,
  };
}

test("client: bearer auth reads the env var by NAME and never stores a value", () => {
  const name = "A2A_TEST_TOKEN_" + Math.random().toString(36).slice(2, 8);
  const peer = peerFixture({ auth: { kind: "bearer-env", authEnvVar: name } });
  // Unset -> explicit config error rather than an unauthenticated call.
  assert.throws(() => resolveAuthHeaders(peer), A2AConfigError);
  process.env[name] = "s3cret";
  try {
    assert.deepEqual(resolveAuthHeaders(peer), { authorization: "Bearer s3cret" });
    // The secret is not written back onto the peer record.
    assert.equal(JSON.stringify(peer).includes("s3cret"), false);
  } finally {
    delete process.env[name];
  }
});

test("client: 'none' and 'iam-role' add no Authorization header", () => {
  assert.deepEqual(resolveAuthHeaders(peerFixture()), {});
  assert.deepEqual(
    resolveAuthHeaders(peerFixture({ auth: { kind: "iam-role", roleArn: "arn:aws:iam::1:role/r" } })),
    {}
  );
});

test("client: bearer-env with no env var name is a config error", () => {
  assert.throws(
    () => resolveAuthHeaders(peerFixture({ auth: { kind: "bearer-env" } })),
    A2AConfigError
  );
});

// --------------------------------------------------------------------------- //
// Registration validation + SSRF pinning
// --------------------------------------------------------------------------- //

const baseReg = {
  peerId: "peer-one",
  displayName: "Peer One",
  tenantId: "takeda",
};

test("register: placeholder endpoint is accepted for preview-only setup", () => {
  assert.equal(
    validateRegisterPeer({
      ...baseReg,
      endpoint: "https://REPLACE-ME-peer.example.com",
      allowedHosts: [],
    }),
    null
  );
});

test("register: a live endpoint with an EMPTY allowlist is rejected", () => {
  const err = validateRegisterPeer({
    ...baseReg,
    endpoint: "https://peer.example.com",
    allowedHosts: [],
  });
  assert.match(String(err), /allowedHosts is empty/);
});

test("register: a live endpoint with a NON-matching allowlist is rejected", () => {
  const err = validateRegisterPeer({
    ...baseReg,
    endpoint: "https://peer.example.com",
    allowedHosts: ["other.example.org"],
  });
  assert.match(String(err), /not in the allowlist/);
});

test("register: a live endpoint with a MATCHING allowlist is accepted", () => {
  assert.equal(
    validateRegisterPeer({
      ...baseReg,
      endpoint: "https://peer.example.com",
      allowedHosts: ["example.com"],
    }),
    null
  );
});

test("register: private / metadata / non-https endpoints are always rejected", () => {
  for (const endpoint of [
    "http://peer.example.com",
    "https://169.254.169.254/",
    "https://127.0.0.1:9001",
    "https://10.1.2.3",
    "https://thing.internal",
  ]) {
    const err = validateRegisterPeer({
      ...baseReg,
      endpoint,
      allowedHosts: ["example.com", "169.254.169.254", "127.0.0.1", "10.1.2.3", "thing.internal"],
    });
    assert.ok(err, `expected ${endpoint} to be rejected`);
  }
});

test("register: peerId shape and required fields are enforced", () => {
  assert.match(String(validateRegisterPeer({ ...baseReg, peerId: "Bad_Id", endpoint: "x" })), /peerId must be/);
  assert.match(String(validateRegisterPeer({ displayName: "x", tenantId: "t" })), /required/);
  assert.match(
    String(
      validateRegisterPeer({
        ...baseReg,
        endpoint: "https://REPLACE-ME",
        auth: { kind: "bearer-env" },
      })
    ),
    /authEnvVar is required/
  );
});

test("isPeerCallable mirrors the SSRF decision", () => {
  assert.equal(isPeerCallable(peerFixture()), true);
  assert.equal(
    isPeerCallable(peerFixture({ endpoint: "https://REPLACE-ME-x.example.com" })),
    false
  );
  assert.equal(isPeerCallable(peerFixture({ allowedHosts: ["nope.example.org"] })), false);
});

test("parseAllowedHosts splits on commas, spaces and newlines", () => {
  assert.deepEqual(parseAllowedHosts("a.com, b.com\n c.com"), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(parseAllowedHosts("  "), []);
});

// --------------------------------------------------------------------------- //
// Two-stage Cedar authorization
// --------------------------------------------------------------------------- //

test("authz: peer-scoped policy detection is exact, not a prefix match", () => {
  assert.equal(peerScopedTool("sales-agent"), "a2a:sales-agent");
  assert.equal(peerScopedPolicyExists(store.policies, "sales-agent"), true);
  // No seeded policy names this peer, so only the perimeter applies.
  assert.equal(peerScopedPolicyExists(store.policies, "supply-chain-agent"), false);
});

test("authz: manager is allowed through perimeter + peer-scoped policy", () => {
  const a = authorizeCall("sales-agent", "persona-john"); // seniority_manager
  assert.equal(a.perimeter.allowed, true);
  assert.equal(a.peerScoped.evaluated, true);
  assert.equal(a.allowed, true);
});

test("authz: director is allowed by the companion peer-scoped policy", () => {
  const a = authorizeCall("sales-agent", "persona-mary"); // seniority_director
  assert.equal(a.allowed, true);
  assert.equal(a.peerScoped.evaluated, true);
});

test("authz: an IC is allowed at the perimeter but DENIED by the peer-scoped rule", () => {
  // The peer-scoped policies name only manager and director, so an IC persona
  // must fail closed on this peer while still passing the A2A perimeter.
  const ic = {
    id: "persona-a2a-ic",
    name: "Test IC",
    sub: "test-sub",
    email: "ic@anycompany.com",
    provider: "AWS Cognito" as const,
    groups: ["seniority_ic"],
    attributes: { group: "seniority_ic", role: "ic", approvalLimit: "0" },
  };
  store.personas.push(ic);
  try {
    const a = authorizeCall("sales-agent", ic.id);
    assert.equal(a.perimeter.allowed, true, "perimeter should permit any persona");
    assert.equal(a.peerScoped.evaluated, true);
    assert.equal(a.allowed, false, "peer-scoped rule must deny an IC");
  } finally {
    store.personas = store.personas.filter((p) => p.id !== ic.id);
  }
});

test("authz: with no peer-scoped policy, the perimeter decision stands", () => {
  const a = authorizeCall("supply-chain-agent", "persona-john");
  assert.equal(a.allowed, true);
  assert.equal(a.peerScoped.evaluated, false);
  assert.match(a.peerScoped.reason, /perimeter decision stands/);
});

test("authz: an unknown persona is denied and stage 2 is not reached", () => {
  const a = authorizeCall("sales-agent", "persona-does-not-exist");
  assert.equal(a.allowed, false);
  assert.equal(a.peerScoped.evaluated, false);
});

// --------------------------------------------------------------------------- //
// Lifecycle + optimistic concurrency
// --------------------------------------------------------------------------- //

test("lifecycle: state machine matches registry records and graph sources", () => {
  assert.equal(canTransition("Draft", "Pending approval"), true);
  assert.equal(canTransition("Pending approval", "Approved"), true);
  assert.equal(canTransition("Approved", "Deprecated"), true);
  assert.equal(canTransition("Draft", "Approved"), false);
  assert.equal(canTransition("Deprecated", "Draft"), false);
});

test("store: seeded peers ship preview-only and one is unapproved on purpose", () => {
  const peers = listPeers();
  assert.ok(peers.length >= 2);
  assert.ok(peers.every((p) => !isPeerCallable(p)), "seeds must be placeholders");
  assert.ok(peers.some((p) => p.status !== "Approved"), "one seed must be unapproved");
});

test("store: create -> transition walks the lifecycle and bumps rev", () => {
  const id = "test-peer-" + Math.random().toString(36).slice(2, 8);
  const created = createPeer({
    peerId: id,
    displayName: "Test Peer",
    tenantId: "takeda",
    endpoint: "https://REPLACE-ME-test.example.com",
  });
  assert.equal(created.status, "Draft");
  assert.equal(created.rev, 1);

  const pending = transitionPeer(id, "Pending approval", 1);
  assert.equal(pending.status, "Pending approval");
  assert.equal(pending.rev, 2);

  // Stale rev loses the race.
  assert.throws(() => transitionPeer(id, "Approved", 1), A2AVersionConflictError);
  // Illegal jump is refused.
  assert.throws(() => transitionPeer(id, "Draft", 2), A2ATransitionError);

  const approved = transitionPeer(id, "Approved", 2);
  assert.equal(approved.status, "Approved");
  assert.equal(getPeer(id)?.status, "Approved");
});

test("store: duplicate peerId is refused", () => {
  const id = "dup-peer-" + Math.random().toString(36).slice(2, 8);
  createPeer({
    peerId: id,
    displayName: "A",
    tenantId: "takeda",
    endpoint: "https://REPLACE-ME.example.com",
  });
  assert.throws(
    () =>
      createPeer({
        peerId: id,
        displayName: "B",
        tenantId: "takeda",
        endpoint: "https://REPLACE-ME.example.com",
      }),
    A2AVersionConflictError
  );
});

// --------------------------------------------------------------------------- //
// Offline guarantee
// --------------------------------------------------------------------------- //

test("a2a modules: only card.ts and client.ts may call fetch()", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "a2a");
  const allowed = new Set(["card.ts", "client.ts"]);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    if (!allowed.has(f)) {
      assert.ok(!/\bfetch\s*\(/.test(src), `${f} must not perform egress`);
    }
  }
});
