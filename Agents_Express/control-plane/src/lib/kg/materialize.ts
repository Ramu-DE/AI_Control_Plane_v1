// Knowledge-graph materialisation — the platform's ONLY write path to Neo4j.
//
// Deliberately separate from lib/graph/neo4j.ts `runReadQuery`, which stays
// read-only by construction (READ access mode + write-clause guard). Nothing
// here relaxes that: this module opens its own WRITE session and is governed
// independently.
//
// Invariants:
//   1. Cedar action `buildKnowledgeGraph` must permit the caller (two stages,
//      same shape as runAgent / queryKnowledgeBase).
//   2. Only APPROVED + PUBLISHED mappings are materialised. An unapproved
//      proposal can never reach the graph.
//   3. Writes are MERGE-only and parameterised — no deletes, no raw SQL/Cypher
//      from a model, no string interpolation of values.
//   4. Every node carries `source:"kg-build"` + the build id, so a
//      materialisation is identifiable and removable.
//   5. Every run is audited with counts.

import neo4j from "neo4j-driver";
import type { Driver } from "neo4j-driver";
import { evaluate } from "../evaluator";
import { logAudit, store } from "../store";
import { validateBoltUri, resolveNeo4jPassword } from "../graph/neo4j";
import type { Neo4jBackend } from "../graph/entities";
import type { Policy } from "../types";
import { ucQuery } from "../tools/uc";
import type { DerivedOntology } from "./derive";

export class KgConfigError extends Error {
  readonly code = "KG_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "KgConfigError";
  }
}

export class KgDeniedError extends Error {
  readonly code = "KG_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "KgDeniedError";
  }
}

// --------------------------------------------------------------------------- //
// Cedar: action `buildKnowledgeGraph`
// --------------------------------------------------------------------------- //

export const KG_BUILD_ACTION = "buildKnowledgeGraph";
export const KG_PERIMETER_TOOL = "kg";

export function kgScopedTool(graphSourceId: string): string {
  return `${KG_PERIMETER_TOOL}:${graphSourceId}`;
}

export function kgScopedPolicyExists(policies: Policy[], graphSourceId: string): boolean {
  const needle = `Tool::"${kgScopedTool(graphSourceId)}"`;
  return policies.some((p) => p.enabled && p.layer === "gateway" && p.cedar.includes(needle));
}

export interface KgAuthorization {
  allowed: boolean;
  perimeter: { allowed: boolean; reason: string; matchedPolicyId?: string };
  scoped:
    | { evaluated: true; allowed: boolean; reason: string; matchedPolicyId?: string }
    | { evaluated: false; reason: string };
}

/** Two-stage Cedar check before ANY write. */
export function authorizeBuild(graphSourceId: string, personaId: string): KgAuthorization {
  const base = evaluate({
    personaId,
    agentId: "kg-builder",
    action: KG_BUILD_ACTION,
    tool: KG_PERIMETER_TOOL,
    resource: graphSourceId,
  });
  const pd = base.decisions[0];
  const perimeter = {
    allowed: base.allowed,
    reason: pd?.reason ?? "no decision recorded",
    ...(pd?.matchedPolicyId ? { matchedPolicyId: pd.matchedPolicyId } : {}),
  };
  if (!perimeter.allowed) {
    return {
      allowed: false,
      perimeter,
      scoped: { evaluated: false, reason: "not evaluated — the KG-build perimeter denied the call" },
    };
  }
  if (!kgScopedPolicyExists(store.policies, graphSourceId)) {
    return {
      allowed: true,
      perimeter,
      scoped: {
        evaluated: false,
        reason: `no policy names Tool::"${kgScopedTool(graphSourceId)}" — perimeter decision stands`,
      },
    };
  }
  const sc = evaluate({
    personaId,
    agentId: "kg-builder",
    action: KG_BUILD_ACTION,
    tool: kgScopedTool(graphSourceId),
    resource: graphSourceId,
  });
  const sd = sc.decisions[0];
  return {
    allowed: sc.allowed,
    perimeter,
    scoped: {
      evaluated: true,
      allowed: sc.allowed,
      reason: sd?.reason ?? "no decision recorded",
      ...(sd?.matchedPolicyId ? { matchedPolicyId: sd.matchedPolicyId } : {}),
    },
  };
}

