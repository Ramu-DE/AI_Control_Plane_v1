// The A2A Agent Card for THIS platform.
//
// Reachable at /.well-known/agent-card.json via a rewrite in next.config.mjs,
// because a folder literally named `.well-known` is treated as hidden and not
// routed. The rewrite keeps the protocol path while the handler lives somewhere
// Next will actually serve.
//
// Public and unauthenticated BY DESIGN: a peer must be able to read the card to
// learn how to authenticate. It therefore exposes names and descriptions only —
// never a model id, a credential reference, or a tool's implementation.

import { NextRequest, NextResponse } from "next/server";
import { buildAgentCard, configuredSelfBaseUrl } from "@/lib/a2a/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public base URL to advertise.
 *
 * A configured `A2A_SELF_BASE_URL` wins, because only the operator knows the
 * client-facing address: behind a TLS-terminating CDN, `x-forwarded-proto` is
 * `http` and the derived card advertised an endpoint an HTTPS-only A2A client
 * will not call.
 *
 * Request derivation remains the fallback so a local or single-hop deployment
 * needs no configuration at all. `x-forwarded-*` is honoured there because the
 * card must advertise the address a CALLER can reach, not the one the process
 * is bound to.
 */
function publicBaseUrl(req: NextRequest): string {
  const configured = configuredSelfBaseUrl();
  if (configured) return configured;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const prefix = process.env.BASE_PATH ?? "";
  return `${proto}://${host}${prefix}`;
}

export async function GET(req: NextRequest) {
  const card = buildAgentCard(publicBaseUrl(req));
  return NextResponse.json(card, {
    headers: {
      // Short cache: the skill list changes whenever an agent becomes ready,
      // and a stale card advertises agents that cannot be addressed.
      "cache-control": "public, max-age=30",
      "content-type": "application/json",
    },
  });
}
