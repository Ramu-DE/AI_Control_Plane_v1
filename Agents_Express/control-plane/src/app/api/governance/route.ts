import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import {
  InferenceTarget,
  RateLimit,
} from "@/lib/types";

export async function GET() {
  return NextResponse.json({
    targets: store.inferenceTargets,
    rateLimits: store.rateLimits,
    gatewayModels: store.models.filter(
      (m) => m.inferenceProvider === "AgentCore Gateway"
    ),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as
    | ({ op: "add-target" } & Partial<InferenceTarget>)
    | ({ op: "add-ratelimit" } & Partial<RateLimit>)
    | { op: "delete-ratelimit"; id: string };

  if (body.op === "add-target") {
    if (!body.name) {
      return NextResponse.json({ error: "Target name required" }, { status: 400 });
    }
    if (store.inferenceTargets.some((t) => t.name === body.name)) {
      return NextResponse.json({ error: "Target name already exists" }, { status: 400 });
    }
    const target: InferenceTarget = {
      id: newId("target"),
      name: body.name,
      description: body.description ?? "",
      status: "READY",
      source: body.source ?? "Custom",
      connector: body.connector,
      endpoint: body.endpoint,
      apiPath: body.apiPath,
      models: body.models ?? [],
      passthrough: body.passthrough ?? false,
      outboundAuth: body.outboundAuth ?? "IAM Role",
      createdAt: new Date().toISOString(),
    };
    store.inferenceTargets.unshift(target);
    logAudit({
      category: "model",
      action: "add-target",
      actor: "platform-admin",
      detail: `Registered inference target '${target.name}' (${target.source})`,
    });
    return NextResponse.json(target, { status: 201 });
  }

  if (body.op === "add-ratelimit") {
    if (!body.name || !body.dimensions?.length) {
      return NextResponse.json(
        { error: "name and at least one dimension required" },
        { status: 400 }
      );
    }
    if (store.rateLimits.some((r) => r.name === body.name)) {
      return NextResponse.json({ error: "Rate limit name already exists" }, { status: 400 });
    }
    const now = new Date().toISOString();
    const rl: RateLimit = {
      id: newId("rl"),
      name: body.name,
      description: body.description ?? "",
      dimensions: body.dimensions,
      entries: (body.entries ?? []).map((e) => ({ ...e, id: newId("entry") })),
      createdAt: now,
      updatedAt: now,
    };
    store.rateLimits.unshift(rl);
    logAudit({
      category: "model",
      action: "add-ratelimit",
      actor: "platform-admin",
      detail: `Created rate limit '${rl.name}' (${rl.entries.length} entries)`,
    });
    return NextResponse.json(rl, { status: 201 });
  }

  if (body.op === "delete-ratelimit") {
    const idx = store.rateLimits.findIndex((r) => r.id === body.id);
    if (idx < 0) return NextResponse.json({ error: "not found" }, { status: 404 });
    const [removed] = store.rateLimits.splice(idx, 1);
    logAudit({
      category: "model",
      action: "delete-ratelimit",
      actor: "platform-admin",
      detail: `Deleted rate limit '${removed.name}'`,
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
