// Governed agent memory API.
//
//   GET                       -> usable memory records + the policy names
//   POST { op: "retrieve" }   -> Cedar-checked, scope-bounded recall
//   POST { op: "write" }      -> Cedar-checked session-scoped turn write
//
// Thin by design: every decision (approval state, scope ceiling, namespace
// derivation, Cedar, tenant subtree) lives in lib/memory, so the rules are
// tested without AWS and this file only maps outcomes onto status codes.

import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import {
  MEMORY_ACTION,
  MEMORY_PERIMETER_TOOL,
  memoryScopedTool,
} from "@/lib/memory/logic";
import { recordTurns, retrieveMemory } from "@/lib/memory/service";
import { MEMORY_SCOPES, templateScope } from "@/lib/memory/namespace";
import {
  MemoryConfigError,
  MemoryDeniedError,
  MemoryNotFoundError,
} from "@/lib/memory/types";
import { MemoryNamespaceError } from "@/lib/memory/namespace";

export const runtime = "nodejs";
export const maxDuration = 60;

function errorResponse(e: unknown): NextResponse {
  if (e instanceof MemoryDeniedError) {
    return NextResponse.json(
      { error: e.message, code: e.code, authorization: e.authorization },
      { status: 403 }
    );
  }
  if (e instanceof MemoryNotFoundError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 404 });
  }
  // A namespace error means an identifier could not be made safe. That is a
  // caller/data problem, not a server fault, and must not look like one.
  if (e instanceof MemoryNamespaceError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
  }
  if (e instanceof MemoryConfigError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
  }
  return NextResponse.json({ error: (e as Error).message }, { status: 500 });
}

export async function GET() {
  // Only Approved records are offered. A Draft memory is deliberately absent
  // rather than listed-but-unusable, so the UI cannot invite a dead end.
  const records = store.records
    .filter((r) => r.type === "Memory")
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      owner: r.owner,
      usable: r.status === "Approved" && Boolean(r.memoryConfig),
      // Identifiers and bounds only — never a credential.
      config: r.memoryConfig
        ? {
            memoryId: r.memoryConfig.memoryId,
            region: r.memoryConfig.region,
            strategyId: r.memoryConfig.strategyId,
            scope: templateScope(r.memoryConfig.namespaceTemplate),
            topK: r.memoryConfig.topK,
            eventExpiryDays: r.memoryConfig.eventExpiryDays,
          }
        : null,
    }));

  return NextResponse.json({
    records,
    scopes: MEMORY_SCOPES,
    personas: store.personas.map(({ id, name, groups }) => ({ id, name, groups })),
    policy: {
      action: MEMORY_ACTION,
      perimeterTool: MEMORY_PERIMETER_TOOL,
      scopedToolExample: memoryScopedTool("<recordId>"),
    },
  });
}

type RetrieveBody = {
  op: "retrieve";
  recordId: string;
  personaId: string;
  tenantId: string;
  sessionId: string;
  query: string;
  scope?: (typeof MEMORY_SCOPES)[number];
};
type WriteBody = {
  op: "write";
  recordId: string;
  personaId: string;
  tenantId: string;
  sessionId: string;
  turns: { role: "USER" | "ASSISTANT"; text: string }[];
};
type Body = RetrieveBody | WriteBody;

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const required = ["recordId", "personaId", "tenantId", "sessionId"] as const;
  const missing = required.filter((k) => !(body as Record<string, unknown>)[k]);
  if (missing.length) {
    return NextResponse.json(
      { error: `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required` },
      { status: 400 }
    );
  }

  try {
    if (body.op === "retrieve") {
      if (!body.query?.trim()) {
        return NextResponse.json({ error: "query is required" }, { status: 400 });
      }
      const result = await retrieveMemory({
        recordId: body.recordId,
        personaId: body.personaId,
        tenantId: body.tenantId,
        sessionId: body.sessionId,
        query: body.query,
        scope: body.scope,
      });
      return NextResponse.json(result);
    }

    if (body.op === "write") {
      if (!Array.isArray(body.turns) || body.turns.length === 0) {
        return NextResponse.json(
          { error: "turns must be a non-empty array" },
          { status: 400 }
        );
      }
      const result = await recordTurns({
        recordId: body.recordId,
        personaId: body.personaId,
        tenantId: body.tenantId,
        sessionId: body.sessionId,
        turns: body.turns,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "unknown operation" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
