// GxP and data-residency controls, as POLICY — not as code paths.
//
// Two facts meet here:
//   - the tenant: is it GxP-regulated, is its data bound to a region? Set on
//     the tenant and inherited down the tree (lib/tenancy.ts), so marking R&D
//     GxP covers every R&D sub-unit.
//   - the persona: is the person GxP-trained, which region are they in?
//     (attributes from the IdP — lib/personas.ts)
//
// The rules that join them are ordinary Cedar forbid policies, visible and
// editable in the Policy Library like any other. Forbid wins over any permit,
// so no BU-level permit can accidentally open GxP data to untrained staff.
//
// The action list covers every way a persona touches tenant data or decides
// on it, including approving a workflow's review gate: an approver of a GxP
// run must be GxP-trained too.

import type { Policy } from "./types";

export const REGULATED_ACTIONS = [
  "runAgent",
  "queryGraphSource",
  "queryKnowledgeBase",
  "useMemory",
  "buildKnowledgeGraph",
  "callAgent",
  "approveReviewGate",
  "approveRecord",
  "viewDocument",
  "processDocument",
  "reviewDocument",
  "finalizeDocument",
  "manageDocumentType",
  "approveDocumentType",
  "viewCorpus",
  "manageCorpus",
  "approveCorpus",
  "queryCorpus",
];

const actionList = REGULATED_ACTIONS.map((a) => `Action::"${a}"`).join(", ");

export const REVIEW_GATE_TOOL = "review-gate";
export const REVIEW_GATE_ACTION = "approveReviewGate";
/** Approving / rejecting / deprecating Registry records and Graph Sources. */
export const APPROVALS_TOOL = "approvals";
export const APPROVE_RECORD_ACTION = "approveRecord";
/** Document Intelligence (IDP) actions, all on the perimeter tool below. */
export const DOCINTEL_TOOL = "docintel";
export const DOCINTEL_ACTIONS = [
  "viewDocument", "processDocument", "reviewDocument", "finalizeDocument", "manageDocumentType", "approveDocumentType",
] as const;
/** RAG Factory actions (corpora built from finalized documents), on the perimeter tool below. */
export const RAG_FACTORY_TOOL = "ragfactory";
export const RAG_FACTORY_ACTIONS = ["viewCorpus", "manageCorpus", "approveCorpus", "queryCorpus"] as const;

export function regulatoryPolicies(createdAt: string): Policy[] {
  return [
    {
      id: "pol-gw-review-gate",
      name: "Gateway: tenant approvers may decide workflow review gates",
      layer: "gateway",
      description:
        "Perimeter for review-gate decisions. The platform already requires the reviewer to be an approver (or admin) in the run's tenant and a different person from the one who started the run; scope further with resource.tenant.",
      enabled: true,
      createdAt,
      cedar: `permit(
  principal,
  action == Action::"${REVIEW_GATE_ACTION}",
  resource == Tool::"${REVIEW_GATE_TOOL}"
);`,
    },
    {
      id: "pol-gw-approvals",
      name: "Gateway: tenant approvers may decide Registry records and Graph Sources",
      layer: "gateway",
      description:
        "Perimeter for approve / reject / deprecate decisions on Registry records and Graph Sources. The platform already requires an approver (or admin) in the resource's tenant (the org root for platform-provided records) who did not submit it.",
      enabled: true,
      createdAt,
      cedar: `permit(
  principal,
  action == Action::"${APPROVE_RECORD_ACTION}",
  resource == Tool::"${APPROVALS_TOOL}"
);`,
    },
    {
      id: "pol-gw-docintel",
      name: "Gateway: tenant members may use Document Intelligence (IDP)",
      layer: "gateway",
      description:
        "Perimeter for the Document Intelligence module. The platform already enforces the role minimums (view: viewer, process and review: analyst, finalize: approver, never the submitter); the GxP and residency forbids apply on top.",
      enabled: true,
      createdAt,
      cedar: `permit(
  principal,
  action in [${DOCINTEL_ACTIONS.map((a) => `Action::"${a}"`).join(", ")}],
  resource == Tool::"${DOCINTEL_TOOL}"
);`,
    },
    {
      id: "pol-gw-ragfactory",
      name: "Gateway: tenant members may use the RAG Factory",
      layer: "gateway",
      description:
        "Perimeter for RAG corpora built from finalized documents. The platform already enforces the role minimums (view and query: viewer, create / edit / submit / build: analyst, approve: approver, never the submitter); the GxP and residency forbids apply on top.",
      enabled: true,
      createdAt,
      cedar: `permit(
  principal,
  action in [${RAG_FACTORY_ACTIONS.map((a) => `Action::"${a}"`).join(", ")}],
  resource == Tool::"${RAG_FACTORY_TOOL}"
);`,
    },
    {
      id: "pol-gw-gxp-training",
      name: "Gateway: GxP data requires GxP training",
      layer: "gateway",
      description:
        "In a GxP-regulated tenant (resource.gxp, inherited down the tenant tree) only GxP-trained personas may run agents, query graphs/knowledge bases/memory, build knowledge graphs, call peer agents or approve review gates.",
      enabled: true,
      createdAt,
      cedar: `forbid(
  principal,
  action in [${actionList}],
  resource
) when { resource.gxp == "true" } unless { principal.gxpTrained == "true" };`,
    },
    {
      id: "pol-gw-data-residency",
      name: "Gateway: region-bound data stays with people in that region",
      layer: "gateway",
      description:
        "In a tenant whose data is bound to a region (resource.region, inherited), only personas in that region — or with GLOBAL scope — may act on it.",
      enabled: true,
      createdAt,
      cedar: `forbid(
  principal,
  action in [${actionList}],
  resource
) when { resource.regionBound == "true" } unless { principal.region == resource.region || principal.region == "GLOBAL" };`,
    },
  ];
}

/**
 * Add missing regulatory policies to a store's policy list, and widen the two
 * seeded forbids when a new regulated action is added — but only while their
 * text is still the seeded text for an older action list (an operator's edit
 * is never overwritten). Idempotent.
 */
export function upgradeRegulatoryPolicies(policies: Policy[], createdAt: string): string[] {
  const changes: string[] = [];
  for (const p of regulatoryPolicies(createdAt)) {
    const existing = policies.find((x) => x.id === p.id);
    if (!existing) {
      policies.push(p);
      changes.push(`added ${p.id}`);
    } else if (
      ["pol-gw-gxp-training", "pol-gw-data-residency", "pol-gw-docintel", "pol-gw-ragfactory"].includes(p.id) &&
      existing.cedar !== p.cedar &&
      isOlderSeed(existing.cedar, p.cedar)
    ) {
      existing.cedar = p.cedar;
      changes.push(`widened ${p.id}`);
    }
  }
  return changes;
}

/** Same policy, shorter action list: the seeded text before an action was added. */
function isOlderSeed(current: string, latest: string): boolean {
  const strip = (c: string) => c.replace(/action in \[[^\]]*\]/, "action in [...]");
  const actions = (c: string) => [...c.matchAll(/Action::"([^"]+)"/g)].map((m) => m[1]);
  return strip(current) === strip(latest) &&
    actions(current).every((a) => actions(latest).includes(a));
}
