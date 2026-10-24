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
import { inTenantSubtree, tenantPolicyAttributes } from "./tenancy";
import { effectiveAttributes, personaTenantDecision, roleAllows } from "./personas";
import type { PersonaTenantDecision } from "./personas";
// Type-only import — see the note in store.ts.
import type {
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
  /** `action in [Action::"a", ...]` — matched against the request's ACTION. */
  actions?: string[];
  /** Each clause is OR-of-ANDs: alternatives split on `||`. null = absent. */
  when: Condition[][] | null;
  unless: Condition[][] | null;
}

interface Condition {
  attr: string;
  op: "==" | "<=" | ">=" | "<" | ">";
  value: string | number;
}

function parseConditions(body: string): Condition[] {
  const conds: Condition[] = [];
  // principal.<attr> == resource.<attr> — string equality between the two
  // sides (data residency: the person's region against the data's). Parsed
  // FIRST and removed, so the single-sided forms below do not misread it.
  const both = /principal\.(\w+)\s*==\s*resource\.(\w+)/g;
  let bm: RegExpExecArray | null;
  while ((bm = both.exec(body)) !== null) {
    conds.push({ attr: `__eq__${bm[1]}:${bm[2]}`, op: "==", value: 0 });
  }
  body = body.replace(both, " ");
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
  // `resource.tenant == "<id>"` — the tenant dimension, matched against the
  // request's tenant AND its ancestors (see conditionsHold).
  const tenantRe = /resource\.tenant\s*==\s*"([^"]*)"/g;
  let tm: RegExpExecArray | null;
  while ((tm = tenantRe.exec(body)) !== null) {
    conds.push({ attr: "__tenant__", op: "==", value: tm[1] });
  }
  // `resource.<attr> == "<v>"` for the tenant's regulatory attributes
  // (gxp, region, regionBound), read off the request's tenant.
  const resRe = /resource\.(gxp|region|regionBound)\s*==\s*"([^"]*)"/g;
  let rm: RegExpExecArray | null;
  while ((rm = resRe.exec(body)) !== null) {
    conds.push({ attr: `__res__${rm[1]}`, op: "==", value: rm[2] });
  }
  // also support resource.amount <= principal.approvalLimit (numeric cross-ref)
  const cross = /resource\.(\w+)\s*(<=|>=|<|>)\s*principal\.(\w+)/.exec(body);
  if (cross) {
    conds.push({ attr: `__cross__${cross[1]}:${cross[3]}`, op: cross[2] as Condition["op"], value: 0 });
  }
  return conds;
}

function parseClause(cedar: string, kind: "when" | "unless"): Condition[][] | null {
  const m = new RegExp(`\\b${kind}\\s*\\{([^}]*)\\}`).exec(cedar);
  if (!m) return null;
  return m[1].split("||").map((alt) => parseConditions(alt));
}

function parseCedar(cedar: string): ParsedCedar {
  const effect: PolicyEffect = /^\s*forbid/.test(cedar) ? "forbid" : "permit";
  const resourceMatch = /resource\s*==\s*Tool::"([^"]+)"/.exec(cedar);
  const inMatch = /action\s+in\s+\[([^\]]*)\]/.exec(cedar);
  const actions = inMatch
    ? [...inMatch[1].matchAll(/Action::"([^"]+)"/g)].map((a) => a[1])
    : undefined;
  return {
    effect,
    resource: resourceMatch?.[1],
    ...(actions ? { actions } : {}),
    when: parseClause(cedar, "when"),
    unless: parseClause(cedar, "unless"),
  };
}

