import { NextRequest, NextResponse } from "next/server";
import { evaluate } from "@/lib/evaluator";
import { evaluateRateLimits } from "@/lib/ratelimits";
import { store, logAudit } from "@/lib/store";
import { EvaluationRequest } from "@/lib/types";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

export const runtime = "nodejs";
export const maxDuration = 30;

// GET returns personas (with identity), tenants, agents (with their resolved
// tool names), and the fallback expense tools — so the UI can scope the
// playground by tenant → agent → the agent's attached tools.
export async function GET() {
  const expense = store.records.find((r) => r.name === "expense_tool");
  const fallbackTools =
    expense?.tools ??
    Array.from(new Set(store.records.flatMap((r) => r.tools))).sort();

  // For each agent, resolve the flat list of tool names from its approved tool records.
  const agents = store.agents.map((a) => {
    const toolNames = a.toolRefs.flatMap((id) => {
      const rec = store.records.find((r) => r.id === id);
      return rec ? rec.tools : [];
    });
    return {
      id: a.id,
      name: a.name,
      tenantId: a.tenantId,
      visibility: a.visibility,
      toolNames,
    };
  });

  return NextResponse.json({
    personas: store.personas,
    tenants: store.tenants.map((t) => ({
      id: t.id,
      tenantName: t.tenantName,
      tier: t.tier,
    })),
    agents,
    tools: fallbackTools,
    gatewayModels: store.models
      .filter((m) => m.inferenceProvider === "AgentCore Gateway")
      .map((m) => ({ id: m.id, name: m.name, modelId: m.modelId, targetName: m.targetName })),
  });
}

function denialReason(tool: string, personaName: string): string {
  return `${personaName} is not permitted to call ${tool}. The request did not match any Allow policy, so Cedar's default-deny applied.`;
}

// Optionally produce a real agent response (Bedrock) for an allowed call.
async function agentResponse(
  personaName: string,
  tool: string,
  amount?: string
): Promise<string | null> {
  try {
    const client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    const res = await client.send(
      new ConverseCommand({
        modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        messages: [
          {
            role: "user",
            content: [
              {
                text:
                  `You are the AnyCompany Expense Assistant. The authenticated user "${personaName}" is authorized to call the tool "${tool}"${
                    amount ? ` for an expense amount of $${amount}` : ""
                  }. ` +
                  `Reply in 1-2 sentences confirming the action was performed, in a professional tone. Do not mention tools or policies.`,
              },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 150, temperature: 0.3 },
      })
    );
    return res.output?.message?.content?.map((c) => c.text ?? "").join("") ?? null;
  } catch {
    return null; // keep the authorization result even if Bedrock is unavailable
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as EvaluationRequest & {
    runAgent?: boolean;
    modelId?: string; // selected catalog model (to resolve gateway target)
  };
  if (!body.personaId || !body.tool) {
    return NextResponse.json(
      { error: "personaId and tool are required" },
      { status: 400 }
    );
  }
  const persona = store.personas.find((p) => p.id === body.personaId);

  // Part 5: if the chosen model is gateway-routed, evaluate rate limits FIRST
  // (they run before Cedar and fail open). rate: 0 → HTTP 429.
  const model = body.modelId
    ? store.models.find((m) => m.id === body.modelId)
    : undefined;
  if (model?.inferenceProvider === "AgentCore Gateway") {
    const rl = evaluateRateLimits({
      targetName: model.targetName,
      model: model.modelId,
      callerSub: persona?.sub,
      tool: body.tool,
    });
    if (rl.throttled) {
      logAudit({
        category: "playground",
        action: "throttle",
        actor: persona?.name ?? body.personaId,
        detail: `429 throttled by '${rl.limitKey}' for ${persona?.name} on ${model.name}`,
      });
      return NextResponse.json({
        allowed: false,
        throttled: true,
        limitKey: rl.limitKey,
        retryAfter: rl.retryAfterSeconds,
        decisions: [],
        persona: persona
          ? { name: persona.name, email: persona.email, sub: persona.sub, groups: persona.groups, provider: persona.provider }
          : null,
        denial: `Request throttled — HTTP 429. An AgentCore Gateway rate limit policy ('${rl.limitKey}': ${rl.entryDescription}) rejected the call at the gateway, before it reached the model.`,
        response: null,
        evaluatedAt: new Date().toISOString(),
      });
    }
  }

  const result = evaluate({
    personaId: body.personaId,
    agentId: body.agentId,
    action: body.action ?? "invokeTool",
    tool: body.tool,
    resource: body.resource,
    amount: body.amount,
  });

  // Enrich decisions with the human-readable determining-policy name.
  const decisions = result.decisions.map((d) => ({
    ...d,
    policyName: d.matchedPolicyId
      ? store.policies.find((p) => p.id === d.matchedPolicyId)?.name
      : undefined,
  }));

  let response: string | null = null;
  if (result.allowed && body.runAgent) {
    response = await agentResponse(persona?.name ?? "user", body.tool, body.amount);
  }

  logAudit({
    category: "playground",
    action: "evaluate",
    actor: persona?.name ?? body.personaId,
    detail: `${result.allowed ? "ALLOW" : "DENY"} ${body.tool} for ${persona?.name ?? body.personaId}`,
  });

  return NextResponse.json({
    ...result,
    decisions,
    persona: persona
      ? {
          name: persona.name,
          email: persona.email,
          sub: persona.sub,
          groups: persona.groups,
          provider: persona.provider,
        }
      : null,
    denial: result.allowed ? null : denialReason(body.tool, persona?.name ?? "The caller"),
    response,
  });
}
