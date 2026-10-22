// A2A SERVER side — exposing this platform's agents to external callers.
//
// The platform already had an A2A client (card.ts, client.ts) and could call a
// peer. It could not BE one, which made A2A half a feature: you could reach out
// and nothing could reach in.
//
// This serves the two things the protocol needs:
//
//   GET  /.well-known/agent-card.json   what agents exist, as skills
//   POST /api/a2a/rpc                   JSON-RPC 2.0 `message/send`
//
// GOVERNANCE IS THE POINT, and inbound is the harder direction. An outbound
// call is made by a persona the console already authenticated; an inbound one
// arrives from outside with whatever it claims. So:
//
//   - inbound A2A is DISABLED unless A2A_INBOUND_TOKEN is set. Fail closed: a
//     platform that silently accepts unauthenticated agent invocations the
//     moment it is deployed is worse than one that refuses until configured.
//   - the bearer token is compared in constant time, so a wrong token cannot be
//     discovered a byte at a time.
//   - the call executes AS a configured service persona and goes through the
//     same Cedar `runAgent` gate as a workflow step. An external caller cannot
//     choose which persona it runs as — that would make the gate decorative.
//   - only `ready` agents are exposed. A draft agent is not advertised and
//     cannot be addressed.
//   - every inbound call is audited, accepted or refused.
//
// Server-only.

import { createHmac, timingSafeEqual } from "node:crypto";
import { logAudit, store } from "../store";
import type { A2AAgentCard, A2ASkill } from "./types";
import type { AgentConfig } from "../types";

/** Env var holding the shared bearer token. A REFERENCE, never a stored value. */
export const INBOUND_TOKEN_VAR = "A2A_INBOUND_TOKEN";
/** Env var naming the persona inbound calls execute as. */
export const INBOUND_PERSONA_VAR = "A2A_INBOUND_PERSONA";
/** Env var holding this deployment's own public base URL. */
export const SELF_BASE_URL_VAR = "A2A_SELF_BASE_URL";

/**
 * This deployment's public base URL as an OPERATOR declared it, or null.
 *
 * Needed because request-derived values are not trustworthy here.
 * `x-forwarded-proto` reports the scheme of the LAST hop, and this app sits
 * behind a CDN that terminates TLS and then forwards plain HTTP — so the
 * derived card advertised `http://<cdn-host>/...`, which an A2A client with an
 * HTTPS-only outbound policy correctly refuses. The card was therefore
 * unusable at the very address it was published on.
 *
 * Upgrading `http` to `https` whenever a forwarded header appears would be the
 * wrong fix: it would guess, and guess wrong for a deployment genuinely served
 * over HTTP. The public scheme is a deployment fact, so it is configured.
 * Only absolute http(s) URLs are accepted; anything else is ignored rather
 * than published.
 */
export function configuredSelfBaseUrl(): string | null {
  const raw = (process.env[SELF_BASE_URL_VAR] || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return raw;
  } catch {
    return null;
  }
}

export class A2AServerError extends Error {
  readonly status: number;
  /** JSON-RPC error code, where the protocol defines one. */
  readonly rpcCode: number;
  constructor(message: string, status: number, rpcCode = -32600) {
    super(message);
    this.name = "A2AServerError";
    this.status = status;
    this.rpcCode = rpcCode;
  }
}

/**
 * Compare a presented token against the configured one without leaking length
 * or position through timing. Both sides are hashed first so the comparison is
 * over equal-length buffers whatever the input.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const h = (s: string) => createHmac("sha256", "a2a-inbound").update(s).digest();
  const a = h(presented);
  const b = h(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authenticate an inbound A2A request.
 *
 * Returns the persona the call will run as. Throws rather than returning a
 * boolean, so a caller cannot forget to check the result.
 */
export function authenticateInbound(authorization: string | null): { personaId: string } {
  const expected = process.env[INBOUND_TOKEN_VAR];
  if (!expected) {
    throw new A2AServerError(
      `inbound A2A is not enabled on this deployment (${INBOUND_TOKEN_VAR} is unset)`,
      503
    );
  }
  const presented = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!presented || !tokenMatches(presented, expected)) {
    throw new A2AServerError("invalid or missing bearer token", 401, -32000);
  }

  const personaId = process.env[INBOUND_PERSONA_VAR];
  if (!personaId) {
    throw new A2AServerError(
      `inbound A2A has no service persona (${INBOUND_PERSONA_VAR} is unset), so a ` +
        `call could not be Cedar-checked against a principal`,
      503
    );
  }
  if (!store.personas.some((p) => p.id === personaId)) {
    throw new A2AServerError(
      `${INBOUND_PERSONA_VAR} names persona '${personaId}', which does not exist`,
      503
    );
  }
  return { personaId };
}

/** Agents this platform advertises. Only `ready` ones are addressable. */
export function exposedAgents(): AgentConfig[] {
  return store.agents.filter((a) => a.status === "ready");
}

/**
 * One skill per exposed agent.
 *
 * The skill id IS the agent id, which is what makes a skill addressable: the
 * caller sends `metadata.skillId` and the server routes to exactly that agent
 * rather than guessing from the message text.
 */
