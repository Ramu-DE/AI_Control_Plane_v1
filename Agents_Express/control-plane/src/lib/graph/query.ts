// Governed graph query for AGENTS — the one path a model-issued Cypher takes.
//
// The HTTP route (`app/api/graph/route.ts`) answers a console user. An agent
// tool needs the same checks plus two the route never made, because a route
// caller is a human at a screen and a tool caller is a model acting for one:
//
//   1. TENANT VISIBILITY. The source must be visible to the caller's tenant —
//      its own, or an ancestor's. A sibling BU's graph is refused before Cedar
//      is consulted, using the same rule as tools and models
//      (`resourceAvailableToTenant`).
//   2. CEDAR AS THE AGENT. `queryGraphSource` is evaluated with the bound
//      agent's id and tenant, not the generic "graph-router" the route uses, so
//      a policy can scope graph access per agent or per tenant.
//
// Everything else is shared with the route: Approved status, Bolt allowlist,
// the read-only Cypher guard, a row cap, and an audit entry for every outcome.

import { evaluate } from "../evaluator";
import { logAudit, store } from "../store";
import { resourceAvailableToTenant } from "../tenancy";
import { controlStore } from "./service";
import { buildCypher } from "./cypher";
import { isConfiguredBoltUri, isNeo4jError, runReadQuery } from "./neo4j";
import { planSparql, runSparql, UnsafeSparqlError } from "./sparql";
import { validateOutboundUrl } from "./logic";
import type { GraphSource, Neo4jBackend, NeptuneBackend } from "./entities";

/** Who is asking. Every field is required: a tool call with no principal is refused. */
export interface GraphCaller {
  personaId: string;
  tenantId: string;
  agentId: string;
  /** "workflow" | "a2a-inbound" | ... — for the audit trail. */
  origin: string;
}

export type GraphQueryErrorCode =
  | "NO_CALLER"
  | "NOT_FOUND"
  | "NOT_APPROVED"
  | "TENANT_DENIED"
  | "POLICY_DENIED"
  | "UNSUPPORTED_BACKEND"
  | "NOT_CONFIGURED"
  | "UNSAFE_CYPHER"
  | "UNSAFE_QUERY"
  | "QUERY_FAILED";

export class GraphQueryError extends Error {
  readonly code: GraphQueryErrorCode;
  constructor(code: GraphQueryErrorCode, message: string) {
    super(message);
    this.name = "GraphQueryError";
    this.code = code;
  }
}

export const MAX_TOOL_ROWS = 100;

export interface GraphQueryResult {
  graphSourceId: string;
  language: "cypher" | "sparql";
  /** The query as executed — for SPARQL, after scoping to the source's graphs. */
  query: string;
  planSource: string;
  rowCount: number;
  /** True when the row cap was reached, so the model knows it saw a prefix. */
  truncated: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  /** ASK queries only. */
  boolean?: boolean;
}

/** Injected so the checks are testable offline. Defaults hit the real store / Bolt / Neptune. */
export interface GraphQueryDeps {
  getSource?: (id: string) => Promise<GraphSource | null>;
  runQuery?: typeof runReadQuery;
  runSparql?: typeof runSparql;
}

function actorName(personaId: string): string {
  return store.personas.find((p) => p.id === personaId)?.name ?? personaId;
}

function audit(caller: GraphCaller, action: string, detail: string): void {
  logAudit({
    category: "graph",
    action,
    actor: actorName(caller.personaId),
    tenantId: caller.tenantId,
    detail: `${detail} (agent ${caller.agentId}, ${caller.origin})`,
  });
}

/**
 * Resolve, authorize and run one read-only query against a Neo4j (Cypher) or
 * Neptune (SPARQL) Graph Source. Throws GraphQueryError with a stable code on
 * every refusal.
 */
