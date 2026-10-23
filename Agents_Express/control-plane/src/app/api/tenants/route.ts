import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { getTierConfig, isolationForTier, planLabel } from "@/lib/tiers";
import { perAgentLimits, tenantCapacity, tenantUsage } from "@/lib/tenancy";
import { effectiveModelAllowlist } from "@/lib/modelAccess";
import { Tenant, TenantTier, TierConfig } from "@/lib/types";

// GET → tenants + resolved tier config + LIVE usage.
//
// Usage is added server-side rather than left to the console to compute,
// because the console would have to fetch agents, workflows and the registry
// just to render a tenant tree, and would then have its own copy of "what
// counts against a limit" — the drift that `plane.ts` and `eligibility.ts`
// exist to prevent. Additive: every existing field is unchanged.
export async function GET() {
  const input = {
    tenants: store.tenants,
    agents: store.agents,
    workflows: store.workflows,
    records: store.records,
  };
  const withConfig = store.tenants.map((t) => {
    const config = getTierConfig(t.tier);
    const usage = tenantUsage(t.id, input);
    return {
      ...t,
      config,
      plan: planLabel(t.tier),
      usage,
      capacity: tenantCapacity(usage, config, planLabel(t.tier)),
      perAgentLimits: perAgentLimits(usage, config),
      // The EFFECTIVE allowlist, after inheritance — what actually governs
      // this tenant, not just what it declares itself.
      modelAccess: effectiveModelAllowlist(t.id, store.tenants),
    };
  });
  return NextResponse.json({ tenants: withConfig });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    tenantId?: string;
    tenantName?: string;
    tier?: TenantTier;
    parentId?: string | null;
    type?: Tenant["type"];
    allowedModelIds?: string[] | null;
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
  // An allowlist is only accepted if every id is a real catalog model.
  // Accepting an unknown id would create a rule that silently denies
  // everything, which reads as a platform fault rather than a policy.
  if (Array.isArray(body.allowedModelIds)) {
    const unknown = body.allowedModelIds.filter(
      (id) => !store.models.some((m) => m.id === id)
    );
    if (unknown.length > 0) {
      return NextResponse.json(
        {
          error:
            "allowedModelIds must reference catalog models. Unknown: " +
            unknown.join(", "),
        },
        { status: 400 }
      );
    }
  }

  const tenant: Tenant = {
    id: newId("tenant"),
    tenantId: body.tenantId,
    tenantName: body.tenantName,
    parentId,
    type: body.type ?? (parentId ? "subunit" : "bu"),
    tier,
    isolation,
    resourcePool: isolation === "silo" ? `dedicated-${body.tenantId}` : "shared-pool-01",
    // `null` from the caller means "inherit" (field absent); an array — even an
    // empty one — is an explicit rule. See lib/modelAccess.ts.
    ...(Array.isArray(body.allowedModelIds)
      ? { allowedModelIds: body.allowedModelIds }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  store.tenants.unshift(tenant);
  logAudit({
    category: "model",
    action: "tenant-create",
    actor: "platform-admin",
    detail: `Onboarded tenant '${tenant.tenantName}' (${planLabel(tier)} plan, ${isolation})`,
  });
  const config: TierConfig = getTierConfig(tier);
  const usage = tenantUsage(tenant.id, {
    tenants: store.tenants,
    agents: store.agents,
    workflows: store.workflows,
    records: store.records,
  });
  // Same shape as GET, so the console can select a freshly created tenant
  // without a second round trip that would briefly render it as "no data".
  return NextResponse.json(
    {
      ...tenant,
      config,
      plan: planLabel(tier),
      usage,
      capacity: tenantCapacity(usage, config, planLabel(tier)),
      perAgentLimits: perAgentLimits(usage, config),
    },
    { status: 201 }
  );
}
