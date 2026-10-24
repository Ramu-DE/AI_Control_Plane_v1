import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { Persona, TenantMembership } from "@/lib/types";
import {
  TENANT_ROLES,
  canAdminister,
  groupFor,
  groupsWithMemberships,
  isTenantRole,
  membershipsFromGroups,
} from "@/lib/personas";

export async function GET() {
  return NextResponse.json({
    personas: store.personas,
    groups: store.cognitoGroups,
    roles: TENANT_ROLES,
    tenants: store.tenants.map((t) => ({ id: t.id, name: t.tenantName, parentId: t.parentId })),
  });
}

// Map a seniority group to evaluator attributes used by the playground.
function attrsForGroups(groups: string[]): Record<string, string> {
  if (groups.includes("seniority_director"))
    return { group: "seniority_director", role: "director", approvalLimit: "Infinity" };
  if (groups.includes("seniority_manager"))
    return { group: "seniority_manager", role: "manager", approvalLimit: "5000" };
  return { group: "seniority_ic", role: "ic", approvalLimit: "0" };
}

function randomSub(): string {
  const h = () => Math.random().toString(16).slice(2, 6);
  return `${h()}${h()}-${h()}-70${h().slice(0, 2)}-${h()}-${h()}${h()}${h()}`;
}

const REGIONS = new Set(["US", "EU", "JP", "GLOBAL"]);

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    name?: string;
    email?: string;
    provider?: Persona["provider"];
    /** Seniority and/or IdP groups. `TKD-<TENANT>-<ROLE>` groups become memberships. */
    groups?: string[];
    /** Explicit memberships; take precedence over groups. */
    memberships?: TenantMembership[];
    /** Shorthand for a single membership. */
    tenantId?: string;
    role?: string;
    homeTenantId?: string;
    region?: string;
    gxpTrained?: boolean;
    jobTitle?: string;
  };
  if (!body.name || !body.email) {
    return NextResponse.json({ error: "name and email are required" }, { status: 400 });
  }

  // Memberships: explicit > tenant+role shorthand > parsed from IdP groups.
  const groups = [...(body.groups ?? [])];
  let memberships: TenantMembership[] = [];
  if (body.memberships?.length) {
    memberships = body.memberships;
  } else if (body.tenantId) {
    if (!isTenantRole(body.role)) {
      return NextResponse.json(
        { error: `role must be one of ${TENANT_ROLES.join(", ")}` }, { status: 400 });
    }
    memberships = [{ tenantId: body.tenantId, role: body.role }];
  } else {
    const parsed = membershipsFromGroups(groups, store.tenants);
    if (parsed.unmapped.length) {
      return NextResponse.json(
        { error: `group(s) map to no tenant/role: ${parsed.unmapped.join(", ")}` }, { status: 400 });
    }
    memberships = parsed.memberships;
  }
  if (memberships.length === 0) {
    return NextResponse.json(
      { error: "a persona needs at least one tenant membership (tenantId + role, or TKD-<TENANT>-<ROLE> groups)" },
      { status: 400 });
  }
  for (const m of memberships) {
    if (!store.tenants.some((t) => t.id === m.tenantId)) {
      return NextResponse.json({ error: `unknown tenant '${m.tenantId}'` }, { status: 400 });
    }
    if (!isTenantRole(m.role)) {
      return NextResponse.json({ error: `unknown role '${m.role}'` }, { status: 400 });
    }
  }
  if (body.region && !REGIONS.has(body.region)) {
    return NextResponse.json({ error: `region must be one of ${[...REGIONS].join(", ")}` }, { status: 400 });
  }
  // Keep groups and memberships in agreement, as an IdP token would carry them.
  for (const m of memberships) {
    const g = groupFor(m);
    if (!groups.includes(g)) groups.push(g);
  }
  if (!groups.some((g) => g.startsWith("seniority_"))) groups.unshift("seniority_ic");

  const persona: Persona = {
    id: newId("persona"),
    name: body.name,
    email: body.email,
    sub: randomSub(),
    provider: body.provider ?? "Entra ID",
    groups,
    attributes: {
      ...attrsForGroups(groups),
      ...(body.region ? { region: body.region } : {}),
      gxpTrained: String(Boolean(body.gxpTrained)),
      ...(body.jobTitle ? { jobTitle: body.jobTitle } : {}),
    },
    memberships,
    homeTenantId: body.homeTenantId ?? memberships[0].tenantId,
  };
  store.personas.push(persona);
  logAudit({
    category: "policy",
    action: "create-persona",
    actor: "console-user",
    tenantId: persona.homeTenantId,
    detail:
      `Created persona '${persona.name}' — ` +
      memberships.map((m) => `${m.role} in ${m.tenantId}`).join(", "),
  });
  return NextResponse.json(persona, { status: 201 });
}

/** Resolve the acting persona for an edit/delete, or a refusal. */
function actorFor(actorPersonaId: string | undefined, target: Persona) {
  const actor = store.personas.find((p) => p.id === actorPersonaId && !p.disabled);
  if (!actor) {
    return { error: NextResponse.json(
      { error: "actorPersonaId is required: an identity change must name who made it", code: "ACTOR_REQUIRED" },
      { status: 400 }) };
  }
  if (actor.id === target.id) {
    return { error: NextResponse.json(
      { error: "a persona cannot change or remove its own access", code: "SELF_ADMIN" }, { status: 403 }) };
  }
  return { actor };
}

