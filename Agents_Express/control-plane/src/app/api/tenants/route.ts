import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { getTierConfig, isolationForTier } from "@/lib/tiers";
import { Tenant, TenantTier, TierConfig } from "@/lib/types";

// GET → tenants + their resolved tier configs.
export async function GET() {
  const withConfig = store.tenants.map((t) => ({
    ...t,
    config: getTierConfig(t.tier),
  }));
  return NextResponse.json({ tenants: withConfig });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    tenantId?: string;
    tenantName?: string;
    tier?: TenantTier;
    parentId?: string | null;
    type?: Tenant["type"];
  };
  if (!body.tenantId || !body.tenantName) {
    return NextResponse.json(
      { error: "tenantId and tenantName are required" },
      { status: 400 }
    );
  }
  if (store.tenants.some((t) => t.tenantId === body.tenantId)) {
    return NextResponse.json(
      { error: "tenantId already exists" },
      { status: 400 }
    );
  }
  const parentId = body.parentId ?? null;
  if (parentId && !store.tenants.some((t) => t.id === parentId)) {
    return NextResponse.json({ error: "parent not found" }, { status: 400 });
  }
  const tier: TenantTier = body.tier === "pro" ? "pro" : "basic";
  const isolation = isolationForTier(tier);
  const now = new Date().toISOString();
  const tenant: Tenant = {
    id: newId("tenant"),
    tenantId: body.tenantId,
    tenantName: body.tenantName,
    parentId,
    type: body.type ?? (parentId ? "subunit" : "bu"),
    tier,
    isolation,
    resourcePool: isolation === "silo" ? `dedicated-${body.tenantId}` : "shared-pool-01",
    createdAt: now,
    updatedAt: now,
  };
  store.tenants.unshift(tenant);
  logAudit({
    category: "model",
    action: "tenant-create",
    actor: "platform-admin",
    detail: `Onboarded tenant '${tenant.tenantName}' (${tier}, ${isolation})`,
  });
  const config: TierConfig = getTierConfig(tier);
  return NextResponse.json({ ...tenant, config }, { status: 201 });
}