export async function queryGraphAsAgent(
  input: {
    graphSourceId: string;
    cypher?: string;
    sparql?: string;
    question?: string;
    limit?: number;
  },
  caller: GraphCaller | undefined,
  deps: GraphQueryDeps = {}
): Promise<GraphQueryResult> {
  if (!caller || !caller.personaId || !caller.tenantId || !caller.agentId) {
    throw new GraphQueryError(
      "NO_CALLER",
      "graph queries from a tool need a persona, tenant and agent; none was supplied"
    );
  }
  const graphSourceId = input.graphSourceId.trim();
  const getSource =
    deps.getSource ?? (async (id: string) => (await controlStore()).getGraphSource(id));
  const source = await getSource(graphSourceId);
  if (!source) {
    throw new GraphQueryError("NOT_FOUND", `graph source '${graphSourceId}' not found`);
  }
  if (source.status !== "Approved") {
    throw new GraphQueryError(
      "NOT_APPROVED",
      `graph source '${graphSourceId}' is ${source.status}, not Approved`
    );
  }

  const owner = source.tenantId ?? source.bu;
  const visibility = resourceAvailableToTenant(owner, caller.tenantId, store.tenants);
  if (!visibility.allowed) {
    audit(caller, "deny-query", `DENY tool query to '${graphSourceId}': ${visibility.reason}`);
    throw new GraphQueryError(
      "TENANT_DENIED",
      `graph source '${graphSourceId}' is not available to tenant '${caller.tenantId}': ${visibility.reason}`
    );
  }

  const decision = evaluate({
    personaId: caller.personaId,
    agentId: caller.agentId,
    action: "queryGraphSource",
    tool: "omda",
    resource: graphSourceId,
    tenantId: caller.tenantId,
  });
  if (!decision.allowed) {
    audit(caller, "deny-query", `DENY tool query to '${graphSourceId}' by policy`);
    throw new GraphQueryError(
      "POLICY_DENIED",
      `Cedar denied queryGraphSource on '${graphSourceId}' for this agent and persona`
    );
  }

  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), MAX_TOOL_ROWS);

  if (source.backend.type === "neptune") {
    return sparqlAsAgent(source, source.backend as NeptuneBackend, input, caller, limit, deps);
  }
  if (source.backend.type !== "neo4j") {
    throw new GraphQueryError(
      "UNSUPPORTED_BACKEND",
      `graph tools support Neo4j and Neptune sources; '${graphSourceId}' is ${source.backend.type}`
    );
  }
  if (input.sparql && !input.cypher) {
    throw new GraphQueryError(
      "UNSUPPORTED_BACKEND",
      `'${graphSourceId}' is a Neo4j source: use graph_query with Cypher, not SPARQL`
    );
  }
  const backend = source.backend as Neo4jBackend;
  if (!isConfiguredBoltUri(backend.uri, source.allowedHosts)) {
    throw new GraphQueryError(
      "NOT_CONFIGURED",
      `graph source '${graphSourceId}' has a placeholder or non-allowlisted Bolt URI`
    );
  }

  let plan;
  try {
    plan = buildCypher(input.question?.trim() || "graph inventory", limit, input.cypher);
  } catch (e) {
    audit(caller, "deny-query", `REFUSED unsafe Cypher for '${graphSourceId}'`);
    throw new GraphQueryError("UNSAFE_CYPHER", (e as Error).message);
  }

  const run = deps.runQuery ?? runReadQuery;
  try {
    const result = await run(backend, plan.cypher, plan.params, { limit, timeoutMs: 25_000 });
    audit(caller, "query", `ALLOW tool query to '${graphSourceId}' (${result.rowCount} rows)`);
    return {
      graphSourceId,
      language: "cypher",
      query: plan.cypher,
      planSource: plan.source,
      rowCount: result.rowCount,
      truncated: result.rowCount >= limit,
      columns: result.columns,
      rows: result.rows,
    };
  } catch (error) {
    const message = isNeo4jError(error)
      ? `Neo4j error [${(error as { code?: string }).code ?? "unknown"}]: ${(error as Error).message}`
      : (error as Error).message || "Neo4j query failed";
    audit(caller, "query-error", `tool query failed for '${graphSourceId}': ${message}`);
    throw new GraphQueryError("QUERY_FAILED", message);
  }
}

/** The Neptune branch: SPARQL, scoped to the source's own named graphs. */
async function sparqlAsAgent(
  source: GraphSource,
  backend: NeptuneBackend,
  input: { cypher?: string; sparql?: string },
  caller: GraphCaller,
  limit: number,
  deps: GraphQueryDeps
): Promise<GraphQueryResult> {
  const id = source.graphSourceId;
  if (!input.sparql) {
    throw new GraphQueryError(
      "UNSUPPORTED_BACKEND",
      `'${id}' is a Neptune (RDF) source: use graph_sparql with a SPARQL SELECT/ASK, not Cypher`
    );
  }
  if (!validateOutboundUrl(backend.endpoint, source.allowedHosts).ok || !source.allowedHosts?.length) {
    throw new GraphQueryError(
      "NOT_CONFIGURED",
      `graph source '${id}' has a placeholder or non-allowlisted Neptune endpoint`
    );
  }
  let plan;
  try {
    plan = planSparql(input.sparql, backend.namedGraphs ?? [], limit);
  } catch (e) {
    if (e instanceof UnsafeSparqlError) {
      audit(caller, "deny-query", `REFUSED unsafe SPARQL for '${id}': ${e.message}`);
      throw new GraphQueryError("UNSAFE_QUERY", e.message);
    }
    throw e;
  }
  const run = deps.runSparql ?? runSparql;
  try {
    const result = await run(backend, plan, { limit, timeoutMs: 25_000 });
    audit(caller, "query", `ALLOW tool SPARQL to '${id}' (${result.rowCount} rows)`);
    return {
      graphSourceId: id,
      language: "sparql",
      query: plan.query,
      planSource: "explicit",
      rowCount: result.rowCount,
      truncated: result.rowCount >= limit,
      columns: result.columns,
      rows: result.rows,
      ...(result.boolean !== undefined ? { boolean: result.boolean } : {}),
    };
  } catch (error) {
    const message = (error as Error).message || "Neptune query failed";
    audit(caller, "query-error", `tool SPARQL failed for '${id}': ${message}`);
    throw new GraphQueryError("QUERY_FAILED", message);
  }
}
