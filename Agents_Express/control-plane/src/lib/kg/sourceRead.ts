// Explore ONE Graph Source's graph — never the whole database.
//
// The legacy reader showed every `kg-build` node in the database, so a source
// sharing an Aura instance with others displayed their builds too. These
// readers are scoped by the source's build spec:
//
//   native          nodes carrying one of the spec's labels (the data its own
//                   pipeline loaded, e.g. ClinicalTrial / Disease / Reaction)
//   ontology-first  the LATEST graph-utility build stamped kg_source = <id>
//                   (KGEntity nodes; neo4j_load.py writes the stamp)
//
// Both return the same KgGraph shape as lib/kg/read.ts, with the same honesty:
// true totals, true degrees within the scope, and truncation reported. Class
// nodes are synthesised from labels so the canvas can group instances.
//
// Read-only: everything goes through runReadQuery.

import { runReadQuery } from "../graph/neo4j";
import type { Neo4jBackend } from "../graph/entities";
import type { KgEdge, KgGraph, KgNode } from "./read";

const MAX_NODES = 300;
const MAX_DEPTH = 3;

export type SourceScope =
  | { kind: "native"; labels: string[] }
  | { kind: "ontology-first"; graphSourceId: string; buildId: string };

/** Cypher predicate + node id expression for a scope, over variable `v`. */
function scopeSql(scope: SourceScope, v: string): { where: string; id: string } {
  if (scope.kind === "native") {
    return { where: `any(l IN labels(${v}) WHERE l IN $labels)`, id: `elementId(${v})` };
  }
  return {
    where: `${v}:KGEntity AND ${v}.kg_source = $source AND ${v}.kg_build = $build`,
    id: `${v}.iri`,
  };
}

function scopeParams(scope: SourceScope): Record<string, unknown> {
  return scope.kind === "native"
    ? { labels: scope.labels }
    : { source: scope.graphSourceId, build: scope.buildId };
}

/** The latest graph-utility build loaded for a source, or null. */
export async function latestBuild(
  backend: Neo4jBackend,
  graphSourceId: string
): Promise<{ buildId: string; loadedAt: string; nodes: number; relationships: number; meta: Record<string, unknown> } | null> {
  const r = await runReadQuery(
    backend,
    "MATCH (b:KGBuild {kg_source: $source}) RETURN b.build_id AS id, b.loaded_at AS at, " +
      "b.nodes AS nodes, b.relationships AS rels, properties(b) AS meta ORDER BY b.loaded_at DESC LIMIT 1",
    { source: graphSourceId },
    { limit: 1 }
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    buildId: String(row.id),
    loadedAt: String(row.at ?? ""),
    nodes: Number(row.nodes ?? 0),
    relationships: Number(row.rels ?? 0),
    meta: (row.meta as Record<string, unknown>) ?? {},
  };
}

