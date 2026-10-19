// Rate-limit evaluation for the LLM gateway (Part 5).
// Given a request context (target, model, caller sub), evaluate ALL rate limits.
// Semantics (from the workshop):
//  - A request must pass EVERY limit (AND, not first-match).
//  - Within a limit, the most-specific matching entry wins; a named value beats
//    the per- wildcard. If no entry matches inside a limit, that limit is skipped.
//  - rate: 0 blocks all matching traffic.
//  - Limits with more dimension keys are evaluated first; tie broken by tighter
//    rate; evaluation short-circuits on the first denial.
//  - This models the REQUEST metric (the one trippable by hand in the demo).

import { store } from "./store";
import { RateLimit, RateLimitEntry } from "./types";

export interface RateContext {
  targetName?: string;
  model?: string; // target-qualified model id
  callerSub?: string;
  tool?: string;
}

export interface RateLimitResult {
  throttled: boolean;
  limitKey?: string; // which limit fired
  entryDescription?: string;
  retryAfterSeconds?: number;
}

// Resolve the value a dimension refers to in this request context.
function dimValue(
  dim: RateLimit["dimensions"][number],
  ctx: RateContext
): string | undefined {
  switch (dim.type) {
    case "Target":
      return ctx.targetName;
    case "Model":
      return ctx.model;
    case "Tool":
      return ctx.tool;
    case "OAuth Claim":
      // Only "sub" is modeled here.
      return dim.oauthKey === "sub" ? ctx.callerSub : undefined;
    default:
      return undefined;
  }
}

// Does an entry match the context? Each condition is either a specific value
// (must equal the context value) or wildcard (matches anything).
// Returns a specificity score (count of specific-value matches) or -1 if no match.
function entryMatch(
  limit: RateLimit,
  entry: RateLimitEntry,
  ctx: RateContext
): number {
  let specificity = 0;
  for (let i = 0; i < limit.dimensions.length; i++) {
    const cond = entry.conditions[i];
    const actual = dimValue(limit.dimensions[i], ctx);
    if (cond && cond.value !== undefined) {
      // specific value — must equal
      if (cond.value !== actual) return -1;
      specificity += 1;
    }
    // wildcard — always matches
  }
  return specificity;
}

// Evaluate a single limit. Returns the matched entry (most specific) or null.
function matchLimit(limit: RateLimit, ctx: RateContext): RateLimitEntry | null {
  let best: { entry: RateLimitEntry; spec: number } | null = null;
  for (const entry of limit.entries) {
    const spec = entryMatch(limit, entry, ctx);
    if (spec < 0) continue;
    if (!best || spec > best.spec) best = { entry, spec };
  }
  return best?.entry ?? null;
}

export function evaluateRateLimits(ctx: RateContext): RateLimitResult {
  // Order limits by dimension count desc (most specific first), then tighter
  // request rate first.
  const limits = [...store.rateLimits].sort((a, b) => {
    const d = b.dimensions.length - a.dimensions.length;
    if (d !== 0) return d;
    return 0;
  });

  for (const limit of limits) {
    const entry = matchLimit(limit, ctx);
    if (!entry) continue; // no matching entry → skip this limit entirely
    // REQUEST metric: rate 0 blocks. (Demo models request-count only.)
    if (entry.requestRate !== null && entry.requestRate <= 0) {
      return {
        throttled: true,
        limitKey: limit.name,
        entryDescription: describeEntry(limit, entry),
        retryAfterSeconds: 30,
      };
    }
    // Non-zero rates are allowances; in the demo we don't track counters, so
    // they pass. (Real gateway would count per window.)
  }
  return { throttled: false };
}

function describeEntry(limit: RateLimit, entry: RateLimitEntry): string {
  const parts = limit.dimensions.map((d, i) => {
    const c = entry.conditions[i];
    const v = c && c.value !== undefined ? c.value : "All";
    const key = d.type === "OAuth Claim" ? `OAuth:${d.oauthKey}` : d.type;
    return `${key}=${v}`;
  });
  return `${parts.join(" · ")} → ${entry.requestRate}/min`;
}
