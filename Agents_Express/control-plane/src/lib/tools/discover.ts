// Tool discovery — narrow the catalog before the model sees it.
//
// A large tool catalog is one of the two biggest sources of context bloat: every
// tool definition is fixed overhead on EVERY call of a conversation, paid again
// each turn, and a model asked to choose among twenty tools chooses worse than
// one asked to choose among four.
//
// AgentCore Gateway does this server-side with semantic search
// (`x_amz_bedrock_agentcore_search`), and states the rule that matters:
// "Discovery narrows the catalog. Authorization still applies." This module is
// the same rule applied to the platform's OWN registry, which is where approved
// tools already live.
//
// THE ORDER IS DELIBERATE AND NOT INTERCHANGEABLE:
//
//   approved (registry)  ->  implemented  ->  RELEVANT  ->  Cedar authorizes
//
// Narrowing happens strictly INSIDE the approved set. It can only ever remove
// candidates, never add one, so it cannot widen what an agent may do — the
// registry and Cedar remain the authorities. If relevance ranking were allowed
// to introduce a tool, it would be a privilege escalation dressed as a
// convenience.
//
// Ranking is lexical on purpose. An embedding call per step would cost a model
// round trip and latency to choose between four tools, and would make the
// selection non-deterministic across runs — which makes a workflow harder to
// audit. When this stops being good enough, the honest upgrade is a Gateway
// with semantic search, not a secret extra inference.
//
// Pure — no I/O.

import type { ToolSpec } from "./registry";

/** Default ceiling on tools offered to one step. */
export const DEFAULT_MAX_TOOLS = 6;

/** Words that carry no signal about which tool is wanted. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "from",
  "by", "is", "are", "was", "be", "it", "this", "that", "these", "those", "as",
  "at", "any", "all", "list", "show", "give", "me", "please", "can", "you",
  "what", "which", "how", "do", "does", "need", "want", "using", "use", "get",
]);

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * How well a tool matches the task. Name matches count double: a tool called
 * `uc_list_tables` is named after what it does, and its description repeats
 * that in prose, so weighting the name avoids a verbose description
 * out-scoring a precisely-named tool.
 */
export function relevanceScore(spec: ToolSpec, taskTokens: Set<string>): number {
  if (taskTokens.size === 0) return 0;
  const nameTokens = new Set(tokenize(spec.name));
  const descTokens = new Set(tokenize(spec.description ?? ""));
  let score = 0;
  for (const t of taskTokens) {
    if (nameTokens.has(t)) score += 2;
    else if (descTokens.has(t)) score += 1;
  }
  return score;
}

export interface ToolSelection {
  /** Tools offered to the model, highest relevance first. */
  offered: ToolSpec[];
  /** Approved + implemented tools held back, with the reason. */
  withheld: { name: string; reason: string }[];
  /** True when nothing was held back — the model saw the whole catalog. */
  complete: boolean;
  maxTools: number;
}

/**
 * Narrow an already-approved, already-implemented tool list for one task.
 *
 * Two rules keep this honest:
 *
 *  - BELOW THE CEILING, NOTHING IS WITHHELD. If the agent has four tools and
 *    the ceiling is six, all four are offered even if the task mentions none of
 *    them. Scoring a small catalog would withhold a tool the model needed
 *    because the step prompt happened not to name it, which is a worse failure
 *    than a little extra context.
 *  - WITHHOLDING IS REPORTED, never silent. A step whose catalog was trimmed
 *    says so, for the same reason a truncated query result does: a model
 *    reasoning over a partial catalog should not look like one that had
 *    everything.
 */
export function narrowTools(
  available: ToolSpec[],
  task: string,
  maxTools: number = DEFAULT_MAX_TOOLS
): ToolSelection {
  const limit = Math.max(1, Math.floor(maxTools));

  if (available.length <= limit) {
    return {
      offered: available,
      withheld: [],
      complete: true,
      maxTools: limit,
    };
  }

  const taskTokens = new Set(tokenize(task));
  const scored = available.map((spec, index) => ({
    spec,
    index,
    score: relevanceScore(spec, taskTokens),
  }));
  // Relevance first; original order breaks ties, so the result is deterministic
  // and a workflow re-run offers the same tools in the same order.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const offered = scored.slice(0, limit);
  const held = scored.slice(limit);

  return {
    offered: offered.map((s) => s.spec),
    withheld: held.map((s) => ({
      name: s.spec.name,
      reason:
        s.score === 0
          ? `no term in the task matches this tool; ${limit}-tool ceiling reached`
          : `scored ${s.score}, below the top ${limit} for this task`,
    })),
    complete: false,
    maxTools: limit,
  };
}
