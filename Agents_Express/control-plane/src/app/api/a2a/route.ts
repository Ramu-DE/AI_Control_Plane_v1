// A2A API — peer registry, Agent Card discovery, and governed messaging.
//
//   GET                      -> peers + personas + tenants (for the UI)
//   POST { op:"register" }   -> register a peer (starts as Draft)
//   POST { op:"discover" }   -> fetch + persist a peer's Agent Card
//   POST { op:"send" }       -> governed A2A call (preview or live)
//   PATCH                    -> advance a peer's lifecycle status
//
// Every outbound path is Cedar-checked and audited inside lib/a2a/service.ts;
// this handler only validates input and maps typed errors to status codes.

import { NextRequest, NextResponse } from "next/server";
import { logAudit, store } from "@/lib/store";
import { discoverPeer, sendToPeer } from "@/lib/a2a/service";
import {
  A2A_ACTION,
  A2A_PERIMETER_TOOL,
  isPeerCallable,
  peerScopedPolicyExists,
  peerScopedTool,
  validateRegisterPeer,
} from "@/lib/a2a/logic";
import {
  A2ATransitionError,
  A2AVersionConflictError,
  createPeer,
  listPeers,
  requirePeer,
  transitionPeer,
} from "@/lib/a2a/store";
import {
  A2AConfigError,
  A2ADeniedError,
  A2ANotFoundError,
  A2ATransportError,
} from "@/lib/a2a/types";
import type { RecordStatus } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 35;

/** Map a typed A2A error to an honest HTTP response. */
function errorResponse(e: unknown): NextResponse {
  if (e instanceof A2ADeniedError) {
    return NextResponse.json(
      { error: e.message, code: e.code, authorization: e.authorization },
      { status: 403 }
    );
  }
  if (e instanceof A2ANotFoundError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 404 });
  }
  if (e instanceof A2AVersionConflictError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
  }
  if (e instanceof A2ATransitionError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
  }
  if (e instanceof A2AConfigError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
  }
  if (e instanceof A2ATransportError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 502 });
  }
  return NextResponse.json({ error: (e as Error).message }, { status: 500 });
}

export async function GET() {
  const peers = listPeers().map((p) => ({
    ...p,
    // Surfaced so the UI can explain *why* a peer is preview-only, and whether
    // a peer-scoped Cedar rule is in force, without re-deriving either.
    callable: isPeerCallable(p),
    peerScopedPolicy: peerScopedPolicyExists(store.policies, p.peerId),
  }));
  return NextResponse.json({
    peers,
    personas: store.personas.map(({ id, name, email, groups }) => ({
      id,
      name,
      email,
      groups,
    })),
    tenants: store.tenants.map((t) => ({ id: t.id, tenantName: t.tenantName })),
    policy: {
      action: A2A_ACTION,
      perimeterTool: A2A_PERIMETER_TOOL,
      peerScopedToolExample: peerScopedTool("<peerId>"),
    },
  });
}

type RegisterBody = {
  op: "register";
  peerId: string;
  displayName: string;
  description?: string;
  tenantId: string;
  endpoint: string;
  allowedHosts?: string[];
  auth?: { kind: "none" | "bearer-env" | "iam-role"; authEnvVar?: string; roleArn?: string };
};
type DiscoverBody = { op: "discover"; peerId: string };
type SendBody = {
  op: "send";
  peerId: string;
  personaId: string;
  text: string;
  skillId?: string;
  sessionId?: string;
  preview?: boolean;
};
type Body = RegisterBody | DiscoverBody | SendBody;

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    switch (body.op) {
      case "register": {
        const invalid = validateRegisterPeer(body);
        if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
        if (!store.tenants.some((t) => t.id === body.tenantId)) {
          return NextResponse.json({ error: "unknown tenantId" }, { status: 400 });
        }
        const peer = createPeer({
          peerId: body.peerId.trim(),
          displayName: body.displayName.trim(),
          description: body.description?.trim(),
          tenantId: body.tenantId.trim(),
          endpoint: body.endpoint.trim(),
          allowedHosts: body.allowedHosts ?? [],
          auth: body.auth ?? { kind: "none" },
        });
        logAudit({
          category: "a2a",
          action: "register",
          actor: peer.owner,
          detail: `Registered A2A peer '${peer.displayName}' (${peer.peerId}) as Draft`,
        });
        return NextResponse.json(peer, { status: 201 });
      }

      case "discover": {
        if (!body.peerId) {
          return NextResponse.json({ error: "peerId is required" }, { status: 400 });
        }
        const peer = await discoverPeer(body.peerId);
        return NextResponse.json(peer);
      }

      case "send": {
        if (!body.peerId || !body.personaId || !body.text?.trim()) {
          return NextResponse.json(
            { error: "peerId, personaId and text are required" },
            { status: 400 }
          );
        }
        const exchange = await sendToPeer({
          peerId: body.peerId,
          personaId: body.personaId,
          text: body.text.trim(),
          skillId: body.skillId,
          sessionId: body.sessionId,
          preview: body.preview ?? false,
        });
        // A transport failure is reported inside the exchange (with the trace),
        // so the UI can still show what was sent and the policy decision.
        return NextResponse.json(exchange, { status: exchange.error ? 502 : 200 });
      }

      default:
        return NextResponse.json({ error: "unknown operation" }, { status: 400 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest) {
  let body: { peerId?: string; status?: RecordStatus };
  try {
    body = (await req.json()) as { peerId?: string; status?: RecordStatus };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.peerId || !body.status) {
    return NextResponse.json({ error: "peerId and status are required" }, { status: 400 });
  }
  try {
    const current = requirePeer(body.peerId);
    const from = current.status;
    const updated = transitionPeer(body.peerId, body.status, current.rev);
    logAudit({
      category: "a2a",
      action: "update-status",
      actor: "workshop-administrator",
      detail: `A2A peer '${updated.displayName}': ${from} → ${updated.status}`,
    });
    return NextResponse.json(updated);
  } catch (e) {
    return errorResponse(e);
  }
}
