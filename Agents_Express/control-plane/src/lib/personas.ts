// Tenant-scoped personas — who may act in which Takeda BU/BF, and as what.
//
// A persona used to be platform-wide: any identity could run any tenant's
// agents, query any tenant's graph, read any tenant's knowledge base, because
// the tenant came from the WORKFLOW and nothing asked whether the person
// belonged to it. This module gives every persona tenant memberships and is
// the single place that answers "may this persona act in this tenant?".
//
// The rule is the tenant tree's, used everywhere else (lib/tenancy.ts): a
// membership covers its tenant and every descendant; it never reaches a
// sibling or flows up to a parent. Where several memberships cover a tenant,
// the NEAREST one decides the role — a viewer of Takeda who is an approver in
// R&D is an approver in R&D Research.
//
// Memberships come from the identity provider. Takeda's Entra ID groups follow
// `TKD-<TENANT>-<ROLE>` (TKD-FN-RND-ANALYST), so a persona can be built from a
// tenant + role choice or from the groups an IdP token actually carries, and
// the two always agree.
//
// Pure: no store access, so it is tested directly.

import { tenantChain } from "./tenancy";
import type { Persona, Tenant, TenantMembership, TenantRole } from "./types";

export const TENANT_ROLES: TenantRole[] = ["viewer", "analyst", "approver", "admin"];
export const GROUP_PREFIX = "TKD-";

export function isTenantRole(v: unknown): v is TenantRole {
  return typeof v === "string" && (TENANT_ROLES as string[]).includes(v);
}

/**
 * May `actor` administer identities in `tenantId`? Admin of that tenant or
 * of one above it. Used for persona edits: you can only grant, change or
 * remove access where you yourself are an admin.
 */
export function canAdminister(actor: Persona, tenantId: string, tenants: Tenant[]): boolean {
  const d = personaTenantDecision(actor, tenantId, tenants);
  return d.allowed && d.role === "admin";
}

/** IdP groups for a persona: keep non-tenant groups, regenerate TKD- groups. */
export function groupsWithMemberships(groups: string[], memberships: TenantMembership[]): string[] {
  const kept = groups.filter((g) => !g.toUpperCase().startsWith(GROUP_PREFIX));
  return [...kept, ...memberships.map(groupFor)];
}

/** `fn-rnd` + `analyst` -> `TKD-FN-RND-ANALYST`. */
export function groupFor(m: TenantMembership): string {
  return `${GROUP_PREFIX}${m.tenantId.toUpperCase()}-${m.role.toUpperCase()}`;
}

/**
 * Parse `TKD-<TENANT>-<ROLE>` groups into memberships. A group naming a tenant
 * that does not exist is REPORTED, not dropped silently: an IdP group that
 * maps to nothing is a provisioning error someone should see.
 */
export function membershipsFromGroups(
  groups: string[],
  tenants: Tenant[]
): { memberships: TenantMembership[]; unmapped: string[] } {
  const ids = new Set(tenants.map((t) => t.id));
  const memberships: TenantMembership[] = [];
  const unmapped: string[] = [];
  for (const g of groups) {
    if (!g.toUpperCase().startsWith(GROUP_PREFIX)) continue; // seniority etc.
    const body = g.slice(GROUP_PREFIX.length);
    const cut = body.lastIndexOf("-");
    const tenantId = body.slice(0, cut).toLowerCase();
    const role = body.slice(cut + 1).toLowerCase();
    if (cut <= 0 || !isTenantRole(role) || !ids.has(tenantId)) {
      unmapped.push(g);
      continue;
    }
    memberships.push({ tenantId, role });
  }
  return { memberships, unmapped };
}

export interface PersonaTenantDecision {
  allowed: boolean;
  /** The role in force for this tenant, from the nearest covering membership. */
  role?: TenantRole;
  /** The tenant whose membership granted it (the tenant itself or an ancestor). */
  via?: string;
  reason: string;
}

