import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
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

  // The model must exist in the platform catalog (Settings → Models).
  if (!store.models.some((m) => m.id === body.modelId)) {
    return NextResponse.json(
      { error: "modelId must reference a model in the catalog" },
      { status: 400 }
    );
  }

  // Only APPROVED registry records can be wired into an agent.
  const toolRefs = body.toolRefs ?? [];
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
    modelId: body.modelId,
    systemPrompt: body.systemPrompt ?? "",
    toolRefs,
    // Compute is informational — the agent runs on Bedrock AgentCore Runtime.
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
    detail: `Created agent '${agent.name}' (${agent.visibility})`,
  });
  return NextResponse.json(agent, { status: 201 });
}