// A readable name for a node, chosen in TypeScript from its properties.
// (Computing it in Cypher with a dynamic-key comprehension was mangled by the
// production minifier, so the query stays simple and this does the choosing.)
const NAME_KEYS = ["name", "title", "term", "nct_id", "symbol", "report_id", "raw_text"];
export function displayName(props: Record<string, unknown>, fallback: string): string {
  for (const k of NAME_KEYS) if (typeof props[k] === "string" && props[k]) return String(props[k]);
  const named = Object.keys(props).sort().find((k) => /(name|title)$/i.test(k) && typeof props[k] === "string");
  if (named) return String(props[named]);
  const idKey = Object.keys(props).sort().find((k) => /_id$/i.test(k) && props[k] !== null && props[k] !== undefined);
  if (idKey) return String(props[idKey]);
  for (const k of ["entity_id", "iri"]) if (typeof props[k] === "string") return String(props[k]).split(/[/#]/).pop() || fallback;
  return fallback;
}

function projection(scope: SourceScope): string {
  const n = scopeSql(scope, "n");
  const nb = scopeSql(scope, "nb");
  const hidden = scope.kind === "native" ? "[]" : "['KGEntity']";
  return `
  WITH DISTINCT n
  OPTIONAL MATCH (n)-[rel]-(nb) WHERE ${nb.where}
  WITH n, count(DISTINCT rel) AS degree,
       collect(DISTINCT CASE WHEN nb IS NULL THEN NULL ELSE {
         id: ${nb.id}, type: type(rel), out: startNode(rel) = n } END) AS rawLinks
  RETURN ${n.id} AS id,
         properties(n) AS props,
         [l IN labels(n) WHERE NOT l IN ${hidden}] AS labels,
         degree,
         [l IN rawLinks WHERE l IS NOT NULL AND l.id IS NOT NULL] AS links
  ORDER BY id`;
}

function primaryLabel(labels: string[], scope: SourceScope): string {
  if (scope.kind === "native") return labels.find((l) => scope.labels.includes(l)) ?? labels[0] ?? "Node";
  return labels.find((l) => l !== "KGEntity") ?? "Entity";
}

function absorb(rows: Record<string, unknown>[], scope: SourceScope, nodes: Map<string, KgNode>, edges: KgEdge[]) {
  for (const row of rows) {
    const id = String(row.id ?? "");
    if (!id) continue;
    const labels = (row.labels as string[]) ?? [];
    const group = primaryLabel(labels, scope);
    nodes.set(id, {
      id,
      label: displayName((row.props as Record<string, unknown>) ?? {}, id).slice(0, 60),
      kind: "instance",
      group,
      degree: row.degree === null || row.degree === undefined ? undefined : Number(row.degree),
      properties: { labels: labels.join(", ") },
    });
    // Synthesised class node per label, so instances group visibly.
    const classId = `class:${group}`;
    if (!nodes.has(classId)) nodes.set(classId, { id: classId, label: group, kind: "class", group });
    edges.push({ source: id, target: classId, type: "INSTANCE_OF" });
    for (const l of (row.links as Record<string, unknown>[]) ?? []) {
      if (!l?.id) continue;
      const other = String(l.id);
      const type = String(l.type ?? "LINK");
      edges.push(l.out === false ? { source: other, target: id, type } : { source: id, target: other, type });
    }
  }
}

function finish(nodes: Map<string, KgNode>, edges: KgEdge[], totals: { nodes: number; edges: number }, origin?: string): KgGraph {
  const present = new Set(nodes.keys());
  const seen = new Set<string>();
  const kept: KgEdge[] = [];
  let omitted = 0;
  for (const e of edges) {
    if (!present.has(e.source) || !present.has(e.target)) { omitted++; continue; }
    const k = `${e.source}|${e.type}|${e.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(e);
  }
  const list = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const instances = list.filter((n) => n.kind === "instance").length;
  const dataEdges = kept.filter((e) => e.type !== "INSTANCE_OF").length;
  return {
    nodes: list,
    edges: kept,
    counts: { classes: list.filter((n) => n.kind === "class").length, properties: 0, instances, edges: kept.length },
    buildIds: [],
    truncation: {
      limit: MAX_NODES,
      nodesReturned: instances,
      nodesTotal: totals.nodes,
      edgesReturned: dataEdges,
      edgesTotal: totals.edges,
      edgesOmitted: omitted,
      complete: instances >= totals.nodes && omitted === 0,
    },
    ...(origin ? { origin } : {}),
  };
}

/** The whole scoped graph, capped, with true totals. */
export async function readSourceGraph(backend: Neo4jBackend, scope: SourceScope): Promise<KgGraph> {
  const n = scopeSql(scope, "n");
  const a = scopeSql(scope, "a");
  const b = scopeSql(scope, "b");
  const params = scopeParams(scope);
  const nodeTotal = await runReadQuery(backend, `MATCH (n) WHERE ${n.where} RETURN count(n) AS c`, params, { limit: 1 });
  const edgeTotal = await runReadQuery(
    backend, `MATCH (a)-[r]->(b) WHERE ${a.where} AND ${b.where} RETURN count(r) AS c`, params, { limit: 1 });
  const res = await runReadQuery(
    backend,
    `MATCH (n) WHERE ${n.where} WITH n ORDER BY ${n.id} LIMIT $limit ${projection(scope)}`,
    { ...params, limit: MAX_NODES },
    { limit: MAX_NODES }
  );
  const nodes = new Map<string, KgNode>();
  const edges: KgEdge[] = [];
  absorb(res.rows, scope, nodes, edges);
  return finish(nodes, edges, {
    nodes: Number(nodeTotal.rows[0]?.c ?? 0),
    edges: Number(edgeTotal.rows[0]?.c ?? 0),
  });
}

/** Expand a node's neighbourhood within the same scope. */
export async function readSourceNeighborhood(
  backend: Neo4jBackend,
  scope: SourceScope,
  nodeId: string,
  depth = 1
): Promise<KgGraph> {
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw new Error(`depth must be an integer between 1 and ${MAX_DEPTH}`);
  }
  if (nodeId.startsWith("class:")) {
    // A synthesised class: its instances in scope.
    const label = nodeId.slice("class:".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) throw new Error("bad class id");
    const n = scopeSql(scope, "n");
    const res = await runReadQuery(
      backend,
      `MATCH (n:\`${label}\`) WHERE ${n.where} WITH n ORDER BY ${n.id} LIMIT $limit ${projection(scope)}`,
      { ...scopeParams(scope), limit: MAX_NODES }, { limit: MAX_NODES });
    const nodes = new Map<string, KgNode>();
    const edges: KgEdge[] = [];
    absorb(res.rows, scope, nodes, edges);
    return finish(nodes, edges, { nodes: nodes.size, edges: edges.length }, nodeId);
  }
  const o = scopeSql(scope, "o");
  const m = scopeSql(scope, "m");
  const res = await runReadQuery(
    backend,
    `MATCH (o) WHERE ${o.where} AND ${o.id} = $nodeId
     MATCH p = (o)-[*0..${depth}]-(m) WHERE ${m.where}
     WITH DISTINCT m AS n ORDER BY ${scopeSql(scope, "n").id} LIMIT $limit ${projection(scope)}`,
    { ...scopeParams(scope), nodeId, limit: MAX_NODES },
    { limit: MAX_NODES }
  );
  const nodes = new Map<string, KgNode>();
  const edges: KgEdge[] = [];
  absorb(res.rows, scope, nodes, edges);
  return finish(nodes, edges, { nodes: nodes.size, edges: edges.length }, nodeId);
}
