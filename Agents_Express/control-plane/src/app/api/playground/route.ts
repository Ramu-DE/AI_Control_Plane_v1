import { NextRequest, NextResponse } from "next/server";
import { evaluate } from "@/lib/evaluator";
import { store } from "@/lib/store";
import { logAudit } from "@/lib/store";
import { EvaluationRequest } from "@/lib/types";

// GET returns personas + context needed to drive the playground UI.
export async function GET() {
  return NextResponse.json({
    personas: store.personas,
    agents: store.agents,
    tools: Array.from(
      new Set(store.records.flatMap((r) => r.tools))
    ).sort(),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as EvaluationRequest;
  if (!body.personaId || !body.tool) {
    return NextResponse.json(
      { error: "personaId and tool are required" },
      { status: 400 }
    );
  }
  const result = evaluate({
    personaId: body.personaId,
    agentId: body.agentId,
    action: body.action ?? "invokeTool",
    tool: body.tool,
    resource: body.resource,
    amount: body.amount,
  });
  const persona = store.personas.find((p) => p.id === body.personaId);
  logAudit({
    category: "playground",
    action: "evaluate",
    actor: persona?.name ?? body.personaId,
    detail: `${result.allowed ? "ALLOW" : "DENY"} ${body.tool} for ${persona?.name ?? body.personaId}`,
  });
  return NextResponse.json(result);
}
