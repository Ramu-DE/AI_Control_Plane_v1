// A2A JSON-RPC client — the control plane's outbound messaging path.
//
// Split deliberately into pure and impure halves so the envelope and the reply
// parsing are unit-testable offline:
//   buildSendEnvelope()  pure  — the exact JSON-RPC body we will POST
//   normalizeReply()     pure  — flattens a Task|Message result to text
//   sendMessage()        I/O   — the single fetch, after policy has allowed it
//
// Credentials are resolved HERE from an env var reference and never returned to
// a caller, logged, or persisted (mirrors lib/graph/neo4j.ts).

import { validateOutboundUrl } from "../graph/logic";
import { A2AConfigError, A2ATransportError } from "./types";
import type { A2APeer, A2AReply } from "./types";

/** JSON-RPC method for a single-shot (non-streaming) A2A message. */
export const A2A_METHOD = "message/send";

const MAX_REPLY_BYTES = 512 * 1024;

export interface SendEnvelopeInput {
  text: string;
  messageId: string;
  skillId?: string;
  sessionId?: string;
}

/**
 * Build the JSON-RPC 2.0 envelope for `message/send`.
 *
 * The message carries a single text part — the A2A `Part` union also allows
 * file and data parts, which this control plane does not originate.
 */
export function buildSendEnvelope(input: SendEnvelopeInput): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "user",
    parts: [{ kind: "text", text: input.text }],
    messageId: input.messageId,
    kind: "message",
  };
  if (input.sessionId) message.contextId = input.sessionId;

  const params: Record<string, unknown> = { message };
  // A requested skill is advertised as metadata rather than a protocol field:
  // skill selection is not part of `message/send`, so a peer that ignores it
  // still behaves correctly.
  if (input.skillId) params.metadata = { skillId: input.skillId };

  return {
    jsonrpc: "2.0",
    id: input.messageId,
    method: A2A_METHOD,
    params,
  };
}

type AnyRecord = Record<string, unknown>;

function collectText(parts: unknown, acc: { text: string[]; dropped: number }): void {
  if (!Array.isArray(parts)) return;
  for (const p of parts) {
    if (!p || typeof p !== "object") {
      acc.dropped += 1;
      continue;
    }
    const part = p as AnyRecord;
    // `kind` is the current discriminator; `type` appears in older peers.
    const kind = part.kind ?? part.type;
    if (kind === "text" && typeof part.text === "string") {
      acc.text.push(part.text);
    } else {
      acc.dropped += 1;
    }
  }
}

/**
 * Flatten an A2A result into text.
 *
 * A peer may answer with a `Message` (immediate reply) or a `Task` (whose
 * `status.message` and/or `artifacts[]` hold the content). Both are handled,
 * and anything that is not a text part is counted rather than silently ignored.
 */
export function normalizeReply(result: unknown): A2AReply {
  const acc = { text: [] as string[], dropped: 0 };
  if (!result || typeof result !== "object") {
    return { text: "", droppedParts: 0 };
  }
  const r = result as AnyRecord;

  // Message shape: { kind:"message", parts:[...] }
  collectText(r.parts, acc);

  // Task shape: { id, status:{ state, message:{ parts } }, artifacts:[{ parts }] }
  const status = (r.status && typeof r.status === "object" ? r.status : {}) as AnyRecord;
  const statusMessage = (status.message && typeof status.message === "object"
    ? status.message
    : {}) as AnyRecord;
  collectText(statusMessage.parts, acc);

  if (Array.isArray(r.artifacts)) {
    for (const a of r.artifacts) {
      if (a && typeof a === "object") collectText((a as AnyRecord).parts, acc);
    }
  }

  const taskId = typeof r.id === "string" ? r.id : undefined;
  const state = typeof status.state === "string" ? status.state : undefined;

  return {
    text: acc.text.join("\n").trim(),
    ...(taskId ? { taskId } : {}),
    ...(state ? { state } : {}),
    droppedParts: acc.dropped,
  };
}