function toNum(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function conditionsHold(
  conditions: Condition[],
  persona: Persona,
  req: EvaluationRequest
): boolean {
  const resourceAttrs = tenantPolicyAttributes(req.tenantId, store.tenants);
  for (const c of conditions) {
    if (c.attr === "__tenant__") {
      // A tenant-scoped policy applies to that tenant AND its descendants:
      // an org-level rule is meant to cover the BUs beneath it. Exact-match
      // only would make every parent policy need restating per sub-unit, and
      // the one nobody restates is the hole.
      if (!req.tenantId) return false;   // fail closed: no tenant, no match
      const target = String(c.value);
      if (
        req.tenantId !== target &&
        !inTenantSubtree(req.tenantId, target, store.tenants)
      ) {
        return false;
      }
      continue;
    }
    if (c.attr.startsWith("__res__")) {
      if (resourceAttrs[c.attr.slice("__res__".length)] !== c.value) return false;
      continue;
    }
    if (c.attr.startsWith("__eq__")) {
      const [pAttr, rAttr] = c.attr.slice("__eq__".length).split(":");
      const left = persona.attributes[pAttr];
      if (left === undefined || left !== resourceAttrs[rAttr]) return false;
      continue;
    }
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

/** Cedar semantics: `when` must hold AND `unless` must not. Each clause is OR-of-ANDs. */
function policyConditionsApply(parsed: ParsedCedar, persona: Persona, req: EvaluationRequest): boolean {
  const any = (alts: Condition[][]) => alts.some((alt) => conditionsHold(alt, persona, req));
  if (parsed.when && !any(parsed.when)) return false;
  if (parsed.unless && any(parsed.unless)) return false;
  return true;
}

function policyApplies(policy: Policy, req: EvaluationRequest): boolean {
  const parsed = parseCedar(policy.cedar);
  // `action in [...]` names ACTIONS (runAgent, queryGraphSource, ...), not
  // tools — so one regulatory policy can cover every way of touching data.
  if (parsed.actions) {
    if (!parsed.actions.includes(req.action)) return false;
    return parsed.resource ? parsed.resource === req.tool : true;
  }
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
    const applies = policyConditionsApply(parsed, persona, req);

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
  if (persona?.disabled) {
    return {
      allowed: false,
      decisions: [{ layer: "gateway", decision: "default-deny", reason: `${persona.name} is disabled.` }],
      evaluatedAt: new Date().toISOString(),
    };
  }
  if (!persona) {
    return {
      allowed: false,
      decisions: [
        { layer: "gateway", decision: "default-deny", reason: "Unknown persona." },
      ],
      evaluatedAt: new Date().toISOString(),
    };
  }

  // Layer 0: tenant membership. A request that acts within a tenant is only
  // evaluated for a persona who belongs there (or to a tenant above it). This
  // runs BEFORE policy because no permit should be able to grant a stranger
  // access to a tenant: membership is identity, policy is what members may do.
  // Requests with no tenant (the playground's expense demo) are unaffected.
  let tenancy: PersonaTenantDecision | null = null;
  if (req.tenantId) {
    tenancy = personaTenantDecision(persona, req.tenantId, store.tenants);
    if (!tenancy.allowed) {
      return {
        allowed: false,
        decisions: [{ layer: "gateway", decision: "default-deny", reason: tenancy.reason }],
        evaluatedAt: new Date().toISOString(),
      };
    }
    const byRole = roleAllows(tenancy.role, req.action);
    if (!byRole.allowed) {
      return {
        allowed: false,
        decisions: [{
          layer: "gateway",
          decision: "default-deny",
          reason: `${persona.name} is ${tenancy.role} in '${tenancy.via}'; ${req.action} needs ${byRole.needed} or above`,
        }],
        evaluatedAt: new Date().toISOString(),
      };
    }
  }
  // Cedar sees the role resolved for THIS tenant (`principal.tenantRole`).
  const scoped: Persona = { ...persona, attributes: effectiveAttributes(persona, tenancy) };

  // Layer 1: gateway perimeter must explicitly permit (and not forbid).
  const gateway = evaluateLayer("gateway", scoped, req);
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

  const avp = evaluateLayer("avp", scoped, req);
  decisions.push(avp);
  const allowed = avp.decision === "permit";
  return { allowed, decisions, evaluatedAt: new Date().toISOString() };
}
