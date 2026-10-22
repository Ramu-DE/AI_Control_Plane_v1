// Offline tests for the A2A SERVER side — this platform AS a peer.
//
// The outbound direction was already covered by a2a.test.ts. Inbound is the
// harder half: an outbound call is made by a persona the console already
// authenticated, while an inbound one arrives from outside claiming whatever it
// likes. So what is asserted here is mostly about refusal:
//
//  - fail closed when the feature is unconfigured (no token, no persona,
//    persona that does not exist)
//  - constant-time token comparison, and no near-miss acceptance
//  - strict JSON-RPC parsing, with the request id still echoed on rejection
//  - skill routing that refuses to guess between several exposed agents
//  - only `ready` agents advertised or addressable
//  - the card's RPC url survives a proxy that lies about the scheme
//
// Also covers two bugs found while wiring the Sales ⇄ Supply Chain scenario
// end to end: the outbound client ignored the discovered card's RPC url, and
// the composed prompt gave the model no date to reason from.
//
// No network: nothing here calls fetch(). Deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  A2AServerError,
  INBOUND_PERSONA_VAR,
  INBOUND_TOKEN_VAR,
  SELF_BASE_URL_VAR,
  authenticateInbound,
  buildAgentCard,
  configuredSelfBaseUrl,
  errorEnvelope,
  exposedAgents,
  parseSendRequest,
  peekRequestId,
  resolveTargetAgent,
  skillsForAgents,
  successEnvelope,
} from "../src/lib/a2a/server.ts";
import { rpcTargetFor } from "../src/lib/a2a/client.ts";
import { composePrompt } from "../src/lib/workflow/resolve.ts";
import { store } from "../src/lib/store.ts";
import type { A2APeer } from "../src/lib/a2a/types.ts";
import type { AgentConfig } from "../src/lib/types.ts";

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

/** Run `fn` with env vars set, restoring whatever was there before. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** node:assert's throws() returns nothing, so capture the error to inspect it. */
function caught(fn: () => unknown): A2AServerError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof A2AServerError, `expected A2AServerError, got ${String(e)}`);
    return e as A2AServerError;
  }
  assert.fail("expected a throw");
}

const TOKEN = "s3cret-inbound-token";
/** A persona that really exists in the seed, so auth gets past the lookup. */
const REAL_PERSONA = "persona-john";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-x",
    name: "Agent X",
    description: "",
    tenantId: "bu-us",
    modelId: "model-dbx-llama-70b",
    systemPrompt: "",
    memoryRefs: [],
    toolRefs: [],
    knowledgeRefs: [],
    compute: {
      agentRuntimeId: "databricks-agent-runtime",
      modelRuntimeId: "databricks-fm-api-pay-per-token",
    },
    visibility: "public",
    status: "ready",
    createdAt: new Date().toISOString(),
    ...over,
  } as AgentConfig;
}

function sendBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: "req-1",
    method: "message/send",
    params: { message: { parts: [{ kind: "text", text: "hello" }] } },
    ...over,
  };
}

// --------------------------------------------------------------------------- //
// authentication: fail closed
// --------------------------------------------------------------------------- //

test("inbound A2A is disabled until a token is configured", () => {
  withEnv({ [INBOUND_TOKEN_VAR]: undefined, [INBOUND_PERSONA_VAR]: REAL_PERSONA }, () => {
    // A platform that accepts unauthenticated agent invocations the moment it
    // is deployed is worse than one that refuses until configured.
    const err = caught(() => authenticateInbound(`Bearer ${TOKEN}`));
    assert.equal(err.status, 503);
    assert.match(err.message, /not enabled/);
  });
});

test("a configured token is required even when a persona is set", () => {
  withEnv({ [INBOUND_TOKEN_VAR]: TOKEN, [INBOUND_PERSONA_VAR]: REAL_PERSONA }, () => {
    for (const header of [null, "", "Bearer ", "Bearer wrong", TOKEN.slice(0, -1)]) {
      const err = caught(() => authenticateInbound(header));
      assert.equal(err.status, 401, `header ${JSON.stringify(header)} must not authenticate`);
    }
  });
});

