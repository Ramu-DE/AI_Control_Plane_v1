import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { ModelProvider, ModelRoute } from "@/lib/types";

export async function GET() {
  return NextResponse.json({ providers: store.providers, routes: store.routes });
}

// POST creates either a provider or a route depending on `type`.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as
    | ({ type: "provider" } & Partial<ModelProvider>)
    | ({ type: "route" } & Partial<ModelRoute>);

  if (body.type === "provider") {
    if (!body.name || !body.kind || !body.baseUrl) {
      return NextResponse.json(
        { error: "name, kind and baseUrl are required" },
        { status: 400 }
      );
    }
    const provider: ModelProvider = {
      id: newId("prov"),
      name: body.name,
      kind: body.kind,
      baseUrl: body.baseUrl,
      rateLimitRpm: body.rateLimitRpm ?? 60,
      enabled: body.enabled ?? true,
    };
    store.providers.unshift(provider);
    logAudit({
      category: "model",
      action: "create-provider",
      actor: "console-user",
      detail: `Added model provider '${provider.name}'`,
    });
    return NextResponse.json(provider, { status: 201 });
  }

  if (body.type === "route") {
    if (!body.alias || !body.providerId || !body.upstreamModelId) {
      return NextResponse.json(
        { error: "alias, providerId and upstreamModelId are required" },
        { status: 400 }
      );
    }
    const route: ModelRoute = {
      id: newId("route"),
      alias: body.alias,
      providerId: body.providerId,
      upstreamModelId: body.upstreamModelId,
      monthlyTokenBudget: body.monthlyTokenBudget ?? null,
      enabled: body.enabled ?? true,
    };
    store.routes.unshift(route);
    logAudit({
      category: "model",
      action: "create-route",
      actor: "console-user",
      detail: `Added LLM gateway route '${route.alias}'`,
    });
    return NextResponse.json(route, { status: 201 });
  }

  return NextResponse.json({ error: "unknown type" }, { status: 400 });
}