// --------------------------------------------------------------------------- //
// Materialisation
// --------------------------------------------------------------------------- //

/** Neo4j labels/relationship types cannot be parameterised, so validate them. */
const SAFE_IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
function safeIdent(value: string, what: string): string {
  if (!SAFE_IDENT.test(value)) {
    throw new KgConfigError(`unsafe ${what} '${value}' — must match ${SAFE_IDENT}`);
  }
  return value;
}

export const MAX_INSTANCE_ROWS = 200;

export interface MaterializeInput {
  graphSourceId: string;
  personaId: string;
  backend: Neo4jBackend;
  allowedHosts?: string[];
  ontology: DerivedOntology;
  /** Classes approved for materialisation (labels). Others are skipped. */
  approvedClassLabels: string[];
  /** Relationship labels approved for materialisation. */
  approvedRelationshipLabels: string[];
  /** Pull instance rows from Unity Catalog as well as the schema layer. */
  includeInstances?: boolean;
  buildId: string;
}

export interface MaterializeResult {
  buildId: string;
  authorization: KgAuthorization;
  classNodes: number;
  propertyNodes: number;
  relationshipEdges: number;
  instanceNodes: number;
  instanceEdges: number;
  skipped: string[];
  notes: string[];
  latencyMs: number;
}

function makeDriver(backend: Neo4jBackend, password: string): Driver {
  return neo4j.driver(backend.uri, neo4j.auth.basic(backend.username, password), {
    maxConnectionPoolSize: 10,
    connectionAcquisitionTimeout: 10_000,
    connectionTimeout: 10_000,
    disableLosslessIntegers: true,
  });
}

/**
 * Build the knowledge graph in Neo4j from an approved ontology.
 *
 * Two layers are written:
 *   SCHEMA    (:OntologyClass)-[:HAS_PROPERTY]->(:OntologyProperty)
 *             (:OntologyClass)-[:RELATES_TO]->(:OntologyClass)
 *   INSTANCES (:Instance:<ClassLabel>)-[:INSTANCE_OF]->(:OntologyClass)
 *             (:Instance)-[:<relLabel>]->(:Instance)
 *
 * The schema layer is what makes the graph *explainable* in the UI; the
 * instance layer is what makes it real data.
 */