test("a correct token authenticates and yields the configured persona", () => {
  withEnv({ [INBOUND_TOKEN_VAR]: TOKEN, [INBOUND_PERSONA_VAR]: REAL_PERSONA }, () => {
    assert.deepEqual(authenticateInbound(`Bearer ${TOKEN}`), { personaId: REAL_PERSONA });
    // The scheme is case-insensitive and a bare token is accepted.
    assert.deepEqual(authenticateInbound(`bearer ${TOKEN}`), { personaId: REAL_PERSONA });
    assert.deepEqual(authenticateInbound(TOKEN), { personaId: REAL_PERSONA });
  });
});

test("a token without a persona is refused: nothing to Cedar-check against", () => {
  withEnv({ [INBOUND_TOKEN_VAR]: TOKEN, [INBOUND_PERSONA_VAR]: undefined }, () => {
    const err = caught(() => authenticateInbound(`Bearer ${TOKEN}`));
    assert.equal(err.status, 503);
    assert.match(err.message, /service persona/);
  });
});

test("a persona that does not exist is refused rather than invented", () => {
  withEnv({ [INBOUND_TOKEN_VAR]: TOKEN, [INBOUND_PERSONA_VAR]: "persona-nobody" }, () => {
    const err = caught(() => authenticateInbound(`Bearer ${TOKEN}`));
    assert.equal(err.status, 503);
    assert.match(err.message, /does not exist/);
  });
});

// --------------------------------------------------------------------------- //
// JSON-RPC parsing
// --------------------------------------------------------------------------- //

test("parseSendRequest accepts a well-formed message/send", () => {
  const parsed = parseSendRequest(
    sendBody({
      params: {
        message: {
          contextId: "ctx-1",
          parts: [
            { kind: "text", text: "line one" },
            { kind: "data", data: {} },
            { kind: "text", text: "line two" },
          ],
        },
        metadata: { skillId: "agent-supply-chain" },
      },
    })
  );
  assert.equal(parsed.id, "req-1");
  // Non-text parts are dropped, not stringified.
  assert.equal(parsed.text, "line one\nline two");
  assert.equal(parsed.skillId, "agent-supply-chain");
  assert.equal(parsed.contextId, "ctx-1");
});

test("parseSendRequest refuses malformed requests instead of coercing them", () => {
  const cases: Array<[unknown, number]> = [
    [null, -32700],
    ["not an object", -32700],
    [sendBody({ jsonrpc: "1.0" }), -32600],
    [sendBody({ id: undefined }), -32600],
    [sendBody({ id: null }), -32600],
    [sendBody({ method: "tasks/get" }), -32601],
    [sendBody({ params: { message: { parts: [] } } }), -32602],
    [sendBody({ params: { message: { parts: [{ kind: "text", text: "   " }] } } }), -32602],
    [sendBody({ params: {} }), -32602],
  ];
  for (const [body, code] of cases) {
    const err = caught(() => parseSendRequest(body));
    assert.equal(err.rpcCode, code, `body ${JSON.stringify(body)} => ${code}`);
  }
});

test("a numeric id of 0 is a real id, not a missing one", () => {
  // `id || ""` would have treated 0 as absent and rejected a legal request.
  assert.equal(parseSendRequest(sendBody({ id: 0 })).id, 0);
  assert.equal(peekRequestId({ id: 0 }), 0);
  // ...and it must survive into the error envelope too.
  assert.equal(errorEnvelope(0, -32000, "x").id, 0);
});

test("the request id is echoed even when the request is rejected", () => {
  // JSON-RPC requires the id whenever it can be determined. Deriving it only
  // inside parseSendRequest was not enough: that throws on an unsupported
  // method BEFORE returning, so a caller got id:null and had nothing to
  // correlate the failure with.
  assert.equal(peekRequestId(sendBody({ method: "tasks/get" })), "req-1");
  assert.equal(peekRequestId({ id: 7, method: "nope" }), 7);
  // Only when it genuinely cannot be determined is null correct.
  assert.equal(peekRequestId({ method: "nope" }), null);
  assert.equal(peekRequestId({ id: { nested: true } }), null);
  assert.equal(peekRequestId("garbage"), null);
  assert.equal(errorEnvelope(null, -32700, "bad json").id, null);
});

