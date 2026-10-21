import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { CatalogModel } from "@/lib/types";

// The platform model catalog (Settings → Models). Admins curate; agent
// developers consume. Distinct from /api/models (Part 5 LLM-gateway routes).
export async function GET() {
  return NextResponse.json(store.models);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<CatalogModel>;
  if (!body.name || !body.modelProvider || !body.modelId || !body.inferenceProvider) {
    return NextResponse.json(
      {
        error:
          "name, modelProvider, modelId and inferenceProvider are required",
      },
      { status: 400 }
    );
  }
  const model: CatalogModel = {
    id: newId("model"),
    name: body.name,
    modelProvider: body.modelProvider,
    modelId: body.modelId,
    inferenceProvider: body.inferenceProvider,
    // Routing details for gateway- and Databricks-served models. `tokenEnvVar`
    // is a REFERENCE to a server-side env var — never a token value.
    ...(body.targetName ? { targetName: body.targetName } : {}),
    ...(body.gatewayBaseUrl ? { gatewayBaseUrl: body.gatewayBaseUrl } : {}),
    ...(body.inferenceApi ? { inferenceApi: body.inferenceApi } : {}),
    ...(body.tokenEnvVar ? { tokenEnvVar: body.tokenEnvVar } : {}),
    createdAt: new Date().toISOString(),
  };
  store.models.unshift(model);
  logAudit({
    category: "model",
    action: "add-catalog-model",
    actor: "admin",
    detail: `Added model '${model.name}' (${model.modelId}) to the catalog`,
  });
  return NextResponse.json(model, { status: 201 });
}
