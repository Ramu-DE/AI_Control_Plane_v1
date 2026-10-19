import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { getTierConfig } from "@/lib/tiers";
import { AgentConfig } from "@/lib/types";

export async function GET() {
  return NextResponse.json(store.agents);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<AgentConfig>;
  if (!body.name || !body.modelId) {
    return NextResponse.json(
      { error: "name and modelId are required" },
      { status: 400 }
    );
  }

  // Tenant context is required; enforce the tenant's tier limits.
  const tenantId = body.tenantId;
  const tenant = store.tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return NextResponse.json(
      { error: "a valid tenantId is required" },
      { status: 400 }
    );
  }
  const tier = getTierConfig(tenant.tier);
  const existing = store.agents.filter((a) => a.tenantId === tenant.id).length;
  if (existing >= tier.maxAgents) {
    return NextResponse.json(
      {
        error: `Tier limit reached: '${tenant.tenantName}' (${tenant.tier}) allows ${tier.maxAgents} agents. Upgrade to Pro for up to ${getTierConfig("pro").maxAgents}.`,
        upgrade: { currentTier: tenant.tier, requiredTier: "pro" },
      },
      { status: 403 }
    );
  }

  // The model must exist in the platform catalog (Settings → Models).
  if (!store.models.some((m) => m.id === body.modelId)) {
    return NextResponse.json(
      { error: "modelId must reference a model in the catalog" },
      { status: 400 }
    );
  }

  // Only APPROVED registry records can be wired into an agent, and no more
  // than the tier's maxToolsPerAgent.
  const toolRefs = body.toolRefs ?? [];
  if (toolRefs.length > tier.maxToolsPerAgent) {
    return NextResponse.json(
      {
        error: `Tier limit: '${tenant.tenantName}' (${tenant.tier}) allows ${tier.maxToolsPerAgent} tools per agent.`,
      },
      { status: 403 }
    );
  }
  const notApproved = toolRefs.filter((id) => {
    const rec = store.records.find((r) => r.id === id);
    return !rec || rec.status !== "Approved";
  });
  if (notApproved.length > 0) {
    return NextResponse.json(
      {
        error:
          "Only approved registry records can be attached. Not approved: " +
          notApproved.join(", "),
      },
      { status: 400 }
    );
  }

  const agent: AgentConfig = {
    id: newId("agent"),
    name: body.name,
    description: body.description ?? "",
    tenantId: tenant.id,
    modelId: body.modelId,
    systemPrompt: body.systemPrompt ?? "",
    toolRefs,
    compute: body.compute ?? { runtime: "Bedrock AgentCore" },
    visibility: body.visibility ?? "private",
    status: body.status ?? "draft",
    createdAt: new Date().toISOString(),
  };
  store.agents.unshift(agent);
  logAudit({
    category: "agent",
    action: "create",
    actor: "console-user",
    detail: `Created agent '${agent.name}' in ${tenant.tenantName} (${agent.visibility})`,
  });
  return NextResponse.json(agent, { status: 201 });
}
