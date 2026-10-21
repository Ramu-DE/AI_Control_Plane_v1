import { NextRequest, NextResponse } from "next/server";
import { evaluate } from "@/lib/evaluator";
import { logAudit, store } from "@/lib/store";
import {
  controlStore,
  registerGraphSource,
  transitionSource,
  validateRegistration,
  NotFoundError,
  InvalidTransitionError,
  VersionConflictError,
} from "@/lib/graph/service";
import { isConfiguredServingUrl } from "@/lib/graph/logic";
import { GraphControlConfigError } from "@/lib/graph/factory";
import type { RegisterInput } from "@/lib/graph/service";
import type { GraphSource, MappingVersion } from "@/lib/graph/entities";
import type { RecordStatus } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 35;

type RegisterBody = { op: "register"; source: RegisterInput };
type QueryBody = {
  op: "query";
  graphSourceId: string;
  personaId: string;
  question: string;
  limit?: number;
  preview?: boolean;
};
type Body = RegisterBody | QueryBody;

function normalizeServingResponse(payload: unknown): unknown {
  let value = payload;
  if (value && typeof value === "object" && "predictions" in value) {
    value = (value as { predictions: unknown }).predictions;
  }
  if (Array.isArray(value)) value = value[0];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return { answer: value };
    }
  }
  return value;
}

function configError(e: unknown): NextResponse | null {
  if (e instanceof GraphControlConfigError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 412 });
  }
  return null;
}

