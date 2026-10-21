// Gateway interceptor pipeline (PDF: "Gateway interceptors — FGAC, data
// masking, token exchange at infra layer" + anti-pattern #6 "Gateway
// interceptors filter tools per agent").
//
// Pipeline order: FGAC → tool-filter → data-masking → token-exchange.
// Each stage can short-circuit the pipeline with a denial. Pure, deterministic.

import type {
  InterceptorInput,
  InterceptorResult,
  InterceptorStage,
} from "./types";
import { opaqueHandle } from "./util";

/** Field names (case-insensitive substring) treated as PII and masked. */
const PII_HINTS = [
  "email",
  "ssn",
  "phone",
  "dob",
  "birth",
  "address",
  "name",
  "token",
  "secret",
  "password",
];

function isPiiField(field: string): boolean {
  const f = field.toLowerCase();
  return PII_HINTS.some((h) => f.includes(h));
}

/** Mask a value, preserving a small non-sensitive hint. */
function maskValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 2) return "••";
    return `${value.slice(0, 1)}••••${value.slice(-1)}`;
  }
  return "••••";
}

export function maskPii(
  payload: Record<string, unknown>
): { masked: Record<string, unknown>; maskedFields: string[] } {
  const masked: Record<string, unknown> = {};
  const maskedFields: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (isPiiField(k)) {
      masked[k] = maskValue(v);
      maskedFields.push(k);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = maskPii(v as Record<string, unknown>);
      masked[k] = nested.masked;
      maskedFields.push(...nested.maskedFields.map((f) => `${k}.${f}`));
    } else {
      masked[k] = v;
    }
  }
  return { masked, maskedFields };
}

export interface InterceptorOptions {
  /** Tools this agent is allowed to see/use (allowlist). */
  toolAllowlist: string[];
  /** Whether to perform a simulated downstream token exchange at the end. */
  exchangeToken: boolean;
}

/** Run the interceptor pipeline. */
export function runInterceptors(
  input: InterceptorInput,
  opts: InterceptorOptions
): InterceptorResult {
  const stages: InterceptorStage[] = [];

  // 1) FGAC — the caller must hold the scope the tool requires.
  const hasScope = input.callerScopes.includes(input.requiredScope);
  stages.push({
    stage: "fgac",
    passed: hasScope,
    detail: hasScope
      ? `caller holds required scope '${input.requiredScope}'`
      : `caller is missing required scope '${input.requiredScope}'`,
  });
  if (!hasScope) return { allowed: false, stages };

  // 2) tool-filter — the tool must be in the agent's allowlist.
  const allowed = opts.toolAllowlist.includes(input.tool);
  stages.push({
    stage: "tool-filter",
    passed: allowed,
    detail: allowed
      ? `tool '${input.tool}' is in the agent allowlist`
      : `tool '${input.tool}' is NOT in the agent allowlist (filtered)`,
  });
  if (!allowed) return { allowed: false, stages };

  // 3) data-masking — redact PII fields in the payload.
  const { masked, maskedFields } = maskPii(input.payload);
  stages.push({
    stage: "data-masking",
    passed: true,
    detail:
      maskedFields.length > 0
        ? `masked ${maskedFields.length} field(s): ${maskedFields.join(", ")}`
        : "no PII fields detected",
  });

  // 4) token-exchange — simulate swapping the inbound token for a downstream,
  // resource-scoped one (opaque handle only; no raw token).
  let exchangedHandle: string | undefined;
  if (opts.exchangeToken) {
    exchangedHandle = opaqueHandle("exchanged");
    stages.push({
      stage: "token-exchange",
      passed: true,
      detail: `exchanged inbound token for a downstream-scoped handle (SIMULATED)`,
    });
  } else {
    stages.push({
      stage: "token-exchange",
      passed: true,
      detail: "token exchange not required for this tool",
    });
  }

  return { allowed: true, stages, maskedPayload: masked, exchangedHandle };
}
