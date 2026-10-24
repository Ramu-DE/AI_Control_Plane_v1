// Real execution on Databricks Model Serving.
//
// The counterpart to lib/bedrock.ts. A workflow step whose catalog model has
// `inferenceProvider: "Databricks Model Serving"` is executed here instead of
// on Bedrock, which is what makes `compute.modelRuntimeId` mean something.
//
// Wire protocol (OpenAI-compatible, served by Databricks FM APIs and custom
// endpoints alike):
//   POST <host>/serving-endpoints/<endpoint>/invocations
//   { messages: [...], max_tokens, temperature }
//   -> { choices: [{ message: { content } }], usage: { prompt_tokens, ... } }
//
// SECURITY: the workspace host and PAT are resolved from the ENVIRONMENT by
// reference (DATABRICKS_HOST / DATABRICKS_TOKEN, or per-model overrides). No
// token is ever stored on a catalog model, returned to a client, or logged.

import { validateOutboundUrl } from "./graph/logic";
import type { StepRun, TokenUsage, WorkflowStep } from "./types";
import { store } from "./store";
import { executeToolCall, toOpenAiTools } from "./tools/registry";
import type { ToolCallRecord, ToolContext, ToolSpec } from "./tools/registry";

export class DatabricksConfigError extends Error {
  readonly code = "DATABRICKS_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "DatabricksConfigError";
  }
}

export class DatabricksExecutionError extends Error {
  readonly code = "DATABRICKS_EXECUTION";
  constructor(message: string) {
    super(message);
    this.name = "DatabricksExecutionError";
  }
}

/** Resolve the workspace base URL. Validated against the SSRF policy. */
export function resolveHost(override?: string): string {
  const raw = (override || process.env.DATABRICKS_HOST || "").trim().replace(/\/+$/, "");
  if (!raw) {
    throw new DatabricksConfigError(
      "DATABRICKS_HOST is not set (or set gatewayBaseUrl on the catalog model)"
    );
  }
  const policy = validateOutboundUrl(raw);
  if (!policy.ok) {
    throw new DatabricksConfigError(`DATABRICKS_HOST rejected: ${policy.reason}`);
  }
  return raw;
}

/**
 * Resolve the PAT by reference. `tokenEnvVar` lets one deployment hold several
 * workspace tokens; otherwise the platform default is used.
 */
export function resolveToken(tokenEnvVar?: string): string {
  const name = (tokenEnvVar || "DATABRICKS_TOKEN").trim();
  const value = process.env[name];
  if (!value || value === "REPLACE_ME") {
    throw new DatabricksConfigError(
      `Databricks token env var '${name}' is not set in the server environment`
    );
  }
  return value;
}

/**
 * The serving endpoint name for a catalog model.
 *
 * `modelId` may be either a bare endpoint name
 * ("databricks-meta-llama-3-3-70b-instruct") or "<target>/<endpoint>", matching
 * the existing gateway-model convention.
 */
export function endpointNameFor(modelId: string): string {
  const raw = (modelId || "").trim();
  if (!raw) throw new DatabricksConfigError("catalog model has no modelId");
  const parts = raw.split("/").filter(Boolean);
  return parts[parts.length - 1];
}

export interface DatabricksUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Map the OpenAI-shaped usage block onto the platform's TokenUsage. */
export function toTokenUsage(usage: DatabricksUsage | undefined): TokenUsage {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
  };
}

type AnyRecord = Record<string, unknown>;

/**
 * Extract assistant text from a chat completion.
 *
 * `content` is normally a string, but reasoning-capable endpoints (gpt-oss)
 * return an array of typed blocks — verified live against
 * databricks-gpt-oss-120b. Both are handled; non-text blocks are counted out
 * rather than stringified into the output.
 */
export function extractContent(body: AnyRecord): { text: string; droppedBlocks: number } {
  const choices = Array.isArray(body.choices) ? (body.choices as AnyRecord[]) : [];
  const message = (choices[0]?.message ?? {}) as AnyRecord;
  const content = message.content;

  if (typeof content === "string") return { text: content, droppedBlocks: 0 };

  if (Array.isArray(content)) {
    const parts: string[] = [];
    let dropped = 0;
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!block || typeof block !== "object") {
        dropped += 1;
        continue;
      }
      const b = block as AnyRecord;
      if (typeof b.text === "string") parts.push(b.text);
      else if (b.type === "reasoning" && Array.isArray(b.summary)) {
        // Summarized reasoning: keep the text, flag that it is not final output.
        for (const s of b.summary as AnyRecord[]) {
          if (s && typeof s.text === "string") parts.push(s.text);
        }
      } else dropped += 1;
    }
    return { text: parts.join("\n").trim(), droppedBlocks: dropped };
  }

  return { text: "", droppedBlocks: 0 };
}

export interface DatabricksStepResult {
  output: string;
  usage: TokenUsage;
  latencyMs: number;
  costUsd: number | null;
  resolvedModelId: string;
  notes: string[];
  /** Tools the model actually called, in order. */
  toolCalls?: ToolCallRecord[];
}

