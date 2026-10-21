// Knowledge Base retrieval API — the governed RAG path.
//
//   GET                     -> queryable KB records + personas (for the UI)
//   POST { recordId, personaId, query, ... }
//                           -> Cedar check -> embed -> provider retrieve -> audit
//
// Policy evaluation, credential resolution and auditing all happen inside
// lib/kb/service.ts; this handler validates input and maps typed errors to
// honest status codes. No credential is ever accepted from, or returned to,
// the caller.

import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import {
  KB_ACTION,
  KB_PERIMETER_TOOL,
  recordScopedPolicyExists,
  recordScopedTool,
  retrieve,
} from "@/lib/kb/service";
import {
  KbConfigError,
  KbDeniedError,
  KbNotFoundError,
  KbTransportError,
} from "@/lib/kb/types";

export const runtime = "nodejs";
export const maxDuration = 45;

function errorResponse(e: unknown): NextResponse {
  if (e instanceof KbDeniedError) {
    return NextResponse.json(
      { error: e.message, code: e.code, authorization: e.authorization },
      { status: 403 }
    );
  }
  if (e instanceof KbNotFoundError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 404 });
  }
  if (e instanceof KbConfigError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
  }
  if (e instanceof KbTransportError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 502 });
  }
  return NextResponse.json({ error: (e as Error).message }, { status: 500 });
}

export async function GET() {
  const records = store.records
    .filter((r) => r.type === "Knowledge Base")
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      provider: r.knowledgeConfig?.provider ?? null,
      // Enough for the UI to explain why a record is not queryable, without
      // exposing any part of the credential reference chain.
      target:
        r.knowledgeConfig?.connection.qdrantCollection ??
        r.knowledgeConfig?.connection.knowledgeBaseId ??
        r.knowledgeConfig?.connection.indexName ??
        null,
      retrieval: r.knowledgeConfig?.retrieval ?? null,
      embedding: r.knowledgeConfig?.embedding ?? null,
      hasAuthReference: Boolean(
        r.knowledgeConfig?.auth?.apiKeyEnvVar || r.knowledgeConfig?.auth?.apiKeySecretRef
      ),
      queryable: r.status === "Approved" && r.knowledgeConfig?.provider === "Qdrant",
      recordScopedPolicy: recordScopedPolicyExists(store.policies, r.id),
    }));

  return NextResponse.json({
    records,
    personas: store.personas.map(({ id, name, email, groups }) => ({
      id,
      name,
      email,
      groups,
    })),
    policy: {
      action: KB_ACTION,
      perimeterTool: KB_PERIMETER_TOOL,
      recordScopedToolExample: recordScopedTool("<recordId>"),
    },
  });
}

interface Body {
  recordId?: string;
  personaId?: string;
  query?: string;
  topK?: number;
  filters?: Record<string, unknown>;
  scoreThreshold?: number;
  preview?: boolean;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.recordId || !body.personaId || !body.query?.trim()) {
    return NextResponse.json(
      { error: "recordId, personaId and query are required" },
      { status: 400 }
    );
  }

  try {
    const out = await retrieve({
      recordId: body.recordId,
      personaId: body.personaId,
      query: body.query.trim(),
      topK: typeof body.topK === "number" ? body.topK : undefined,
      filters: body.filters,
      scoreThreshold:
        typeof body.scoreThreshold === "number" ? body.scoreThreshold : undefined,
      preview: body.preview ?? false,
    });
    // A provider/transport failure is reported inside the payload (with the
    // plan and policy trace) so the UI can still explain what was attempted.
    return NextResponse.json(out, { status: out.error ? 502 : 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
