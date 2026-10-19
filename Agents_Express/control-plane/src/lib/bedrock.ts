// Real Bedrock execution for workflow steps.
// Uses the AWS SDK Converse API with the environment's credentials (instance
// role here). Resolves a catalog model to an inference-profile model id and
// captures real token usage, latency, and an estimated cost.

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { store } from "./store";
import { StepRun, TokenUsage, WorkflowStep } from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";

// Reuse one client across invocations.
let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: REGION });
  return _client;
}

// Verified, invokable inference profiles in this account (tested via Converse).
const KNOWN_GOOD = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const PROFILES: { match: RegExp; id: string }[] = [
  { match: /opus/, id: "us.anthropic.claude-opus-4-5-20251101-v1:0" },
  { match: /sonnet/, id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
  { match: /haiku/, id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
];

// Map a catalog model's upstream id to a Bedrock inference-profile id that is
// known to be invokable in this account. Falls back to the cheap haiku profile.
function toInferenceProfileId(upstream: string): string {
  if (!upstream) return KNOWN_GOOD;
  if (upstream.startsWith("us.")) return upstream;
  const lower = upstream.toLowerCase();
  for (const p of PROFILES) if (p.match.test(lower)) return p.id;
  return KNOWN_GOOD;
}

// Rough per-1K-token cost estimate (USD). Demo-grade; refine per real pricing.
function estimateCost(modelId: string, usage: TokenUsage): number {
  const isOpus = /opus/.test(modelId);
  const isSonnet = /sonnet/.test(modelId);
  const inPer1k = isOpus ? 0.015 : isSonnet ? 0.003 : 0.0008;
  const outPer1k = isOpus ? 0.075 : isSonnet ? 0.015 : 0.004;
  return (
    (usage.inputTokens / 1000) * inPer1k +
    (usage.outputTokens / 1000) * outPer1k
  );
}

export interface RunStepResult {
  output: string;
  usage: TokenUsage;
  latencyMs: number;
  costUsd: number;
  resolvedModelId: string;
}

// Execute one workflow step on Bedrock, given the prior steps' outputs as context.
export async function runStepOnBedrock(
  step: WorkflowStep,
  task: string,
  priorOutputs: { name: string; output: string }[]
): Promise<RunStepResult> {
  const catalog = store.models.find((m) => m.id === step.modelId);
  const resolvedModelId = toInferenceProfileId(catalog?.modelId ?? "");

  const context =
    priorOutputs.length > 0
      ? "Prior step outputs:\n" +
        priorOutputs.map((p) => `### ${p.name}\n${p.output}`).join("\n\n") +
        "\n\n"
      : "";

  const userText =
    `Overall task:\n${task}\n\n` +
    context +
    `You are the "${step.name}" agent. ${step.prompt}\n\n` +
    `Produce your output now.`;

  const started = Date.now();
  const res = await client().send(
    new ConverseCommand({
      modelId: resolvedModelId,
      messages: [{ role: "user", content: [{ text: userText }] }],
      inferenceConfig: { maxTokens: 800, temperature: 0.3 },
    })
  );
  const latencyMs = Date.now() - started;

  const output =
    res.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
  const usage: TokenUsage = {
    inputTokens: res.usage?.inputTokens ?? 0,
    outputTokens: res.usage?.outputTokens ?? 0,
    totalTokens: res.usage?.totalTokens ?? 0,
  };
  const costUsd = estimateCost(resolvedModelId, usage);
  return { output, usage, latencyMs, costUsd, resolvedModelId };
}

// Build a fresh StepRun stub from a step definition.
export function newStepRun(step: WorkflowStep): StepRun {
  return {
    stepId: step.id,
    name: step.name,
    status: "pending",
    output: "",
    modelId: "",
    usage: null,
    latencyMs: null,
    costUsd: null,
    reviewGate: step.reviewGate,
  };
}