/** One raw chat turn sent to the endpoint. */
type ChatMessage = Record<string, unknown>;

/** POST a chat payload and return the parsed body. */
async function postChat(
  host: string,
  token: string,
  endpoint: string,
  payload: Record<string, unknown>
): Promise<{ body: AnyRecord; latencyMs: number }> {
  const url = `${host}/serving-endpoints/${encodeURIComponent(endpoint)}/invocations`;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55_000),
      cache: "no-store",
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    throw new DatabricksExecutionError(
      `could not reach Databricks endpoint '${endpoint}': ${cause ?? (e as Error).message}`
    );
  }
  const latencyMs = Date.now() - started;
  const text = (await res.text()).slice(0, 1024 * 1024);
  if (!res.ok) {
    throw new DatabricksExecutionError(
      `Databricks endpoint '${endpoint}' returned HTTP ${res.status}${
        text ? `: ${text.slice(0, 300)}` : ""
      }`
    );
  }
  try {
    return { body: JSON.parse(text) as AnyRecord, latencyMs };
  } catch {
    throw new DatabricksExecutionError(
      `Databricks endpoint '${endpoint}' returned a non-JSON response`
    );
  }
}

/** Accumulate usage across the turns of a tool loop. */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Maximum model↔tool round trips before we stop and answer with what we have. */
// Bounded to stop a runaway loop. Raised from 4 because a legitimate
// investigation — describe a table, then query two or three — plus one
// self-corrected column guess already exceeded it, and the step then had no
// budget left to answer. The final-synthesis turn below is what guarantees an
// answer regardless; this just stops the bound being hit routinely.
export const MAX_TOOL_ITERATIONS = 6;

/**
 * Execute a step WITH real tool calling.
 *
 * Verified live: `databricks-meta-llama-3-3-70b-instruct` returns
 * `finish_reason: "tool_calls"` with OpenAI-shaped `tool_calls`, so this is a
 * genuine agentic loop — the model chooses the tool and arguments, the platform
 * executes it, the result goes back, and the model answers from real data.
 *
 * The loop is BOUNDED and every call is recorded, so a run can be audited.
 */
export async function runStepOnDatabricksWithTools(
  step: WorkflowStep,
  task: string,
  priorOutputs: { name: string; output: string }[],
  tools: ToolSpec[],
  ctx?: ToolContext
): Promise<DatabricksStepResult> {
  const catalog = store.models.find((m) => m.id === step.modelId);
  if (!catalog) {
    throw new DatabricksConfigError(`catalog model '${step.modelId}' not found`);
  }
  const host = resolveHost(catalog.gatewayBaseUrl);
  const token = resolveToken(catalog.tokenEnvVar);
  const endpoint = endpointNameFor(catalog.modelId);

  const context =
    priorOutputs.length > 0
      ? "Findings already established by EARLIER STEPS of this workflow. These " +
        "came from governed steps that used the same tools, so treat them as " +
        "evidence you already have — do not ask for them again, and do not " +
        "re-query to reproduce them:\n" +
        priorOutputs.map((p) => `### ${p.name}\n${p.output}`).join("\n\n") +
        "\n\n"
      : "";

  // The instruction below used to end "Base your answer only on tool results."
  // With prior step outputs in the same prompt, that was a direct conflict: a
  // later step was handed an earlier step's findings and simultaneously told to
  // disregard anything that was not its own tool result. Observed live — step 3
  // received the lane analysis from step 2 and then asked the Supply Chain
  // agent for the lane data again. A three-step workflow was behaving as three
  // unrelated calls.
  const evidenceRule = priorOutputs.length > 0
    ? `Answer from the earlier findings above PLUS anything you verify with the ` +
      `tools. Do not invent facts that are in neither. If an earlier step left ` +
      `something unverified, you may check it — but do not re-request what it ` +
      `already established.`
    : `Use the provided tools to obtain real data before answering, and base ` +
      `your answer only on tool results. Do not invent data.`;

  const messages: ChatMessage[] = [
    {
      role: "user",
      content:
        `Overall task:\n${task}\n\n` +
        context +
        `You are the "${step.name}" agent. ${step.prompt}\n\n` +
        evidenceRule,
    },
  ];

  const notes: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let latencyMs = 0;
  let output = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const { body, latencyMs: turnMs } = await postChat(host, token, endpoint, {
      messages,
      tools: toOpenAiTools(tools),
      tool_choice: "auto",
      max_tokens: 800,
      temperature: 0.2,
    });
    latencyMs += turnMs;
    usage = addUsage(usage, toTokenUsage(body.usage as DatabricksUsage | undefined));

    const choice = (Array.isArray(body.choices) ? (body.choices as AnyRecord[])[0] : {}) ?? {};
    const message = (choice.message ?? {}) as AnyRecord;
    const requested = Array.isArray(message.tool_calls)
      ? (message.tool_calls as AnyRecord[])
      : [];

    if (requested.length === 0) {
      const { text, droppedBlocks } = extractContent(body);
      output = text;
      if (droppedBlocks > 0) {
        notes.push(`${droppedBlocks} non-text content block(s) omitted from the output`);
      }
      break;
    }

    // Echo the assistant turn back verbatim — the protocol requires it before
    // the matching tool results.
    messages.push(message);

    for (const call of requested) {
      const fn = (call.function ?? {}) as AnyRecord;
      const name = String(fn.name ?? "");
      let args: Record<string, unknown> = {};
      try {
        args = fn.arguments ? (JSON.parse(String(fn.arguments)) as Record<string, unknown>) : {};
      } catch {
        notes.push(`model sent unparseable arguments for '${name}'`);
      }
      const { record, payload } = await executeToolCall(name, args, ctx, tools);
      toolCalls.push(record);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(payload).slice(0, 8_000),
      });
    }

    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      notes.push(`tool loop hit its ${MAX_TOOL_ITERATIONS}-iteration bound`);
    }
  }

  // FINAL SYNTHESIS. Without this the loop could end having executed tools and
  // never asked the model to answer, leaving `output` empty — which is exactly
  // what happened: a step fetched its lane data, hit the bound, reported
  // "answering with the results so far", and returned nothing. The next step
  // then asked for data that had already been retrieved.
  //
  // `tool_choice: "none"` is the whole point: the model keeps the tool RESULTS
  // in its messages but cannot request another call, so it has to answer from
  // what it has.
  if (!output && toolCalls.length > 0) {
    notes.push("forcing a final answer from the tool results already gathered");
    const { body, latencyMs: finalMs } = await postChat(host, token, endpoint, {
      messages: [
        ...messages,
        {
          role: "user",
          content:
            "Answer now, using only the tool results above. Do not request " +
            "another tool. If something you wanted is missing, say which part " +
            "is unverified and answer with the rest.",
        },
      ],
      tool_choice: "none",
      max_tokens: 800,
      temperature: 0.2,
    });
    latencyMs += finalMs;
    usage = addUsage(usage, toTokenUsage(body.usage as DatabricksUsage | undefined));
    const { text, droppedBlocks } = extractContent(body);
    output = text;
    if (droppedBlocks > 0) {
      notes.push(`${droppedBlocks} non-text content block(s) omitted from the output`);
    }
  }

  if (!output) notes.push("endpoint returned no assistant text");
  if (toolCalls.length > 0) {
    notes.push(
      `${toolCalls.length} tool call(s) executed: ` +
        toolCalls.map((c) => `${c.name}${c.ok ? "" : " (failed)"}`).join(", ")
    );
  }

  return {
    output,
    usage,
    latencyMs,
    costUsd: null,
    resolvedModelId: `databricks:${endpoint}`,
    notes,
    toolCalls,
  };
}