/** May `persona` act in `tenantId`? Fails closed with no memberships. */
export function personaTenantDecision(
  persona: Persona,
  tenantId: string,
  tenants: Tenant[]
): PersonaTenantDecision {
  if (persona.disabled) {
    return { allowed: false, reason: `${persona.name} is disabled` };
  }
  const memberships = persona.memberships ?? [];
  if (memberships.length === 0) {
    return { allowed: false, reason: `${persona.name} has no tenant membership` };
  }
  // tenantChain is [tenant, parent, ..., root]; the first hit is the nearest.
  const chain = tenantChain(tenantId, tenants);
  const path = chain.length ? chain : [tenantId];
  for (const id of path) {
    const m = memberships.find((x) => x.tenantId === id);
    if (m) {
      return {
        allowed: true,
        role: m.role,
        via: id,
        reason:
          id === tenantId
            ? `${persona.name} is ${m.role} in '${tenantId}'`
            : `${persona.name} is ${m.role} in '${id}', which contains '${tenantId}'`,
      };
    }
  }
  return {
    allowed: false,
    reason:
      `${persona.name} is not a member of '${tenantId}' or any tenant above it ` +
      `(member of: ${memberships.map((m) => m.tenantId).join(", ")})`,
  };
}

const ROLE_RANK: Record<TenantRole, number> = { viewer: 0, analyst: 1, approver: 2, admin: 3 };

/**
 * The least role that may perform an action INSIDE a tenant. Membership says
 * who belongs; this says what each kind of member may do, so a viewer can read
 * a graph but cannot run an agent. Actions not listed need only membership.
 * Policy (Cedar) still decides on top of this — it can only narrow further.
 */
export const ACTION_MIN_ROLE: Record<string, TenantRole> = {
  queryGraphSource: "viewer",
  queryKnowledgeBase: "viewer",
  useMemory: "viewer",
  runAgent: "analyst",
  callAgent: "analyst",
  invokeTool: "analyst",
  buildKnowledgeGraph: "analyst",
  approveExpense: "approver",
  approveReviewGate: "approver",
  approveRecord: "approver",
  submitRecord: "analyst",
};

/** Does the role in force meet the action's minimum? */
export function roleAllows(role: TenantRole | undefined, action: string): { allowed: boolean; needed?: TenantRole } {
  const needed = ACTION_MIN_ROLE[action];
  if (!needed) return { allowed: true };
  return { allowed: role !== undefined && ROLE_RANK[role] >= ROLE_RANK[needed], needed };
}

/**
 * The attributes Cedar sees for this persona IN this tenant. The per-tenant
 * role is resolved here so a policy can say `principal.tenantRole == "approver"`
 * and mean "approver HERE", not "approver somewhere".
 */
export function effectiveAttributes(
  persona: Persona,
  decision: PersonaTenantDecision | null
): Record<string, string> {
  return {
    ...persona.attributes,
    ...(persona.homeTenantId ? { homeTenant: persona.homeTenantId } : {}),
    ...(decision?.allowed && decision.role ? { tenantRole: decision.role } : {}),
  };
}

// --------------------------------------------------------------------------- //
// Seeds and migration
// --------------------------------------------------------------------------- //

/** The workshop's AnyCompany identities stay usable everywhere — EXPLICITLY,
 *  as org-wide test personas, rather than by the absence of any check. */
export const WORKSHOP_MEMBERSHIPS: Record<string, TenantMembership[]> = {
  "persona-john": [{ tenantId: "takeda", role: "approver" }],
  "persona-mary": [{ tenantId: "takeda", role: "admin" }],
};

interface TakedaPersonaSpec {
  id: string;
  name: string;
  email: string;
  home: string;
  memberships: TenantMembership[];
  seniority: "seniority_ic" | "seniority_manager" | "seniority_director";
  region: "US" | "EU" | "JP" | "GLOBAL";
  gxpTrained: boolean;
  jobTitle: string;
}

