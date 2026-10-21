import { NextRequest, NextResponse } from "next/server";
import { evaluate } from "@/lib/evaluator";
import { graphSources } from "@/lib/graphStore";
import { logAudit, store } from "@/lib/store";
import { GraphSourceConfig, GraphSourceRecord, RecordStatus } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 35;

type RegisterBody = { op: "register"; source: GraphSourceConfig };
type QueryBody = {
  op: "query";
  graphSourceId: string;
  personaId: string;
  question: string;
  limit?: number;
  preview?: boolean;
};
type Body = RegisterBody | QueryBody;

function isConfiguredUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.hostname.toUpperCase().includes("REPLACE-ME");
  } catch {
    return false;
  }
}

function validateSource(source: GraphSourceConfig): string | null {
  if (!source?.graphSourceId?.trim() || !source.bu?.trim() || !source.displayName?.trim()) {
    return "graphSourceId, bu and displayName are required";
  }
  if (
    !source.ontology?.sparqlUrl?.trim() ||
    !source.ontology.graphUri?.trim() ||
    !source.ontology.namespace?.trim()
  ) {
    return "ontology sparqlUrl, graphUri and namespace are required";
  }
  if (
    !source.backend?.catalog?.trim() ||
    !source.backend.schema?.trim() ||
    !source.backend.registryTable?.trim()
  ) {
    return "backend catalog, schema and registryTable are required";
  }
  if (!source.backend.universalJoinKey?.trim() || !source.llmEndpoint?.trim()) {
    return "backend universalJoinKey and llmEndpoint are required";
  }
  if (source.queryEngineUrl && !/^https:\/\//i.test(source.queryEngineUrl)) {
    return "queryEngineUrl must be an HTTPS URL";
  }
  return null;
}

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

export async function GET() {
  return NextResponse.json({
    sources: graphSources,
    personas: store.personas.map(({ id, name, email, groups }) => ({
      id,
      name,
      email,
      groups,
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Body;

  if (body.op === "register") {
    const error = validateSource(body.source);
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (graphSources.some((source) => source.graphSourceId === body.source.graphSourceId)) {
      return NextResponse.json({ error: "graphSourceId already exists" }, { status: 409 });
    }

    const now = new Date().toISOString();
    const record: GraphSourceRecord = {
      ...body.source,
      graphSourceId: body.source.graphSourceId.trim(),
      bu: body.source.bu.trim(),
      displayName: body.source.displayName.trim(),
      description: body.source.description?.trim() ?? "",
      tags: body.source.tags ?? {},
      version: body.source.version?.trim() || "1.0.0",
      status: "Draft",
      owner: "console-user",
      createdAt: now,
      updatedAt: now,
    };
    graphSources.unshift(record);
    logAudit({
      category: "graph",
      action: "register",
      actor: record.owner,
      detail: `Registered Graph Source '${record.displayName}' as Draft`,
    });
    return NextResponse.json(record, { status: 201 });
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

  const source = graphSources.find((item) => item.graphSourceId === body.graphSourceId);
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
  const actor = store.personas.find((persona) => persona.id === body.personaId)?.name ?? body.personaId;
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
      },
    ],
  };

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
      targetConfigured: isConfiguredUrl(source.queryEngineUrl),
      target: source.queryEngineUrl,
      request: servingRequest,
      decision,
      message: "Policy passed. Preview stopped before the external serving call.",
    });
  }

  if (!isConfiguredUrl(source.queryEngineUrl)) {
    return NextResponse.json(
      {
        error:
          "This Graph Source uses a placeholder serving URL. Configure queryEngineUrl or use routing preview.",
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

const GRAPH_TRANSITIONS: Record<RecordStatus, RecordStatus[]> = {
  Draft: ["Pending approval"],
  "Pending approval": ["Approved", "Rejected"],
  Approved: ["Deprecated"],
  Rejected: ["Draft"],
  Deprecated: [],
};

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    graphSourceId?: string;
    status?: RecordStatus;
  };
  const source = graphSources.find(
    (item) => item.graphSourceId === body.graphSourceId
  );
  if (!source) {
    return NextResponse.json({ error: "graph source not found" }, { status: 404 });
  }
  if (!body.status || !GRAPH_TRANSITIONS[source.status].includes(body.status)) {
    return NextResponse.json(
      {
        error: `Invalid transition ${source.status} → ${body.status ?? "unknown"}`,
      },
      { status: 400 }
    );
  }
  const previous = source.status;
  source.status = body.status;
  source.updatedAt = new Date().toISOString();
  logAudit({
    category: "graph",
    action: "update-status",
    actor: "workshop-administrator",
    detail: `Graph Source '${source.displayName}': ${previous} → ${source.status}`,
  });
  return NextResponse.json(source);
}