async function listSources(): Promise<GraphSource[]> {
  const ctl = await controlStore();
  // Union of common statuses so the UI shows the full lifecycle. (Local mode
  // ignores the filter keys and returns everything; dynamodb needs a filter.)
  const statuses: RecordStatus[] = [
    "Draft",
    "Pending approval",
    "Approved",
    "Rejected",
    "Deprecated",
  ];
  const seen = new Map<string, GraphSource>();
  for (const status of statuses) {
    const batch = await ctl.listGraphSources({ status });
    for (const s of batch) seen.set(s.graphSourceId, s);
  }
  return [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function GET() {
  try {
    const sources = await listSources();
    return NextResponse.json({
      sources,
      personas: store.personas.map(({ id, name, email, groups }) => ({
        id,
        name,
        email,
        groups,
      })),
    });
  } catch (e) {
    const ce = configError(e);
    if (ce) return ce;
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Body;

  if (body.op === "register") {
    const error = validateRegistration(body.source);
    if (error) return NextResponse.json({ error }, { status: 400 });
    try {
      const ctl = await controlStore();
      if (await ctl.getGraphSource(body.source.graphSourceId.trim())) {
        return NextResponse.json({ error: "graphSourceId already exists" }, { status: 409 });
      }
      const record = await registerGraphSource(body.source, "console-user");
      logAudit({
        category: "graph",
        action: "register",
        actor: record.owner,
        detail: `Registered Graph Source '${record.displayName}' as Draft`,
      });
      return NextResponse.json(record, { status: 201 });
    } catch (e) {
      const ce = configError(e);
      if (ce) return ce;
      if (e instanceof VersionConflictError) {
        return NextResponse.json({ error: "graphSourceId already exists" }, { status: 409 });
      }
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  if (body.op !== "query") {
    return NextResponse.json({ error: "unknown operation" }, { status: 400 });
  }
  if (!body.graphSourceId || !body.personaId || !body.question?.trim()) {
    return NextResponse.json(
      { error: "graphSourceId, personaId and question are required" },
      { status: 400 }
    );
  }

  let source: GraphSource | null;
  let publishedMapping: MappingVersion | undefined;
  try {
    const ctl = await controlStore();
    source = await ctl.getGraphSource(body.graphSourceId);
    if (source) {
      publishedMapping = (await ctl.listMappingVersions(source.graphSourceId))
        .find((version) => version.status === "published");
    }
  } catch (e) {
    const ce = configError(e);
    if (ce) return ce;
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (!source) return NextResponse.json({ error: "graph source not found" }, { status: 404 });
  if (source.status !== "Approved") {
    return NextResponse.json({ error: "graph source is not approved" }, { status: 403 });
  }

  const decision = evaluate({
    personaId: body.personaId,
    agentId: "graph-router",
    action: "queryGraphSource",
    tool: "omda",
    resource: source.graphSourceId,
  });
  const actor =
    store.personas.find((persona) => persona.id === body.personaId)?.name ?? body.personaId;
  if (!decision.allowed) {
    logAudit({
      category: "graph",
      action: "deny-query",
      actor,
      detail: `DENY query to '${source.graphSourceId}'`,
    });
    return NextResponse.json(
      { error: "Graph Source access denied by policy", decision },
      { status: 403 }
    );
  }

  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500);
  const servingRequest = {
    dataframe_records: [
      {
        graph_source_id: source.graphSourceId,
        question: body.question.trim(),
        limit,
        // Pin the exact approved mapping artifact used for this request. The
        // serving endpoint must load/verify this version before planning SQL.
        mapping_version_id: publishedMapping?.mappingVersionId ?? null,
        mapping_version: publishedMapping?.version ?? null,
        mapping_checksum: publishedMapping?.artifactRef.checksum ?? null,
      },
    ],
  };

  const targetConfigured = isConfiguredServingUrl(source.queryEngineUrl, source.allowedHosts);

  if (body.preview) {
    logAudit({
      category: "graph",
      action: "preview-query",
      actor,
      detail: `ALLOW routing preview for '${source.graphSourceId}'`,
    });
    return NextResponse.json({
      mode: "preview",
      graphSourceId: source.graphSourceId,
      targetConfigured,
      target: source.queryEngineUrl,
      request: servingRequest,
      mappingPublished: Boolean(publishedMapping),
      publishedMapping: publishedMapping ?? null,
      decision,
      message: publishedMapping
        ? "Policy passed. Preview is pinned to the published mapping and stopped before the external serving call."
        : "Policy passed, but no mapping is published. Preview stopped before the external serving call.",
    });
  }

  if (!publishedMapping) {
    return NextResponse.json(
      {
        error: "No published mapping version exists for this Graph Source. Complete mapping review and publish before live queries.",
        code: "MAPPING_NOT_PUBLISHED",
      },
      { status: 409 }
    );
  }

  if (!targetConfigured) {
    return NextResponse.json(
      {
        error:
          "This Graph Source uses a placeholder or non-allowlisted serving URL. Configure queryEngineUrl or use routing preview.",
      },
      { status: 503 }
    );
  }

  const token = process.env.GRAPH_SERVING_TOKEN || process.env.DATABRICKS_TOKEN;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token && token !== "REPLACE_ME") headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetch(source.queryEngineUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(servingRequest),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Serving endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const result = normalizeServingResponse(await response.json());
    logAudit({
      category: "graph",
      action: "query",
      actor,
      detail: `ALLOW query to '${source.graphSourceId}'`,
    });
    return NextResponse.json({
      mode: "live",
      graphSourceId: source.graphSourceId,
      decision,
      result,
    });
  } catch (error) {
    logAudit({
      category: "graph",
      action: "query-error",
      actor,
      detail: `Graph query failed for '${source.graphSourceId}': ${(error as Error).message}`,
    });
    return NextResponse.json(
      { error: (error as Error).message || "Graph serving request failed" },
      { status: 502 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    graphSourceId?: string;
    status?: RecordStatus;
  };
  if (!body.graphSourceId || !body.status) {
    return NextResponse.json({ error: "graphSourceId and status are required" }, { status: 400 });
  }
  try {
    const ctl = await controlStore();
    const previous = await ctl.getGraphSource(body.graphSourceId);
    if (!previous) {
      return NextResponse.json({ error: "graph source not found" }, { status: 404 });
    }
    const updated = await transitionSource(body.graphSourceId, body.status);
    logAudit({
      category: "graph",
      action: "update-status",
      actor: "workshop-administrator",
      detail: `Graph Source '${updated.displayName}': ${previous.status} → ${updated.status}`,
    });
    return NextResponse.json(updated);
  } catch (e) {
    const ce = configError(e);
    if (ce) return ce;
    if (e instanceof NotFoundError) {
      return NextResponse.json({ error: "graph source not found" }, { status: 404 });
    }
    if (e instanceof InvalidTransitionError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof VersionConflictError) {
      return NextResponse.json({ error: "conflicting update, retry" }, { status: 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