// --------------------------------------------------------------------------- //
// exposure + skill routing
// --------------------------------------------------------------------------- //

test("only ready agents are exposed as skills", () => {
  const exposed = exposedAgents();
  assert.ok(exposed.length > 0, "the seed must expose at least one ready agent");
  assert.ok(
    exposed.every((a) => a.status === "ready"),
    "a draft agent must never be advertised"
  );
  // Every non-ready seeded agent is absent.
  for (const a of store.agents.filter((x) => x.status !== "ready")) {
    assert.ok(!exposed.some((e) => e.id === a.id), `${a.id} must not be exposed`);
  }
});

test("the skill id is the agent id, which is what makes a skill addressable", () => {
  const skills = skillsForAgents([agent({ id: "agent-sales-demand", name: "Sales Agent" })]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, "agent-sales-demand");
  assert.equal(skills[0].name, "Sales Agent");
  assert.ok(skills[0].tags?.includes("bu-us"), "the tenant is published as a tag");
});

test("a card exposes no model id, credential, or tool implementation", () => {
  const card = buildAgentCard("https://example.test/prefix");
  const serialized = JSON.stringify(card);
  assert.equal(card.url, "https://example.test/prefix/api/a2a/rpc");
  for (const secret of ["databricks-meta-llama", "model-dbx-llama-70b", "DATABRICKS_TOKEN"]) {
    assert.ok(!serialized.includes(secret), `card must not leak '${secret}'`);
  }
});

test("a trailing slash on the base url does not double up in the rpc url", () => {
  assert.equal(
    buildAgentCard("https://example.test/prefix///").url,
    "https://example.test/prefix/api/a2a/rpc"
  );
});

test("skill resolution refuses to guess between several exposed agents", () => {
  const two = [agent({ id: "agent-a" }), agent({ id: "agent-b" })];
  // resolveTargetAgent reads the live store, so assert through it directly.
  const err = caught(() => resolveTargetAgent(undefined));
  // The seed exposes more than one ready agent, so an unaddressed call must
  // fail: silently picking one means an external system gets a different agent
  // than it asked for, and the answer looks plausible either way.
  assert.equal(err.rpcCode, -32602);
  assert.match(err.message, /skillId/);
  assert.equal(two.length, 2); // keeps the intent of the fixture explicit
});

test("an unknown skill is refused, not routed to a default", () => {
  const err = caught(() => resolveTargetAgent("agent-does-not-exist"));
  assert.equal(err.status, 404);
  assert.equal(err.rpcCode, -32602);
});

test("a known skill resolves to that exact agent", () => {
  const target = exposedAgents()[0];
  assert.equal(resolveTargetAgent(target.id).id, target.id);
});

test("the success envelope is the Message shape the client normalizes", () => {
  const env = successEnvelope("req-9", "the answer", "ctx-7") as Record<string, unknown>;
  assert.equal(env.jsonrpc, "2.0");
  assert.equal(env.id, "req-9");
  const result = env.result as Record<string, unknown>;
  assert.equal(result.kind, "message");
  assert.equal(result.role, "agent");
  assert.equal(result.contextId, "ctx-7");
  assert.deepEqual(result.parts, [{ kind: "text", text: "the answer" }]);
  // contextId is omitted rather than set to undefined when there is none.
  assert.ok(!("contextId" in (successEnvelope("r", "t").result as object)));
});

// --------------------------------------------------------------------------- //
// the public base url
// --------------------------------------------------------------------------- //

test("a configured self base url is used, and a malformed one is ignored", () => {
  withEnv({ [SELF_BASE_URL_VAR]: "https://cdn.example.net/proxy/3000/" }, () => {
    // The trailing slash is normalized away so the rpc path cannot double up.
    assert.equal(configuredSelfBaseUrl(), "https://cdn.example.net/proxy/3000");
  });
  // Publishing a nonsense endpoint is worse than falling back to derivation.
  for (const bad of ["", "   ", "not a url", "ftp://cdn.example.net", "/relative/path"]) {
    withEnv({ [SELF_BASE_URL_VAR]: bad }, () => {
      assert.equal(configuredSelfBaseUrl(), null, `'${bad}' must not be published`);
    });
  }
});