export function skillsForAgents(agents: AgentConfig[]): A2ASkill[] {
  return agents.map((a) => {
    const tools = a.toolRefs
      .map((id) => store.records.find((r) => r.id === id))
      .filter((r) => r && r.status === "Approved")
      .flatMap((r) => r!.tools);
    return {
      id: a.id,
      name: a.name,
      description:
        a.description ||
        `Agent '${a.name}' on tenant '${a.tenantId}'.` +
          (tools.length ? ` Tools: ${tools.join(", ")}.` : ""),
      tags: [a.tenantId, ...(tools.length ? ["tool-using"] : [])],
      examples: [],
    } as A2ASkill;
  });
}

/**
 * Build this platform's agent card.
 *
 * `url` is the RPC endpoint a caller should POST to. It is derived from the
 * request rather than configured, so the card stays correct behind a proxy or a
 * path prefix instead of advertising an address that only works in one
 * deployment.
 */
export function buildAgentCard(publicBaseUrl: string): Omit<A2AAgentCard, "fetchedFrom" | "fetchedAt"> {
  const agents = exposedAgents();
  const base = publicBaseUrl.replace(/\/+$/, "");
  return {
    name: "AgentExpress Control Plane",
    description:
      "Governed agent platform. Each skill is a registered agent; calls are " +
      "Cedar-authorized, tool use is restricted to approved registry records, " +
      "and every invocation is audited.",
    url: `${base}/api/a2a/rpc`,
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    skills: skillsForAgents(agents),
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
  };
}

/**
 * Recover the JSON-RPC id from a body that may be otherwise invalid.
 *
 * JSON-RPC requires the id to be echoed in an error response whenever it can be
 * determined, and only `null` when it cannot. Deriving it inside
 * `parseSendRequest` was not enough: that function throws on an unsupported
 * method BEFORE returning, so a client sending `{"id":"3","method":"tasks/get"}`
 * got `id: null` back and had nothing to correlate the failure with.
 */
export function peekRequestId(body: unknown): string | number | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export interface ParsedSend {
  /** JSON-RPC id, echoed back. */
  id: string | number;
  text: string;
  skillId?: string;
  contextId?: string;
}

/**
 * Parse a `message/send` request.
 *
 * Deliberately strict: an unknown method or a message with no text is refused
 * rather than coerced, because guessing what an external caller meant is how a
 * protocol boundary turns into an attack surface.
 */
export function parseSendRequest(body: unknown): ParsedSend {
  if (!body || typeof body !== "object") {
    throw new A2AServerError("request body must be a JSON-RPC object", 400, -32700);
  }
  const r = body as Record<string, unknown>;
  if (r.jsonrpc !== "2.0") {
    throw new A2AServerError("jsonrpc must be '2.0'", 400, -32600);
  }
  const id = typeof r.id === "string" || typeof r.id === "number" ? r.id : "";
  if (id === "") {
    throw new A2AServerError("a request id is required", 400, -32600);
  }
  if (r.method !== "message/send") {
    throw new A2AServerError(
      `method '${String(r.method)}' is not supported; this peer implements message/send`,
      400,
      -32601
    );
  }
  const params = (r.params ?? {}) as Record<string, unknown>;
  const message = (params.message ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts
    .map((p) => {
      const part = (p ?? {}) as Record<string, unknown>;
      return part.kind === "text" && typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) {
    throw new A2AServerError("message.parts contained no text", 400, -32602);
  }
  const metadata = (params.metadata ?? {}) as Record<string, unknown>;
  return {
    id,
    text,
    ...(typeof metadata.skillId === "string" ? { skillId: metadata.skillId } : {}),
    ...(typeof message.contextId === "string" ? { contextId: message.contextId } : {}),
  };
}

/**
 * Resolve which agent a request addresses.
 *
 * A skillId is required when more than one agent is exposed. Picking one for
 * the caller would mean an external system silently getting a different agent
 * than it asked for — and the answer would look plausible either way.
 */
export function resolveTargetAgent(skillId: string | undefined): AgentConfig {
  const agents = exposedAgents();
  if (agents.length === 0) {
    throw new A2AServerError("no ready agent is exposed by this platform", 503, -32000);
  }
  if (!skillId) {
    if (agents.length === 1) return agents[0];
    throw new A2AServerError(
      `this peer exposes ${agents.length} skills; set metadata.skillId to the ` +
        `agent you want (see the agent card)`,
      400,
      -32602
    );
  }
  const found = agents.find((a) => a.id === skillId || a.name === skillId);
  if (!found) {
    throw new A2AServerError(
      `skill '${skillId}' is not exposed; it must be the id of a ready agent`,
      404,
      -32602
    );
  }
  return found;
}

/** The JSON-RPC success envelope, in the Message shape the client normalises. */
export function successEnvelope(
  id: string | number,
  text: string,
  contextId?: string
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      kind: "message",
      role: "agent",
      messageId: `msg-${Date.now().toString(36)}`,
      ...(contextId ? { contextId } : {}),
      parts: [{ kind: "text", text }],
    },
  };
}

export function errorEnvelope(
  id: string | number | null,
  code: number,
  message: string
): Record<string, unknown> {
  // `id ?? null`, not `id || null`: a request id of 0 or "" is still an id the
  // caller is waiting on, and truthiness would quietly drop it.
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Audit an inbound call, accepted or refused. Always called exactly once. */
export function auditInbound(args: {
  outcome: "accepted" | "refused";
  detail: string;
  actor: string;
}): void {
  logAudit({
    category: "a2a",
    action: args.outcome === "accepted" ? "inbound-call" : "inbound-refused",
    actor: args.actor,
    detail: args.detail,
  });
}
