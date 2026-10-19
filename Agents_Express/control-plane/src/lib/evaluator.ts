// A lightweight, deterministic evaluator that simulates the two-layer
// authorization model from the workshop:
//   Layer 1 (gateway): AgentCore Policy at the MCP perimeter.
//   Layer 2 (avp):     Amazon Verified Permissions inside the tool.
//
// This is NOT a full Cedar engine. It parses the seeded Cedar snippets just
// enough to demonstrate permit/forbid + `when`/`unless` role conditions and
// numeric comparisons, so the Playground produces explainable allow/deny
// results. Replace with the real Cedar engine / AVP when wiring to AWS.

import { store } from "./store";
import {
  EvaluationRequest,
  EvaluationResult,
  LayerDecision,
  Persona,
  Policy,
  PolicyEffect,
} from "./types";

interface ParsedCedar {
  effect: PolicyEffect;
  resource?: string; // Tool::"..." or Action target
  conditions: Condition[];
  conditionKind: "when" | "unless" | null;
}

interface Condition {
  attr: string;
  op: "==" | "<=" | ">=" | "<" | ">";
  value: string | number;
}

function parseConditions(body: string): Condition[] {
  const conds: Condition[] = [];
  // match principal.<attr> <op> <value> (value quoted string or number)
  const re = /principal\.(\w+)\s*(==|<=|>=|<|>)\s*("([^"]*)"|\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const attr = m[1];
    const op = m[2] as Condition["op"];
    const raw = m[3];
    const value = raw.startsWith('"') ? m[4] : Number(raw);
    conds.push({ attr, op, value });
  }
  // also support resource.amount <= principal.approvalLimit (cross-ref)
  const cross = /resource\.(\w+)\s*(<=|>=|<|>|==)\s*principal\.(\w+)/.exec(body);
  if (cross) {
    conds.push({ attr: `__cross__${cross[1]}:${cross[3]}`, op: cross[2] as Condition["op"], value: 0 });
  }
  return conds;
}

function parseCedar(cedar: string): ParsedCedar {
  const effect: PolicyEffect = /^\s*forbid/.test(cedar) ? "forbid" : "permit";
  const resourceMatch = /resource\s*==\s*Tool::"([^"]+)"/.exec(cedar);
  let conditionKind: "when" | "unless" | null = null;
  if (/\bunless\b/.test(cedar)) conditionKind = "unless";
  else if (/\bwhen\b/.test(cedar)) conditionKind = "when";
  const condBody = cedar.split(/\bwhen\b|\bunless\b/)[1] ?? "";
  return {
    effect,
    resource: resourceMatch?.[1],
    conditions: parseConditions(condBody),
    conditionKind,
  };
}

function toNum(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function conditionsHold(
  parsed: ParsedCedar,
  persona: Persona,
  req: EvaluationRequest
): boolean {
  for (const c of parsed.conditions) {
    if (c.attr.startsWith("__cross__")) {
      // resource.<x> <op> principal.<y> — demo uses amount vs approvalLimit.
      const [, spec] = c.attr.split("__cross__");
      const [, pAttr] = spec.split(":");
      const limit = toNum(persona.attributes[pAttr]);
      // Demo resource amount: derive from request (default 1000).
      const amount = toNum(req.amount) || 1000;
      if (c.op === "<=" && !(amount <= limit)) return false;
      if (c.op === ">=" && !(amount >= limit)) return false;
      if (c.op === "<" && !(amount < limit)) return false;
      if (c.op === ">" && !(amount > limit)) return false;
      continue;
    }
    const actual = persona.attributes[c.attr];
    if (typeof c.value === "number") {
      const a = toNum(actual);
      if (c.op === "==" && !(a === c.value)) return false;
      if (c.op === "<=" && !(a <= c.value)) return false;
      if (c.op === ">=" && !(a >= c.value)) return false;
      if (c.op === "<" && !(a < c.value)) return false;
      if (c.op === ">" && !(a > c.value)) return false;
    } else {
      if (c.op === "==" && actual !== c.value) return false;
    }
  }
  return true;
}

function policyApplies(policy: Policy, req: EvaluationRequest): boolean {
  const parsed = parseCedar(policy.cedar);
  // Gateway policies reference the tool as `resource == Tool::"<tool>"`.
  if (parsed.resource) return parsed.resource === req.tool;
  // AVP policies reference the tool as `action == Action::"<tool>"`.
  const actionMatch = /action\s*==\s*Action::"([^"]+)"/.exec(policy.cedar);
  if (actionMatch && actionMatch[1] !== "invokeTool") {
    return actionMatch[1] === req.tool;
  }
  return true;
}

// Does an AVP policy govern this specific tool? AVP policies target the tool
// via `action == Action::"<tool>"`.
function avpPolicyTargets(policy: Policy, req: EvaluationRequest): boolean {
  const actionMatch = /action\s*==\s*Action::"([^"]+)"/.exec(policy.cedar);
  return !!actionMatch && actionMatch[1] === req.tool;
}

function evaluateLayer(
  layer: "gateway" | "avp",
  persona: Persona,
  req: EvaluationRequest
): LayerDecision {
  const policies = store.policies.filter(
    (p) => p.enabled && p.layer === layer && policyApplies(p, req)
  );

  // Cedar semantics: explicit forbid wins; otherwise need an explicit permit.
  let permitMatch: { policy: Policy } | null = null;

  for (const p of policies) {
    const parsed = parseCedar(p.cedar);
    const condHold = conditionsHold(parsed, persona, req);
    // `when` => applies only if conditions hold. `unless` => applies unless conditions hold.
    const applies =
      parsed.conditionKind === "unless"
        ? !condHold
        : parsed.conditionKind === "when"
        ? condHold
        : true;

    if (!applies) continue;

    if (parsed.effect === "forbid") {
      return {
        layer,
        decision: "forbid",
        matchedPolicyId: p.id,
        reason: `Explicit forbid by '${p.name}'.`,
      };
    }
    if (parsed.effect === "permit") {
      permitMatch = { policy: p };
    }
  }

  if (permitMatch) {
    return {
      layer,
      decision: "permit",
      matchedPolicyId: permitMatch.policy.id,
      reason: `Permitted by '${permitMatch.policy.name}'.`,
    };
  }

  return {
    layer,
    decision: "default-deny",
    reason: "No matching permit policy; default-deny.",
  };
}

export function evaluate(req: EvaluationRequest): EvaluationResult {
  const persona = store.personas.find((p) => p.id === req.personaId);
  if (!persona) {
    return {
      allowed: false,
      decisions: [
        { layer: "gateway", decision: "default-deny", reason: "Unknown persona." },
      ],
      evaluatedAt: new Date().toISOString(),
    };
  }

  // Layer 1: gateway perimeter must explicitly permit (and not forbid).
  const gateway = evaluateLayer("gateway", persona, req);
  const decisions: LayerDecision[] = [gateway];

  if (gateway.decision !== "permit") {
    return { allowed: false, decisions, evaluatedAt: new Date().toISOString() };
  }

  // Layer 2: AVP inside the tool. Only relevant if AVP policies target this tool.
  const avpTargets = store.policies.filter(
    (p) => p.enabled && p.layer === "avp" && avpPolicyTargets(p, req)
  );

  if (avpTargets.length === 0) {
    // No AVP policy governs this tool: the gateway permit stands.
    return { allowed: true, decisions, evaluatedAt: new Date().toISOString() };
  }

  const avp = evaluateLayer("avp", persona, req);
  decisions.push(avp);
  const allowed = avp.decision === "permit";
  return { allowed, decisions, evaluatedAt: new Date().toISOString() };
}
