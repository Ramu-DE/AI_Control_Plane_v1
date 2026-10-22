// Which agents may a workflow bind? ONE definition, shared by both sides.
//
// This exists because the UI and the server disagreed. The server allows an
// agent owned by the workflow's tenant OR by an ancestor of it; the create-
// workflow modal filtered on exact tenant equality. The result was a dropdown
// that silently hid agents the server would have accepted, and — when the
// modal's default tenant did not match where the agents lived — an empty list
// with no explanation at all.
//
// Keeping the rule in one pure module means the two cannot drift again.
// `resolve.ts` imports server-only code, so the rule could not live there and
// also be used by a client component; this file imports nothing but types.
//
// Client- and server-safe.

/** The minimum a tenant must expose for the rule to be evaluable. */
export interface TenantNode {
  id: string;
  parentId?: string | null;
}

/** Walk the tenant tree upward from `from`, looking for `ancestor`. */
export function isAncestorTenant(
  ancestor: string,
  from: string,
  tenants: TenantNode[]
): boolean {
  let cursor = tenants.find((t) => t.id === from);
  const seen = new Set<string>();
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    seen.add(cursor.parentId);
    if (cursor.parentId === ancestor) return true;
    cursor = tenants.find((t) => t.id === cursor!.parentId);
  }
  return false;
}

/**
 * May a workflow in `workflowTenantId` bind an agent owned by `agentTenantId`?
 *
 * Yes when they are the same tenant, or when the agent's tenant is an ANCESTOR
 * of the workflow's. The direction matters and is easy to get backwards: a
 * shared agent owned high in the org tree can be used by a division beneath it,
 * but a division's own agent is not available to the parent or to a sibling.
 */
export function agentEligibleForWorkflow(
  agentTenantId: string,
  workflowTenantId: string,
  tenants: TenantNode[]
): boolean {
  if (!agentTenantId || !workflowTenantId) return false;
  if (agentTenantId === workflowTenantId) return true;
  return isAncestorTenant(agentTenantId, workflowTenantId, tenants);
}

/**
 * Explain an empty agent list, naming where the agents actually are.
 *
 * An empty dropdown with no reason is the defect that prompted this: the agents
 * existed, were `ready`, and were simply owned by a tenant the selected one
 * cannot reach. Returns null when there is nothing to explain.
 */
export function explainNoEligibleAgents(
  agents: { name: string; tenantId: string }[],
  workflowTenantId: string,
  tenants: TenantNode[]
): string | null {
  const eligible = agents.filter((a) =>
    agentEligibleForWorkflow(a.tenantId, workflowTenantId, tenants)
  );
  if (eligible.length > 0) return null;

  if (agents.length === 0) {
    return (
      "No agents are available. An agent must exist and be `ready` before a " +
      "workflow step can bind to it."
    );
  }

  const elsewhere = [...new Set(agents.map((a) => a.tenantId))]
    .filter((t) => t !== workflowTenantId)
    .slice(0, 4);
  return (
    `No agent is available to a workflow in '${workflowTenantId}'. ` +
    `${agents.length} ready agent(s) exist, owned by ${elsewhere.join(", ")}. ` +
    `A workflow can use an agent from its OWN tenant or an ancestor of it — ` +
    `not from a child or a sibling. Either select one of those tenants above, ` +
    `or create the agent under '${workflowTenantId}'.`
  );
}
