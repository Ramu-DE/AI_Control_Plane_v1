import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import {
  AttachedGateway,
  EnforcementMode,
  PolicyEngine,
  SyncEntry,
} from "@/lib/types";

export async function GET() {
  return NextResponse.json({
    engines: store.policyEngines,
    // library policies are importable; expose names/effects
    libraryPolicies: store.libraryPolicies.map((p) => ({
      id: p.id,
      name: p.name,
      effect: p.effect,
    })),
    // gateways available to attach
    gateways: [{ gatewayId: "agent-platform-gateway", name: "agent-platform-gateway" }],
  });
}

function sync(engine: PolicyEngine, scope: string, action: string): SyncEntry {
  const entry: SyncEntry = {
    id: newId("sync"),
    scope,
    action,
    target: "—",
    result: "Success",
    actor: "Workshop Admin",
    at: new Date().toISOString(),
  };
  engine.syncHistory.unshift(entry);
  return entry;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as
    | { op: "create"; name: string; description?: string }
    | { op: "import"; engineId: string; policyId: string }
    | { op: "attach"; engineId: string; gatewayId: string; name: string; mode: EnforcementMode }
    | { op: "sync"; engineId: string };

  if (body.op === "create") {
    if (!body.name)
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    const now = new Date().toISOString();
    const id = newId("engine");
    const engine: PolicyEngine = {
      id,
      name: body.name,
      description: body.description ?? "",
      status: "Active",
      region: "us-east-1",
      awsEngineId: `${body.name}-${Math.random().toString(36).slice(2, 8)}`,
      awsEngineArn: `arn:aws:bedrock-agentcore:us-east-1:899561148374:policy-engine/${body.name}`,
      importedPolicies: [],
      gateways: [],
      syncHistory: [],
      createdAt: now,
      updatedAt: now,
    };
    sync(engine, "Engine", "engine_create");
    store.policyEngines.unshift(engine);
    logAudit({
      category: "policy",
      action: "engine-create",
      actor: "Workshop Admin",
      detail: `Created policy engine '${engine.name}'`,
    });
    return NextResponse.json(engine, { status: 201 });
  }

  const engine = store.policyEngines.find((e) => e.id === (body as { engineId: string }).engineId);
  if (!engine)
    return NextResponse.json({ error: "engine not found" }, { status: 404 });

  if (body.op === "import") {
    const lib = store.libraryPolicies.find((p) => p.id === body.policyId);
    if (!lib)
      return NextResponse.json({ error: "library policy not found" }, { status: 404 });
    if (engine.importedPolicies.some((p) => p.policyId === lib.id)) {
      return NextResponse.json({ error: "already imported" }, { status: 400 });
    }
    engine.importedPolicies.push({
      policyId: lib.id,
      name: lib.name,
      type: lib.effect,
      synced: false,
      lastSynced: null,
    });
    logAudit({
      category: "policy",
      action: "engine-import",
      actor: "Workshop Admin",
      detail: `Imported '${lib.name}' into ${engine.name}`,
    });
    return NextResponse.json(engine);
  }

  if (body.op === "attach") {
    if (engine.gateways.some((g) => g.gatewayId === body.gatewayId)) {
      return NextResponse.json({ error: "gateway already attached" }, { status: 400 });
    }
    const gw: AttachedGateway = {
      gatewayId: body.gatewayId,
      name: body.name,
      mode: body.mode,
    };
    engine.gateways.push(gw);
    sync(engine, "Gateway", "gateway_attach");
    logAudit({
      category: "policy",
      action: "gateway-attach",
      actor: "Workshop Admin",
      detail: `Attached ${gw.name} to ${engine.name} (${gw.mode})`,
    });
    return NextResponse.json(engine);
  }

  if (body.op === "sync") {
    const now = new Date().toISOString();
    engine.importedPolicies.forEach((p) => {
      p.synced = true;
      p.lastSynced = now;
    });
    sync(engine, "Engine", "policy_sync");
    engine.updatedAt = now;
    logAudit({
      category: "policy",
      action: "engine-sync",
      actor: "Workshop Admin",
      detail: `Sync all for ${engine.name}: success`,
    });
    return NextResponse.json(engine);
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
