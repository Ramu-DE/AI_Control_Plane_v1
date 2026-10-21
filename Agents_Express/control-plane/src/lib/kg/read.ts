// Read the materialised knowledge graph back for visualisation and traversal.
//
// Uses the EXISTING read-only path (`runReadQuery`), so nothing here can mutate
// the graph.
//
// PRECISION IS THE POINT OF THIS MODULE. A graph view that quietly omits nodes
// or edges is worse than no view, because it looks authoritative. So:
//
//   - every response reports `truncation`: how many nodes/edges exist in the
//     store versus how many were returned, and whether the view is complete;
//   - every node carries its TRUE `degree` (counted in the database, not in the
//     returned subgraph), so a node with hidden neighbours is visibly marked
//     and can be expanded;
//   - edges with an endpoint outside the returned set are counted in
//     `truncation.edgesOmitted` rather than silently dropped;
//   - results are deterministically ordered, so the same query gives the same
//     picture every time.

import { runReadQuery } from "../graph/neo4j";
import type { Neo4jBackend } from "../graph/entities";

export type KgNodeKind = "class" | "property" | "instance";

export interface KgNode {
  id: string;
  label: string;
  kind: KgNodeKind;
  /** Owning class label for instances/properties — used for colour grouping. */
  group?: string;
  /** TRUE relationship count in the database (not just within this view). */
  degree?: number;
  /** A few non-identifying properties, for the detail panel. */
  properties?: Record<string, unknown>;
}

export interface KgEdge {
  source: string;
  target: string;
  /** HAS_PROPERTY | RELATES_TO | INSTANCE_OF | <relationship label> */
  type: string;
}

export interface KgTruncation {
  /** Node cap that was applied. */
  limit: number;
  nodesReturned: number;
  /** Total kg-build nodes in the store (counted, not estimated). */
  nodesTotal: number;
  edgesReturned: number;
  /** Total relationships between kg-build nodes in the store. */
  edgesTotal: number;
  /** Edges skipped because an endpoint fell outside the returned set. */
  edgesOmitted: number;
  /** True only when the view shows everything. */
  complete: boolean;
}

export interface KgGraph {
  nodes: KgNode[];
  edges: KgEdge[];
  counts: { classes: number; properties: number; instances: number; edges: number };
  buildIds: string[];
  truncation: KgTruncation;
  /** Present on a traversal result: the node the neighbourhood was expanded from. */
  origin?: string;
}

const MAX_NODES = 400;
export const MAX_DEPTH = 3;

/** Count the whole kg-build subgraph so "showing N of M" is truthful. */
async function countAll(
  backend: Neo4jBackend,
  buildId?: string
): Promise<{ nodes: number; edges: number }> {
  const filter = buildId ? " AND n.buildId = $buildId" : "";
  const params = buildId ? { buildId } : {};
  const n = await runReadQuery(
    backend,
    `MATCH (n) WHERE n.source = 'kg-build'${filter} RETURN count(n) AS c`,
    params,
    { limit: 1 }
  );
  const e = await runReadQuery(
    backend,
    `MATCH (a)-[r]->(b) WHERE a.source = 'kg-build' AND b.source = 'kg-build'` +
      (buildId ? " AND a.buildId = $buildId AND b.buildId = $buildId" : "") +
      ` RETURN count(r) AS c`,
    params,
    { limit: 1 }
  );
  return {
    nodes: Number(n.rows[0]?.c ?? 0),
    edges: Number(e.rows[0]?.c ?? 0),
  };
}

