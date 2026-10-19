import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { Policy } from "@/lib/types";

export async function GET() {
  return NextResponse.json(store.policies);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<Policy>;
  if (!body.name || !body.layer || !body.cedar) {
    return NextResponse.json(
      { error: "name, layer and cedar are required" },
      { status: 400 }
    );
  }
  const policy: Policy = {
    id: newId("pol"),
    name: body.name,
    layer: body.layer,
    description: body.description ?? "",
    cedar: body.cedar,
    enabled: body.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  store.policies.unshift(policy);
  logAudit({
    category: "policy",
    action: "create",
    actor: "console-user",
    detail: `Created ${policy.layer} policy '${policy.name}'`,
  });
  return NextResponse.json(policy, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as { id: string; enabled: boolean };
  const policy = store.policies.find((p) => p.id === body.id);
  if (!policy) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  policy.enabled = body.enabled;
  logAudit({
    category: "policy",
    action: body.enabled ? "enable" : "disable",
    actor: "console-user",
    detail: `${body.enabled ? "Enabled" : "Disabled"} policy '${policy.name}'`,
  });
  return NextResponse.json(policy);
}
