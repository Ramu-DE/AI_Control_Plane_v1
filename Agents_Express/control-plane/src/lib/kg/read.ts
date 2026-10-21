// Read the materialised knowledge graph back for visualisation.
//
// Uses the EXISTING read-only path (`runReadQuery`), so nothing here can
// mutate the graph. The shape returned is deliberately view-oriented: a flat
// node/edge list the React page can lay out without further processing.

import { runReadQuery } from "../graph/neo4j";
import type { Neo4jBackend } from "../graph/entities";

export type KgNodeKind = "class" | "property" | "instance";

export interface KgNode {
  id: string;
  label: string;
  kind: KgNodeKind;
  /** Owning class label for instances/properties — used for colour grouping. */
  group?: string;
  /** A few non-identifying properties, for the detail panel. */
  properties?: Record<string, unknown>;
}

export interface KgEdge {
  source: string;
  target: string;
  /** HAS_PROPERTY | RELATES_TO | INSTANCE_OF | <relationship label> */
  type: string;
}

export interface KgGraph {
  nodes: KgNode[];
  edges: KgEdge[];
  counts: { classes: number; properties: number; instances: number; edges: number };
  buildIds: string[];
}

const MAX_NODES = 400;

/**
 * Load the KG for a build (or every kg-build node when `buildId` is omitted).
 *
 * Two queries rather than one big one: the schema layer is always wanted, the
 * instance layer is optional and much larger.
 */
export async function readKnowledgeGraph(
  backend: Neo4jBackend,
  opts: { buildId?: string; includeInstances?: boolean; limit?: number } = {}
): Promise<KgGraph> {
  const limit = Math.min(Math.max(opts.limit ?? MAX_NODES, 10), MAX_NODES);
  const nodes = new Map<string, KgNode>();
  const edges: KgEdge[] = [];
  const buildIds = new Set<string>();

  const buildFilter = opts.buildId ? " AND n.buildId = $buildId" : "";
  const params = opts.buildId ? { buildId: opts.buildId, limit } : { limit };

  // ---- schema layer: classes, their properties, and class-to-class edges ----
  const schema = await runReadQuery(
    backend,
    `MATCH (n:OntologyClass) WHERE n.source = 'kg-build'${buildFilter}
     OPTIONAL MATCH (n)-[:HAS_PROPERTY]->(p:OntologyProperty)
     OPTIONAL MATCH (n)-[r:RELATES_TO]->(m:OntologyClass)
     RETURN n.uri AS classUri, n.label AS classLabel, n.table AS table,
            n.buildId AS buildId,
            collect(DISTINCT {uri: p.uri, label: p.label, datatype: p.datatype}) AS props,
            collect(DISTINCT {uri: m.uri, predicate: r.predicate}) AS rels
     LIMIT $limit`,
    params,
    { limit }
  );

  for (const row of schema.rows) {
    const classUri = String(row.classUri ?? "");
    if (!classUri) continue;
    const classLabel = String(row.classLabel ?? classUri);
    if (row.buildId) buildIds.add(String(row.buildId));
    nodes.set(classUri, {
      id: classUri,
      label: classLabel,
      kind: "class",
      group: classLabel,
      properties: { table: row.table ?? null },
    });
    for (const p of (row.props as Record<string, unknown>[]) ?? []) {
      const uri = p?.uri ? String(p.uri) : "";
      if (!uri) continue;
      nodes.set(uri, {
        id: uri,
        label: String(p.label ?? uri),
        kind: "property",
        group: classLabel,
        properties: { datatype: p.datatype ?? null },
      });
      edges.push({ source: classUri, target: uri, type: "HAS_PROPERTY" });
    }
    for (const r of (row.rels as Record<string, unknown>[]) ?? []) {
      const uri = r?.uri ? String(r.uri) : "";
      if (!uri) continue;
      edges.push({ source: classUri, target: uri, type: String(r.predicate ?? "RELATES_TO") });
    }
  }

  // ---- instance layer ----
  if (opts.includeInstances) {
    const inst = await runReadQuery(
      backend,
      `MATCH (i:Instance)-[:INSTANCE_OF]->(c:OntologyClass)
       WHERE i.source = 'kg-build'${opts.buildId ? " AND i.buildId = $buildId" : ""}
       OPTIONAL MATCH (i)-[r]->(j:Instance) WHERE type(r) <> 'INSTANCE_OF'
       RETURN i.iri AS iri, i.displayKey AS displayKey, c.label AS classLabel,
              c.uri AS classUri,
              collect(DISTINCT {iri: j.iri, type: type(r)}) AS links
       LIMIT $limit`,
      params,
      { limit }
    );
    for (const row of inst.rows) {
      const iri = String(row.iri ?? "");
      if (!iri) continue;
      const classLabel = String(row.classLabel ?? "Instance");
      nodes.set(iri, {
        id: iri,
        label: String(row.displayKey ?? iri.split("/").pop() ?? iri),
        kind: "instance",
        group: classLabel,
      });
      if (row.classUri) {
        edges.push({ source: iri, target: String(row.classUri), type: "INSTANCE_OF" });
      }
      for (const l of (row.links as Record<string, unknown>[]) ?? []) {
        if (!l?.iri) continue;
        edges.push({ source: iri, target: String(l.iri), type: String(l.type ?? "LINK") });
      }
    }
  }

  // Drop edges whose endpoints were not loaded, so the view never dangles.
  const present = new Set(nodes.keys());
  const kept = edges.filter((e) => present.has(e.source) && present.has(e.target));

  const list = [...nodes.values()];
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
  };
}