/** Assemble the final graph, reporting exactly what was and was not included. */
function finalize(
  nodes: Map<string, KgNode>,
  edges: KgEdge[],
  totals: { nodes: number; edges: number },
  limit: number,
  buildIds: Set<string>,
  origin?: string
): KgGraph {
  const present = new Set(nodes.keys());
  const kept: KgEdge[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  for (const e of edges) {
    if (!present.has(e.source) || !present.has(e.target)) {
      omitted += 1;
      continue;
    }
    // De-duplicate: the same edge can arrive from both endpoints' rows.
    const key = `${e.source}|${e.type}|${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(e);
  }

  const list = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    nodes: list,
    edges: kept,
    counts: {
      classes: list.filter((n) => n.kind === "class").length,
      properties: list.filter((n) => n.kind === "property").length,
      instances: list.filter((n) => n.kind === "instance").length,
      edges: kept.length,
    },
    buildIds: [...buildIds],
    truncation: {
      limit,
      nodesReturned: list.length,
      nodesTotal: totals.nodes,
      edgesReturned: kept.length,
      edgesTotal: totals.edges,
      edgesOmitted: omitted,
      complete: list.length >= totals.nodes && omitted === 0,
    },
    ...(origin ? { origin } : {}),
  };
}

/** Shared row → node/edge accumulation for the schema layer. */
function absorbNodeRow(
  row: Record<string, unknown>,
  nodes: Map<string, KgNode>,
  edges: KgEdge[],
  buildIds: Set<string>
): void {
  const id = String(row.id ?? "");
  if (!id) return;
  const kindRaw = String(row.kind ?? "");
  const kind: KgNodeKind =
    kindRaw === "OntologyClass" ? "class" : kindRaw === "OntologyProperty" ? "property" : "instance";
  if (row.buildId) buildIds.add(String(row.buildId));
  nodes.set(id, {
    id,
    label: String(row.label ?? id),
    kind,
    group: row.group ? String(row.group) : undefined,
    degree: row.degree === undefined || row.degree === null ? undefined : Number(row.degree),
    properties: {
      ...(row.table ? { table: row.table } : {}),
      ...(row.datatype ? { datatype: row.datatype } : {}),
      ...(row.buildId ? { buildId: row.buildId } : {}),
    },
  });
  for (const nb of (row.links as Record<string, unknown>[]) ?? []) {
    if (!nb || !nb.id) continue;
    const other = String(nb.id);
    const type = String(nb.type ?? "LINK");
    if (nb.out === false) edges.push({ source: other, target: id, type });
    else edges.push({ source: id, target: other, type });
  }
}

/**
 * One Cypher shape used by both the full read and the traversal, so the two
 * cannot disagree about what a node looks like.
 *
 * `degree` is counted with an unbounded pattern — it is the node's real degree
 * in the store, which is what lets the UI mark hidden neighbours.
 */
const NODE_PROJECTION = `
  WITH DISTINCT n
  OPTIONAL MATCH (n)-[rel]-(nb) WHERE nb.source = 'kg-build'
  WITH n, count(DISTINCT rel) AS degree,
       collect(DISTINCT CASE WHEN nb IS NULL THEN NULL ELSE {
         id: coalesce(nb.uri, nb.iri),
         type: type(rel),
         out: startNode(rel) = n
       } END) AS rawLinks
  RETURN coalesce(n.uri, n.iri) AS id,
         coalesce(n.label, n.displayKey) AS label,
         labels(n)[0] AS kind,
         n.table AS table,
         n.datatype AS datatype,
         n.buildId AS buildId,
         coalesce(n.classLabel, n.label) AS group,
         degree,
         [l IN rawLinks WHERE l IS NOT NULL AND l.id IS NOT NULL] AS links
  ORDER BY id`;

/**
 * Load the whole kg-build graph (capped), with honest truncation reporting.
 */
export async function readKnowledgeGraph(
  backend: Neo4jBackend,
  opts: { buildId?: string; includeInstances?: boolean; limit?: number } = {}
): Promise<KgGraph> {
  const limit = Math.min(Math.max(opts.limit ?? MAX_NODES, 10), MAX_NODES);
  const nodes = new Map<string, KgNode>();
  const edges: KgEdge[] = [];
  const buildIds = new Set<string>();

  const totals = await countAll(backend, opts.buildId);

  const labelFilter = opts.includeInstances
    ? "n:OntologyClass OR n:OntologyProperty OR n:Instance"
    : "n:OntologyClass OR n:OntologyProperty";
  const buildFilter = opts.buildId ? " AND n.buildId = $buildId" : "";
  const params = opts.buildId ? { buildId: opts.buildId, limit } : { limit };

  const res = await runReadQuery(
    backend,
    `MATCH (n) WHERE n.source = 'kg-build' AND (${labelFilter})${buildFilter}
     WITH n ORDER BY labels(n)[0], coalesce(n.uri, n.iri) LIMIT $limit
     ${NODE_PROJECTION}`,
    params,
    { limit }
  );
  for (const row of res.rows) absorbNodeRow(row, nodes, edges, buildIds);

  return finalize(nodes, edges, totals, limit, buildIds);
}

/**
 * TRAVERSAL: expand the neighbourhood of one node to a bounded depth.
 *
 * Depth cannot be parameterised in Cypher (a path bound must be a literal), so
 * it is validated against MAX_DEPTH and interpolated as a plain integer — never
 * caller text. The origin node id IS parameterised.
 */
export async function readNeighborhood(
  backend: Neo4jBackend,
  opts: { nodeId: string; depth?: number; limit?: number; buildId?: string }
): Promise<KgGraph> {
  const nodeId = (opts.nodeId || "").trim();
  if (!nodeId) throw new Error("nodeId is required to traverse");

  const rawDepth = Number(opts.depth ?? 1);
  if (!Number.isInteger(rawDepth) || rawDepth < 1 || rawDepth > MAX_DEPTH) {
    throw new Error(`depth must be an integer between 1 and ${MAX_DEPTH}`);
  }
  const depth = rawDepth; // validated integer, safe to interpolate
  const limit = Math.min(Math.max(opts.limit ?? 120, 10), MAX_NODES);

  const nodes = new Map<string, KgNode>();
  const edges: KgEdge[] = [];
  const buildIds = new Set<string>();
  const totals = await countAll(backend, opts.buildId);

  const res = await runReadQuery(
    backend,
    `MATCH (origin) WHERE origin.source = 'kg-build' AND coalesce(origin.uri, origin.iri) = $nodeId
     CALL {
       WITH origin
       MATCH path = (origin)-[*1..${depth}]-(reached)
       WHERE reached.source = 'kg-build'
       RETURN reached AS n
       UNION
       WITH origin RETURN origin AS n
     }
     WITH n ORDER BY labels(n)[0], coalesce(n.uri, n.iri) LIMIT $limit
     ${NODE_PROJECTION}`,
    { nodeId, limit },
    { limit }
  );

  if (res.rows.length === 0) {
    throw new Error(`node '${nodeId}' not found in this knowledge graph`);
  }
  for (const row of res.rows) absorbNodeRow(row, nodes, edges, buildIds);

  return finalize(nodes, edges, totals, limit, buildIds, nodeId);
}