/**
 * Execute one workflow step on a Databricks serving endpoint.
 *
 * `costUsd` is deliberately null: Databricks bills in DBUs at workspace-specific
 * rates, so any dollar figure we invented here would be fiction. The token
 * counts are real and come from the endpoint.
 */
export async function runStepOnDatabricks(
  step: WorkflowStep,
  task: string,
  priorOutputs: { name: string; output: string }[]
): Promise<DatabricksStepResult> {
  const catalog = store.models.find((m) => m.id === step.modelId);
  if (!catalog) {
    throw new DatabricksConfigError(`catalog model '${step.modelId}' not found`);
  }

  const host = resolveHost(catalog.gatewayBaseUrl);
  const token = resolveToken(catalog.tokenEnvVar);
  const endpoint = endpointNameFor(catalog.modelId);

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

  const url = `${host}/serving-endpoints/${encodeURIComponent(endpoint)}/invocations`;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: userText }],
        max_tokens: 800,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(55_000),
      cache: "no-store",
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    throw new DatabricksExecutionError(
      `could not reach Databricks endpoint '${endpoint}': ${cause ?? (e as Error).message}`
    );
  }
  const latencyMs = Date.now() - started;
  const text = (await res.text()).slice(0, 1024 * 1024);

  if (!res.ok) {
    throw new DatabricksExecutionError(
      `Databricks endpoint '${endpoint}' returned HTTP ${res.status}${
        text ? `: ${text.slice(0, 300)}` : ""
      }`
    );
  }

  let body: AnyRecord;
  try {
    body = JSON.parse(text) as AnyRecord;
  } catch {
    throw new DatabricksExecutionError(
      `Databricks endpoint '${endpoint}' returned a non-JSON response`
    );
  }

  const { text: output, droppedBlocks } = extractContent(body);
  const notes: string[] = [];
  if (droppedBlocks > 0) {
    notes.push(`${droppedBlocks} non-text content block(s) omitted from the output`);
  }
  if (!output) {
    notes.push("endpoint returned no assistant text");
  }

  return {
    output,
    usage: toTokenUsage(body.usage as DatabricksUsage | undefined),
    latencyMs,
    costUsd: null, // DBU-based; no honest USD figure available here
    resolvedModelId: `databricks:${endpoint}`,
    notes,
  };
}

/** Build a fresh StepRun stub (mirrors lib/bedrock.ts newStepRun). */
export function newDatabricksStepRun(step: WorkflowStep): StepRun {
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
