import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { CatalogModel } from "@/lib/types";
import { planeMismatch } from "@/lib/plane";

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

/**
 * Correct a catalog model.
 *
 * This exists because a mislabelled model was uncorrectable. A model created
 * with the wrong Inference Provider — easy to do while the Settings dropdown
 * was missing two of the five — left every agent pointing at it in a state the
 * resolver refuses, with no way to fix the cause. Deleting was not an option
 * either: agents reference the model id.
 *
 * Changing `inferenceProvider` can invalidate agents that depend on it, so
 * those are reported back rather than silently broken.
 */
export async function PATCH(req: NextRequest) {
  let body: Partial<CatalogModel> & { id?: string };
  try {
    body = (await req.json()) as Partial<CatalogModel> & { id?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const model = store.models.find((m) => m.id === body.id);
  if (!model) {
    return NextResponse.json({ error: "model not found" }, { status: 404 });
  }

  const before = model.inferenceProvider;
  const fields = [
    "name",
    "modelProvider",
    "modelId",
    "inferenceProvider",
    "inferenceApi",
    "targetName",
    "gatewayBaseUrl",
    "tokenEnvVar",
  ] as const;
  const changed: string[] = [];
  for (const f of fields) {
    const next = body[f];
    if (next !== undefined && next !== model[f]) {
      (model as unknown as Record<string, unknown>)[f] = next;
      changed.push(f);
    }
  }
  if (changed.length === 0) {
    return NextResponse.json({ model, changed: [], affectedAgents: [] });
  }

  // Report agents whose declared runtime no longer agrees with where the model
  // is served. Correcting a provider is usually what FIXES them, so this is
  // information rather than a refusal — but it must not be silent either.
  const affectedAgents = store.agents
    .filter((a) => a.modelId === model.id)
    .map((a) => ({
      id: a.id,
      name: a.name,
      modelRuntimeId: a.compute.modelRuntimeId,
      mismatch: planeMismatch(a.compute.modelRuntimeId, model.inferenceProvider),
    }));

  logAudit({
    category: "model",
    action: "update-model",
    actor: "console-user",
    detail:
      `Updated model '${model.name}' (${changed.join(", ")})` +
      (changed.includes("inferenceProvider")
        ? `; inferenceProvider ${before} → ${model.inferenceProvider}, ` +
          `${affectedAgents.filter((a) => a.mismatch).length} dependent agent(s) ` +
          `still mismatched`
        : ""),
  });

  return NextResponse.json({ model, changed, affectedAgents });
}
