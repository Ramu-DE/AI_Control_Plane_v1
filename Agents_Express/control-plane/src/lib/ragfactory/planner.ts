// Question router + planner for corpus questions.
//
// The model sees the QUESTION and the corpus VOCABULARY (document types, field
// names, table columns) — never the values — and must call one tool that
// returns either a structured plan (executed exactly by fieldQuery.ts) or
// "narrative" (answered by the factory's verified retrieval path). Forced tool
// use at temperature 0 keeps the output a schema-shaped object; the plan is
// then validated against the vocabulary before anything runs.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { FieldPlan } from "./fieldQuery";

export const PLANNER_MODEL = process.env.RAG_PLANNER_MODEL || "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

let _client: BedrockRuntimeClient | null = null;
function client() {
  if (!_client) _client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
  return _client;
}

export interface RoutedQuestion {
  route: "structured" | "narrative";
  reason: string;
  plan?: FieldPlan;
  model: string;
}

const OPS = ["eq", "contains", "gt", "lt", "gte", "lte"];

const TOOL_SCHEMA = {
  type: "object",
  required: ["route", "reason"],
  properties: {
    route: { type: "string", enum: ["structured", "narrative"] },
    reason: { type: "string" },
    plan: {
      type: "object",
      required: ["documentFilters", "select"],
      properties: {
        documentFilters: {
          type: "array",
          items: {
            type: "object", required: ["field", "op", "value"],
            properties: { field: { type: "string" }, op: { type: "string", enum: OPS }, value: { type: "string" } },
          },
        },
        select: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["fields", "table_rows", "count", "aggregate", "list_documents"] },
            fields: { type: "array", items: { type: "string" } },
            columns: { type: "array", items: { type: "string" } },
            where: {
              type: "array",
              items: {
                type: "object", required: ["column", "op", "value"],
                properties: { column: { type: "string" }, op: { type: "string", enum: OPS }, value: { type: "string" } },
              },
            },
            spec: { type: "string", enum: ["out_of_spec", "within_spec"] },
            specColumn: { type: "string" },
            resultColumn: { type: "string" },
            fn: { type: "string", enum: ["sum", "min", "max", "avg"] },
            field: { type: "string" },
          },
        },
      },
    },
  },
};

export function plannerPrompt(question: string, vocabulary: unknown): string {
  return [
    "Route a question about a corpus of finalized (reviewed, approved) documents.",
    "Choose route=structured when the answer is a value, a list, a count or an aggregate that can be read directly from",
    "the documents' extracted FIELDS or TABLE rows listed below (e.g. 'assay result for batch X', 'which tests did not meet",
    "specification', 'how many invoices from supplier Y', 'total due of invoice Z'). Otherwise choose route=narrative",
    "(explanations, summaries, reasons, anything that needs reading prose).",
    "For structured plans:",
    "- Use ONLY field names and table columns from the vocabulary, spelled exactly. 'docType' filters by document type.",
    "- documentFilters select the documents (e.g. batch_number eq VF-24-0917). Use [] to mean all documents.",
    "- select.type 'fields' returns named fields; 'table_rows' returns table rows (optionally where column op value,",
    "  and spec='out_of_spec' for results that fail their specification, 'within_spec' for those that pass);",
    "  'count' counts documents; 'aggregate' computes sum/min/max/avg of a numeric field; 'list_documents' lists them.",
    "- Keep negations exactly: 'did not meet specification' means spec='out_of_spec'.",
    "- Copy identifiers from the question verbatim into filter values. Use op 'eq' for identifiers (batch, lot,",
    "  invoice numbers) and op 'contains' for names (suppliers, products, people), which are often abbreviated in questions.",
    "- Plans cannot convert units or currencies or do arithmetic beyond count/sum/min/max/avg; if the question needs that, route=narrative.",
    "Never invent values. If unsure, route=narrative.",
    "",
    `Vocabulary: ${JSON.stringify(vocabulary)}`,
    "",
    `Question: ${question}`,
  ].join("\n");
}

export async function routeQuestion(question: string, vocabulary: unknown): Promise<RoutedQuestion> {
  const res = await client().send(new ConverseCommand({
    modelId: PLANNER_MODEL,
    messages: [{ role: "user", content: [{ text: plannerPrompt(question, vocabulary) }] }],
    inferenceConfig: { maxTokens: 800, temperature: 0 },
    toolConfig: {
      tools: [{ toolSpec: { name: "route_question", description: "Return the route and, for structured questions, the plan.",
        inputSchema: { json: TOOL_SCHEMA as never } } }],
      toolChoice: { tool: { name: "route_question" } },
    },
  }));
  const block = res.output?.message?.content?.find((c) => "toolUse" in c && c.toolUse);
  const input = (block && "toolUse" in block ? block.toolUse?.input : undefined) as Partial<RoutedQuestion> | undefined;
  if (!input || (input.route !== "structured" && input.route !== "narrative")) {
    return { route: "narrative", reason: "planner returned no usable route", model: PLANNER_MODEL };
  }
  return { route: input.route, reason: String(input.reason ?? "").slice(0, 300), plan: input.plan, model: PLANNER_MODEL };
}