// --------------------------------------------------------------------------- //
// outbound: the discovered card decides the rpc target
// --------------------------------------------------------------------------- //

function peer(over: Partial<A2APeer> = {}): A2APeer {
  return {
    peerId: "sales-agent",
    displayName: "Sales Agent",
    description: "",
    tenantId: "bu-us",
    endpoint: "https://peer.example.net/proxy/3000",
    allowedHosts: ["peer.example.net"],
    auth: { kind: "none" },
    card: null,
    status: "Approved",
    owner: "platform-team",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rev: 1,
    ...over,
  } as A2APeer;
}

test("without a card, the registered endpoint is the rpc target", () => {
  assert.equal(rpcTargetFor(peer()), "https://peer.example.net/proxy/3000");
});

test("a discovered card's url wins over the registered endpoint", () => {
  // The registered address is where a peer is FOUND; the card says where its
  // RPC endpoint is, and the two are normally different. Posting to the
  // endpoint regardless made discovery decorative — against this platform's
  // own card it POSTed to the site root, got HTML, and reported the routing
  // bug as "returned non-JSON response".
  const p = peer({
    card: {
      name: "Peer",
      url: "https://peer.example.net/proxy/3000/api/a2a/rpc",
      skills: [],
    } as unknown as A2APeer["card"],
  });
  assert.equal(rpcTargetFor(p), "https://peer.example.net/proxy/3000/api/a2a/rpc");
});

test("a card url on an unapproved host is still subject to the allowlist", async () => {
  // The card is fetched FROM the peer, so its url is peer-chosen input. It is
  // a candidate only — the allowlist is what stops a peer redirecting this
  // platform's egress somewhere the operator never approved.
  const { validateOutboundUrl } = await import("../src/lib/graph/logic.ts");
  const p = peer({
    card: { name: "Peer", url: "https://evil.example.org/rpc", skills: [] } as unknown as A2APeer["card"],
  });
  const target = rpcTargetFor(p);
  assert.equal(target, "https://evil.example.org/rpc");
  const policy = validateOutboundUrl(target, p.allowedHosts);
  assert.equal(policy.ok, false, "an off-allowlist card url must be rejected");
  assert.match(policy.reason ?? "", /allowlist/);
});

test("an empty or whitespace card url falls back to the endpoint", () => {
  for (const url of ["", "   ", undefined]) {
    const p = peer({ card: { name: "P", url, skills: [] } as unknown as A2APeer["card"] });
    assert.equal(rpcTargetFor(p), "https://peer.example.net/proxy/3000");
  }
});

// --------------------------------------------------------------------------- //
// date grounding
// --------------------------------------------------------------------------- //

test("the composed prompt states today's date", () => {
  // A model has no clock, and these agents are asked about dates constantly.
  // Observed live before this fix: asked whether 2026-11-07 was reachable on a
  // 10-day lead time, the supply agent answered "2026-11-17, which is 10 days
  // from today" — wrong arithmetic from a guessed baseline, stated with total
  // confidence, and it inverted the verdict.
  const now = new Date("2026-10-22T19:30:00Z");
  const prompt = composePrompt("You are the Supply Chain Agent.", "Assess ORD-1001.", now);
  assert.match(prompt, /Today's date is 2026-10-22/);
  // Both halves are still present, in order, ahead of the date.
  const iAgent = prompt.indexOf("You are the Supply Chain Agent.");
  const iStep = prompt.indexOf("Assess ORD-1001.");
  const iDate = prompt.indexOf("Today's date");
  assert.ok(iAgent >= 0 && iStep > iAgent && iDate > iStep);
});

test("date grounding is added even when there is no prompt at all", () => {
  const now = new Date("2026-01-05T00:00:00Z");
  assert.match(composePrompt("", "", now), /Today's date is 2026-01-05/);
  assert.match(composePrompt("agent only", "", now), /agent only[\s\S]*2026-01-05/);
  assert.match(composePrompt("", "step only", now), /step only[\s\S]*2026-01-05/);
});