/**
 * PATCH → edit a persona. Memberships, region, GxP training, job title, name.
 *
 * You can only grant, change or remove access where you are an ADMIN: every
 * tenant in the persona's old AND new memberships must be one the actor
 * administers. Otherwise an admin of one BU could quietly widen someone's
 * access into another.
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    id?: string;
    actorPersonaId?: string;
    name?: string;
    memberships?: TenantMembership[];
    region?: string;
    gxpTrained?: boolean;
    jobTitle?: string;
  };
  const target = store.personas.find((p) => p.id === body.id);
  if (!target) return NextResponse.json({ error: "persona not found" }, { status: 404 });
  const a = actorFor(body.actorPersonaId, target);
  if ("error" in a) return a.error;
  const { actor } = a;

  if (body.memberships) {
    if (body.memberships.length === 0) {
      return NextResponse.json(
        { error: "a persona needs at least one membership; use DELETE to remove access entirely" },
        { status: 400 });
    }
    for (const m of body.memberships) {
      if (!store.tenants.some((t) => t.id === m.tenantId)) {
        return NextResponse.json({ error: `unknown tenant '${m.tenantId}'` }, { status: 400 });
      }
      if (!isTenantRole(m.role)) return NextResponse.json({ error: `unknown role '${m.role}'` }, { status: 400 });
    }
    const before = (target.memberships ?? []).map((m) => `${m.tenantId}:${m.role}`);
    const after = body.memberships.map((m) => `${m.tenantId}:${m.role}`);
    const touched = new Set(
      [...before.filter((x) => !after.includes(x)), ...after.filter((x) => !before.includes(x))]
        .map((x) => x.split(":")[0]));
    const outside = [...touched].filter((t) => !canAdminister(actor, t, store.tenants));
    if (outside.length) {
      const why = `${actor.name} is not an admin of ${outside.join(", ")}, so cannot change access there`;
      logAudit({ category: "policy", action: "edit-persona-denied", actor: actor.name,
        detail: `DENY edit of '${target.name}': ${why}` });
      return NextResponse.json({ error: why, code: "ACTOR_NOT_PERMITTED" }, { status: 403 });
    }
  } else {
    // Attribute-only edit: the actor must administer at least one of the persona's tenants.
    if (!(target.memberships ?? []).some((m) => canAdminister(actor, m.tenantId, store.tenants))) {
      return NextResponse.json(
        { error: `${actor.name} administers none of ${target.name}'s tenants`, code: "ACTOR_NOT_PERMITTED" },
        { status: 403 });
    }
  }
  if (body.region !== undefined && !REGIONS.has(body.region)) {
    return NextResponse.json({ error: `region must be one of ${[...REGIONS].join(", ")}` }, { status: 400 });
  }

  const changes: string[] = [];
  if (body.name && body.name !== target.name) { changes.push(`name → ${body.name}`); target.name = body.name; }
  if (body.memberships) {
    target.memberships = body.memberships.map((m) => ({ tenantId: m.tenantId, role: m.role }));
    target.groups = groupsWithMemberships(target.groups, target.memberships);
    changes.push(`memberships → ${target.memberships.map((m) => `${m.role}@${m.tenantId}`).join(", ")}`);
  }
  if (body.region !== undefined) { target.attributes.region = body.region; changes.push(`region → ${body.region}`); }
  if (body.gxpTrained !== undefined) {
    target.attributes.gxpTrained = String(Boolean(body.gxpTrained));
    changes.push(`gxpTrained → ${target.attributes.gxpTrained}`);
  }
  if (body.jobTitle !== undefined) { target.attributes.jobTitle = body.jobTitle; changes.push("jobTitle"); }
  logAudit({ category: "policy", action: "edit-persona", actor: actor.name,
    ...(target.homeTenantId ? { tenantId: target.homeTenantId } : {}),
    detail: `Edited persona '${target.name}' (${target.id}): ${changes.join("; ") || "no change"}` });
  return NextResponse.json(target);
}

/**
 * DELETE ?id=…&actorPersonaId=… → remove a persona's access.
 *
 * A persona that appears in the record — started or reviewed a run, submitted
 * or decided an approval — is DISABLED, not deleted: the audit trail points at
 * it. Disabled personas fail every authorization. Only a persona nothing
 * refers to is removed. The actor must administer every one of its tenants.
 */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? undefined;
  const target = store.personas.find((p) => p.id === id);
  if (!target) return NextResponse.json({ error: "persona not found" }, { status: 404 });
  const a = actorFor(req.nextUrl.searchParams.get("actorPersonaId") ?? undefined, target);
  if ("error" in a) return a.error;
  const { actor } = a;
  const outside = (target.memberships ?? [])
    .map((m) => m.tenantId)
    .filter((t) => !canAdminister(actor, t, store.tenants));
  if (outside.length) {
    return NextResponse.json(
      { error: `${actor.name} is not an admin of ${outside.join(", ")}`, code: "ACTOR_NOT_PERMITTED" },
      { status: 403 });
  }
  const referenced =
    store.workflowRuns.some((r) =>
      r.personaId === target.id || r.steps.some((s) => s.reviewerPersonaId === target.id)) ||
    store.records.some((r) =>
      r.submittedByPersonaId === target.id || r.decidedByPersonaId === target.id);
  if (referenced) {
    target.disabled = true;
    logAudit({ category: "policy", action: "disable-persona", actor: actor.name,
      detail: `Disabled persona '${target.name}' (${target.id}) — referenced by the audit trail, so kept` });
    return NextResponse.json({ outcome: "disabled", persona: target });
  }
  store.personas.splice(store.personas.indexOf(target), 1);
  logAudit({ category: "policy", action: "delete-persona", actor: actor.name,
    detail: `Deleted persona '${target.name}' (${target.id})` });
  return NextResponse.json({ outcome: "deleted", id: target.id });
}