export async function materializeKnowledgeGraph(
  input: MaterializeInput
): Promise<MaterializeResult> {
  const started = Date.now();
  const notes: string[] = [];
  const skipped: string[] = [];

  const authorization = authorizeBuild(input.graphSourceId, input.personaId);
  const actor = store.personas.find((p) => p.id === input.personaId)?.name ?? input.personaId;
  if (!authorization.allowed) {
    logAudit({
      category: "graph",
      action: "deny-kg-build",
      actor,
      detail: `DENY knowledge-graph build for '${input.graphSourceId}' — ${
        authorization.scoped.evaluated && !authorization.scoped.allowed
          ? authorization.scoped.reason
          : authorization.perimeter.reason
      }`,
    });
    throw new KgDeniedError("knowledge-graph build denied by policy");
  }

  const policy = validateBoltUri(input.backend.uri, input.allowedHosts);
  if (!policy.ok) {
    throw new KgConfigError(
      policy.placeholder
        ? "Bolt URI is a placeholder — configure the real instance before building"
        : `Bolt URI rejected: ${policy.reason}`
    );
  }
  const password = resolveNeo4jPassword(input.backend);
  if (!password) throw new KgConfigError("Neo4j password is not configured");

  const approvedClasses = input.ontology.classes.filter((c) =>
    input.approvedClassLabels.includes(c.label)
  );
  if (approvedClasses.length === 0) {
    throw new KgConfigError(
      "no approved classes to materialise — approve mapping proposals first"
    );
  }
  for (const c of input.ontology.classes) {
    if (!input.approvedClassLabels.includes(c.label)) {
      skipped.push(`class ${c.label} (not approved)`);
    }
  }

  let classNodes = 0;
  let propertyNodes = 0;
  let relationshipEdges = 0;
  let instanceNodes = 0;
  let instanceEdges = 0;

  const driver = makeDriver(input.backend, password);
  try {
    const session = driver.session({
      database: input.backend.database,
      defaultAccessMode: neo4j.session.WRITE, // the ONLY write session in the app
    });
    try {
      // ---- schema layer: classes + their properties ----
      for (const cls of approvedClasses) {
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (c:OntologyClass {uri: $uri})
             SET c.label = $label, c.table = $table, c.comment = $comment,
                 c.subjectColumns = $subjectColumns,
                 c.source = 'kg-build', c.buildId = $buildId`,
            {
              uri: cls.uri,
              label: cls.label,
              table: cls.table,
              comment: cls.comment ?? null,
              subjectColumns: cls.subjectColumns,
              buildId: input.buildId,
            }
          )
        );
        classNodes += 1;

        for (const col of cls.columns) {
          await session.executeWrite((tx) =>
            tx.run(
              `MERGE (p:OntologyProperty {uri: $uri})
                 SET p.label = $label, p.column = $column, p.datatype = $datatype,
                     p.source = 'kg-build', p.buildId = $buildId
               WITH p
               MATCH (c:OntologyClass {uri: $classUri})
               MERGE (c)-[r:HAS_PROPERTY]->(p)
                 SET r.source = 'kg-build', r.buildId = $buildId`,
              {
                uri: `${cls.uri}/${col.name}`,
                label: col.name,
                column: col.name,
                datatype: col.datatype,
                classUri: cls.uri,
                buildId: input.buildId,
              }
            )
          );
          propertyNodes += 1;
        }
      }

      // ---- schema layer: relationships between classes ----
      const approvedRels = input.ontology.relationships.filter((r) =>
        input.approvedRelationshipLabels.includes(r.label)
      );
      for (const rel of input.ontology.relationships) {
        if (!input.approvedRelationshipLabels.includes(rel.label)) {
          skipped.push(`relationship ${rel.label} (not approved)`);
        }
      }
      for (const rel of approvedRels) {
        const from = approvedClasses.find((c) => c.table === rel.fromTable);
        const to = approvedClasses.find((c) => c.table === rel.toTable);
        if (!from || !to) {
          skipped.push(`relationship ${rel.label} (endpoint class not approved)`);
          continue;
        }
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (a:OntologyClass {uri: $fromUri}), (b:OntologyClass {uri: $toUri})
             MERGE (a)-[r:RELATES_TO {predicate: $label}]->(b)
               SET r.fromColumn = $fromColumn, r.toColumn = $toColumn,
                   r.source = 'kg-build', r.buildId = $buildId`,
            {
              fromUri: from.uri,
              toUri: to.uri,
              label: rel.label,
              fromColumn: rel.fromColumn,
              toColumn: rel.toColumn,
              buildId: input.buildId,
            }
          )
        );
        relationshipEdges += 1;
      }

      // ---- instance layer: real rows from Unity Catalog ----
      if (input.includeInstances) {
        for (const cls of approvedClasses) {
          if (cls.subjectColumns.length === 0) {
            skipped.push(`instances of ${cls.label} (no subject key)`);
            continue;
          }
          const label = safeIdent(cls.label, "class label");
          const keyCol = cls.subjectColumns[0];
          const cols = cls.columns.map((c) => c.name);
          let rows: unknown[][] = [];
          try {
            // Read-only, row-capped, through the same guarded UC tool.
            const res = await ucQuery(
              `SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM ${cls.table} LIMIT ${MAX_INSTANCE_ROWS}`
            );
            rows = res.rows;
          } catch (e) {
            notes.push(`could not read rows for ${cls.label}: ${(e as Error).message}`);
            continue;
          }
          const keyIdx = cols.indexOf(keyCol);
          for (const row of rows) {
            const props: Record<string, unknown> = {};
            cols.forEach((c, i) => {
              props[c] = row[i] ?? null;
            });
            const iri = `${cls.uri}/${String(row[keyIdx])}`;
            await session.executeWrite((tx) =>
              tx.run(
                `MERGE (i:Instance:\`${label}\` {iri: $iri})
                   SET i += $props, i.source = 'kg-build', i.buildId = $buildId,
                       i.displayKey = $displayKey
                 WITH i
                 MATCH (c:OntologyClass {uri: $classUri})
                 MERGE (i)-[r:INSTANCE_OF]->(c)
                   SET r.source = 'kg-build', r.buildId = $buildId`,
                {
                  iri,
                  props,
                  classUri: cls.uri,
                  displayKey: String(row[keyIdx]),
                  buildId: input.buildId,
                }
              )
            );
            instanceNodes += 1;
          }
        }

        // instance-to-instance edges, following approved relationships
        for (const rel of approvedRels) {
          const from = approvedClasses.find((c) => c.table === rel.fromTable);
          const to = approvedClasses.find((c) => c.table === rel.toTable);
          if (!from || !to) continue;
          const relType = safeIdent(rel.label, "relationship type");
          const res = await session.executeWrite((tx) =>
            tx.run(
              `MATCH (a:Instance {source:'kg-build', buildId:$buildId})-[:INSTANCE_OF]->(:OntologyClass {uri:$fromUri})
               MATCH (b:Instance {source:'kg-build', buildId:$buildId})-[:INSTANCE_OF]->(:OntologyClass {uri:$toUri})
               WHERE a[$fromColumn] IS NOT NULL AND a[$fromColumn] = b[$toColumn]
               MERGE (a)-[r:\`${relType}\`]->(b)
                 SET r.source = 'kg-build', r.buildId = $buildId
               RETURN count(r) AS n`,
              {
                buildId: input.buildId,
                fromUri: from.uri,
                toUri: to.uri,
                fromColumn: rel.fromColumn,
                toColumn: rel.toColumn,
              }
            )
          );
          instanceEdges += Number(res.records[0]?.get("n") ?? 0);
        }
      }
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }

  const latencyMs = Date.now() - started;
  logAudit({
    category: "graph",
    action: "kg-build",
    actor,
    detail:
      `Materialised knowledge graph for '${input.graphSourceId}' (build ${input.buildId}): ` +
      `${classNodes} class(es), ${propertyNodes} property node(s), ${relationshipEdges} schema edge(s), ` +
      `${instanceNodes} instance(s), ${instanceEdges} instance edge(s)`,
  });

  return {
    buildId: input.buildId,
    authorization,
    classNodes,
    propertyNodes,
    relationshipEdges,
    instanceNodes,
    instanceEdges,
    skipped,
    notes,
    latencyMs,
  };
}

/** Remove everything a given build wrote. The only delete in the app. */
export async function dropBuild(
  backend: Neo4jBackend,
  buildId: string,
  allowedHosts?: string[]
): Promise<number> {
  const policy = validateBoltUri(backend.uri, allowedHosts);
  if (!policy.ok) throw new KgConfigError(`Bolt URI rejected: ${policy.reason}`);
  const password = resolveNeo4jPassword(backend);
  if (!password) throw new KgConfigError("Neo4j password is not configured");
  const driver = makeDriver(backend, password);
  try {
    const session = driver.session({
      database: backend.database,
      defaultAccessMode: neo4j.session.WRITE,
    });
    try {
      const res = await session.executeWrite((tx) =>
        tx.run(
          `MATCH (n {source:'kg-build', buildId:$buildId})
           WITH n, count(n) AS _c
           DETACH DELETE n
           RETURN count(*) AS removed`,
          { buildId }
        )
      );
      return Number(res.records[0]?.get("removed") ?? 0);
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}
