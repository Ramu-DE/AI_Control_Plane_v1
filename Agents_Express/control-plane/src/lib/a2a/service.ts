// A2A service layer — orchestrates policy, egress, and audit.
//
// This is the only module that composes the governed call: it never trusts the
// caller for authorization, and it writes an audit event on every outcome
// (allow, deny, preview, transport failure) so an A2A exchange is always
// attributable. Server-only.

import { logAudit, store } from "../store";
import { fetchCard } from "./card";
import { buildSendEnvelope, resolveAuthHeaders, sendMessage } from "./client";
import { authorizeCall, isPeerCallable } from "./logic";
import { newMessageId, requirePeer, setPeerCard } from "./store";
import { A2AConfigError, A2ADeniedError } from "./types";
import type { A2AExchange, A2APeer, A2ASendRequest } from "./types";

/** Resolve a persona id to a display name for the audit actor field. */
function actorFor(personaId: string): string {
  return store.personas.find((p) => p.id === personaId)?.name ?? personaId;
}

/**
 * Discover (or refresh) a peer's Agent Card and persist it on the peer.
 *
 * Discovery is a read against the peer and is permitted for any registered
 * peer regardless of lifecycle state — you generally need the card in order to
 * decide whether to approve the peer at all. Egress is still SSRF-checked.
 */
export async function discoverPeer(peerId: string): Promise<A2APeer> {
  const peer = requirePeer(peerId);
  // Auth headers are resolved so a bearer-protected card endpoint works, and so
  // a misconfigured env var fails loudly here rather than mid-send.
  const headers = resolveAuthHeaders(peer);
  try {
    const { card, path } = await fetchCard(peer.endpoint, peer.allowedHosts, { headers });
    const updated = setPeerCard(peerId, card, peer.rev);
    logAudit({
      category: "a2a",
      action: "discover",
      actor: "console-user",
      detail: `Discovered Agent Card for '${peerId}' via ${path} (${card.skills.length} skill(s))`,
    });
    return updated;
  } catch (e) {
    logAudit({
      category: "a2a",
      action: "discover-error",
      actor: "console-user",
      detail: `Agent Card discovery failed for '${peerId}': ${(e as Error).message}`,
    });
    throw e;
  }
}

/**
 * Send an A2A message to a peer, under policy.
 *
 * Order of operations is deliberate and fails closed at each step:
 *   1. peer must exist and be Approved
 *   2. Cedar two-stage check (perimeter, then peer-scoped)
 *   3. preview short-circuits BEFORE any egress
 *   4. endpoint must be configured + allowlisted
 *   5. egress, then normalize + audit
 */
export async function sendToPeer(req: A2ASendRequest): Promise<A2AExchange> {
  const peer = requirePeer(req.peerId);
  const actor = actorFor(req.personaId);
  const at = new Date().toISOString();

  if (peer.status !== "Approved") {
    throw new A2AConfigError(
      `peer '${peer.peerId}' is ${peer.status}; only an Approved peer can be called`
    );
  }

  const authorization = authorizeCall(peer.peerId, req.personaId);
  if (!authorization.allowed) {
    logAudit({
      category: "a2a",
      action: "deny-send",
      actor,
      detail: `DENY A2A call to '${peer.peerId}' — ${
        authorization.peerScoped.evaluated && !authorization.peerScoped.allowed
          ? authorization.peerScoped.reason
          : authorization.perimeter.reason
      }`,
    });
    throw new A2ADeniedError("A2A call denied by policy", authorization);
  }

  const envelope = buildSendEnvelope({
    text: req.text,
    messageId: newMessageId(),
    skillId: req.skillId,
    sessionId: req.sessionId,
  });

  if (req.preview) {
    logAudit({
      category: "a2a",
      action: "preview-send",
      actor,
      detail: `ALLOW A2A routing preview for '${peer.peerId}' (no egress)`,
    });
    return {
      mode: "preview",
      peerId: peer.peerId,
      request: envelope,
      authorization,
      reply: null,
      latencyMs: null,
      at,
    };
  }

  if (!isPeerCallable(peer)) {
    throw new A2AConfigError(
      `peer '${peer.peerId}' has a placeholder or non-allowlisted endpoint. Configure it, or use routing preview.`
    );
  }

  try {
    const { reply, latencyMs } = await sendMessage(peer, envelope);
    logAudit({
      category: "a2a",
      action: "send",
      actor,
      detail: `ALLOW A2A call to '${peer.peerId}'${
        req.skillId ? ` skill '${req.skillId}'` : ""
      } — ${reply.text.length} char reply in ${latencyMs}ms`,
    });
    return {
      mode: "live",
      peerId: peer.peerId,
      request: envelope,
      authorization,
      reply,
      latencyMs,
      at,
    };
  } catch (e) {
    const message = (e as Error).message;
    logAudit({
      category: "a2a",
      action: "send-error",
      actor,
      detail: `A2A call to '${peer.peerId}' failed: ${message}`,
    });
    return {
      mode: "live",
      peerId: peer.peerId,
      request: envelope,
      authorization,
      reply: null,
      latencyMs: null,
      error: message,
      at,
    };
  }
}