// Illustrative, synthetic identities (example.com) shaped like Takeda's org:
// one per kind of access pattern worth testing, not one per tenant.
const TAKEDA_PERSONAS: TakedaPersonaSpec[] = [
  { id: "persona-priya", name: "Priya Raman", email: "priya.raman@takeda.example.com",
    home: "fn-rnd", memberships: [{ tenantId: "fn-rnd", role: "analyst" }],
    seniority: "seniority_ic", region: "US", gxpTrained: true, jobTitle: "Clinical Data Scientist" },
  { id: "persona-daniel", name: "Daniel Okafor", email: "daniel.okafor@takeda.example.com",
    home: "fn-rnd", memberships: [{ tenantId: "fn-rnd", role: "approver" }, { tenantId: "fn-medical", role: "viewer" }],
    seniority: "seniority_director", region: "US", gxpTrained: true, jobTitle: "Head of Clinical Operations" },
  { id: "persona-lena", name: "Lena Fischer", email: "lena.fischer@takeda.example.com",
    home: "fn-supply", memberships: [{ tenantId: "fn-supply", role: "analyst" }],
    seniority: "seniority_ic", region: "EU", gxpTrained: true, jobTitle: "Supply Planner" },
  { id: "persona-kenji", name: "Kenji Watanabe", email: "kenji.watanabe@takeda.example.com",
    home: "bu-japan", memberships: [{ tenantId: "bu-japan", role: "approver" }],
    seniority: "seniority_manager", region: "JP", gxpTrained: false, jobTitle: "BU Japan Commercial Lead" },
  { id: "persona-omar", name: "Omar Haddad", email: "omar.haddad@takeda.example.com",
    home: "fn-procurement", memberships: [{ tenantId: "fn-procurement", role: "approver" }],
    seniority: "seniority_manager", region: "GLOBAL", gxpTrained: false, jobTitle: "Category Manager" },
  { id: "persona-sofia", name: "Sofia Rossi", email: "sofia.rossi@takeda.example.com",
    home: "bu-plasma-biolife", memberships: [{ tenantId: "bu-plasma-biolife", role: "viewer" }],
    seniority: "seniority_ic", region: "EU", gxpTrained: false, jobTitle: "BioLife Centre Analyst" },
];

const SENIORITY_ATTRS: Record<TakedaPersonaSpec["seniority"], Record<string, string>> = {
  seniority_director: { group: "seniority_director", role: "director", approvalLimit: "Infinity" },
  seniority_manager: { group: "seniority_manager", role: "manager", approvalLimit: "5000" },
  seniority_ic: { group: "seniority_ic", role: "ic", approvalLimit: "0" },
};

/** Stable pseudo-sub from the id, so seeds are deterministic across restarts. */
function subFor(id: string): string {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  const a = hex(h), b = hex(Math.imul(h, 2654435761)), c = hex(Math.imul(h ^ 0x9e3779b9, 40503));
  return `${a}-${b.slice(0, 4)}-70${b.slice(4, 6)}-${c.slice(0, 4)}-${c.slice(4)}${a.slice(0, 4)}`;
}

export function takedaPersonas(): Persona[] {
  return TAKEDA_PERSONAS.map((p) => ({
    id: p.id,
    name: p.name,
    sub: subFor(p.id),
    email: p.email,
    provider: "Entra ID",
    groups: [p.seniority, ...p.memberships.map(groupFor)],
    attributes: {
      ...SENIORITY_ATTRS[p.seniority],
      region: p.region,
      gxpTrained: String(p.gxpTrained),
      jobTitle: p.jobTitle,
    },
    memberships: p.memberships,
    homeTenantId: p.home,
  }));
}

/**
 * Bring a restored persona list up to this model WITHOUT touching user-created
 * personas' choices: the workshop identities gain their explicit org-wide
 * membership, and missing seeded Takeda personas are added. A persona with no
 * memberships otherwise stays that way and fails closed — it is shown as
 * unscoped in Settings rather than quietly granted a tenant.
 */
export function upgradePersonas(personas: Persona[]): string[] {
  const changes: string[] = [];
  for (const p of personas) {
    if (!p.memberships && WORKSHOP_MEMBERSHIPS[p.id]) {
      p.memberships = WORKSHOP_MEMBERSHIPS[p.id].map((m) => ({ ...m }));
      p.homeTenantId = p.homeTenantId ?? "takeda";
      changes.push(`${p.id} -> org-wide test persona`);
    }
    // Org-wide test identities are also EXPLICITLY GxP-trained and GLOBAL, so
    // the regulatory policies apply to them visibly rather than by omission.
    if (WORKSHOP_MEMBERSHIPS[p.id] && p.attributes.gxpTrained === undefined) {
      p.attributes.gxpTrained = "true";
      p.attributes.region = p.attributes.region ?? "GLOBAL";
      changes.push(`${p.id} -> gxpTrained, GLOBAL`);
    }
  }
  for (const seeded of takedaPersonas()) {
    if (!personas.some((p) => p.id === seeded.id)) {
      personas.push(seeded);
      changes.push(`added ${seeded.id}`);
    }
  }
  return changes;
}