/**
 * Resolve the outbound Authorization header for a peer, if any.
 *
 * Returns an empty object for `none`/`iam-role` (SigV4 signing for iam-role is
 * a production concern and is deliberately NOT faked here). Throws when a
 * bearer peer names an env var that is not set, so the failure is explicit
 * rather than an unauthenticated call.
 */
export function resolveAuthHeaders(peer: A2APeer): Record<string, string> {
  if (peer.auth.kind === "bearer-env") {
    const name = peer.auth.authEnvVar?.trim();
    if (!name) {
      throw new A2AConfigError("peer auth is 'bearer-env' but no authEnvVar is set");
    }
    const value = process.env[name];
    if (!value) {
      throw new A2AConfigError(
        `peer auth env var '${name}' is not set on the server`
      );
    }
    return { authorization: `Bearer ${value}` };
  }
  return {};
}

export interface SendResult {
  reply: A2AReply;
  latencyMs: number;
  /** The raw JSON-RPC result, for the trace view. */
  raw: unknown;
}

/**
 * Which URL a JSON-RPC call actually goes to.
 *
 * In A2A the registered address is where a peer is FOUND; the `url` on its
 * discovered Agent Card is where its RPC endpoint lives, and the two are
 * normally different — a card at `https://host/.well-known/agent-card.json`
 * routinely advertises `https://host/api/a2a/rpc`.
 *
 * Posting to `peer.endpoint` regardless made discovery decorative and broke
 * every peer that follows the spec: against this platform's own card it POSTed
 * to the site root and got HTML back, reported as "returned non-JSON response"
 * — a confusing transport error for what was really a routing bug.
 *
 * THE CARD IS UNTRUSTED INPUT. It is fetched from the peer, so its `url` is
 * chosen by the peer. It is returned here as a candidate only: the caller
 * re-runs `validateOutboundUrl` against the peer's own allowlist, so a peer
 * cannot use its card to redirect this platform's egress at a host the
 * operator never approved. A card URL on an unapproved host is rejected rather
 * than silently falling back, because a silent fallback would send the message
 * somewhere the card said not to.
 */
export function rpcTargetFor(peer: A2APeer): string {
  const fromCard = peer.card?.url?.trim();
  return fromCard ? fromCard : peer.endpoint;
}

/**
 * POST a JSON-RPC envelope to a peer and normalize the reply.
 *
 * The caller is responsible for policy evaluation BEFORE invoking this — this
 * function performs the egress only. The endpoint is re-validated here as
 * defense in depth, so no code path can reach `fetch` unchecked.
 */
export async function sendMessage(
  peer: A2APeer,
  envelope: Record<string, unknown>,
  opts: { timeoutMs?: number } = {}
): Promise<SendResult> {
  const target = rpcTargetFor(peer);
  const policy = validateOutboundUrl(target, peer.allowedHosts);
  if (!policy.ok) {
    throw new A2AConfigError(
      policy.placeholder
        ? "peer endpoint is a placeholder — configure it before sending"
        : `peer endpoint rejected: ${policy.reason}`
    );
  }

  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 25_000, 1_000), 30_000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...resolveAuthHeaders(peer),
  };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw new A2ATransportError(
      `could not reach peer '${peer.peerId}': ${(e as Error).message}`
    );
  }
  const latencyMs = Date.now() - started;

  const text = (await res.text()).slice(0, MAX_REPLY_BYTES);
  if (!res.ok) {
    throw new A2ATransportError(
      `peer '${peer.peerId}' returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new A2ATransportError(`peer '${peer.peerId}' returned non-JSON response`);
  }

  const b = (body ?? {}) as AnyRecord;
  if (b.error) {
    const err = b.error as AnyRecord;
    throw new A2ATransportError(
      `peer '${peer.peerId}' JSON-RPC error ${err.code ?? "?"}: ${err.message ?? "unknown"}`
    );
  }

  return { reply: normalizeReply(b.result), latencyMs, raw: b.result };
}
