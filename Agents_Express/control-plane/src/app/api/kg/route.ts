// Knowledge-graph API: derive → propose → build → read.
//
//   GET  ?graphSourceId=…&buildId=…&instances=1   -> the graph, for the UI
//   POST { op: "derive" }    -> ontology + proposals from live Unity Catalog
//   POST { op: "build" }     -> Cedar-checked materialisation into Neo4j
//   POST { op: "drop" }      -> remove one build's nodes
//
// `derive` is read-only (UC metadata). `build` is the only write path in the
// platform and is governed by Cedar `buildKnowledgeGraph`; the query path used
// by `GET` remains read-only.

import { NextRequest, NextResponse } from "next/server";
import { logAudit, store } from "@/lib/store";
import { controlStore } from "@/lib/graph/service";
import { ucListTables } from "@/lib/tools/uc";
import { deriveOntology, deriveProposals } from "@/lib/kg/derive";
import {
  KG_BUILD_ACTION,
  KG_PERIMETER_TOOL,
  KgConfigError,
  KgDeniedError,
  dropBuild,
  kgScopedPolicyExists,
  kgScopedTool,
  materializeKnowledgeGraph,
} from "@/lib/kg/materialize";
import { readKnowledgeGraph } from "@/lib/kg/read";
import type { Neo4jBackend } from "@/lib/graph/entities";

export const runtime = "nodejs";
export const maxDuration = 120;

function errorResponse(e: unknown): NextResponse {
  if (e instanceof KgDeniedError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 403 });
  }
  if (e instanceof KgConfigError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
  }
  return NextResponse.json({ error: (e as Error).message }, { status: 500 });
}

/** Resolve an Approved neo4j-backed graph source to use as the KG target. */
async function resolveNeo4jSource(graphSourceId: string) {
  const ctl = await controlStore();
  const source = await ctl.getGraphSource(graphSourceId);
  if (!source) throw new KgConfigError(`graph source '${graphSourceId}' not found`);
  if (source.backend.type !== "neo4j") {
    throw new KgConfigError(
      `graph source '${graphSourceId}' has backend '${source.backend.type}'; the knowledge-graph ` +
        `builder targets a neo4j backend`
    );
  }
  if (source.status !== "Approved") {
    throw new KgConfigError(`graph source '${graphSourceId}' is ${source.status}, not Approved`);
  }
  return { source, backend: source.backend as Neo4jBackend };
}

export async function GET(req: NextRequest) {
  const graphSourceId = req.nextUrl.searchParams.get("graphSourceId");
  const buildId = req.nextUrl.searchParams.get("buildId") ?? undefined;
  const includeInstances = req.nextUrl.searchParams.get("instances") !== "0";

  if (!graphSourceId) {
    // Enough for the page to populate its pickers before anything is built.
    const ctl = await controlStore();
    const statuses = ["Approved", "Draft", "Pending approval"] as const;
    const seen = new Map<string, { graphSourceId: string; displayName: string; backend: string; status: string }>();
    for (const status of statuses) {
      for (const s of await ctl.listGraphSources({ status })) {
        seen.set(s.graphSourceId, {
          graphSourceId: s.graphSourceId,
          displayName: s.displayName,
          backend: s.backend.type,
          status: s.status,
        });
      }
    }
    return NextResponse.json({
      sources: [...seen.values()],
      personas: store.personas.map(({ id, name, groups }) => ({ id, name, groups })),
      policy: {
        action: KG_BUILD_ACTION,
        perimeterTool: KG_PERIMETER_TOOL,
        scopedToolExample: kgScopedTool("<graphSourceId>"),
      },
    });
  }

  try {
    const { backend } = await resolveNeo4jSource(graphSourceId);
    const graph = await readKnowledgeGraph(backend, { buildId, includeInstances });
    return NextResponse.json({ graphSourceId, ...graph });
  } catch (e) {
    return errorResponse(e);
  }
}

type DeriveBody = {
  op: "derive";
  catalog?: string;
  schema?: string;
  tableFilter?: string;
  stripPrefix?: string;
};
type BuildBody = {
  op: "build";
  graphSourceId: string;
  personaId: string;
  catalog?: string;
  schema?: string;
  tableFilter?: string;
  stripPrefix?: string;
  /** Class / relationship labels approved for materialisation. */
  approvedClassLabels?: string[];
  approvedRelationshipLabels?: string[];
  includeInstances?: boolean;
};
type DropBody = { op: "drop"; graphSourceId: string; buildId: string };
type Body = DeriveBody | BuildBody | DropBody;

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.op === "derive") {
      const catalog = body.catalog || "workspace";
      const schema = body.schema || "default";
      const listed = await ucListTables(catalog, schema);
      const ontology = deriveOntology(listed.tables, {
        tableFilter: body.tableFilter,
        stripPrefix: body.stripPrefix,
      });
      const proposals = deriveProposals(ontology);
      logAudit({
        category: "graph",
        action: "kg-derive",
        actor: "console-user",
        detail:
          `Derived ontology from ${catalog}.${schema}: ${ontology.classes.length} class(es), ` +
          `${ontology.relationships.length} relationship(s), ${proposals.length} proposal(s)`,
      });
      return NextResponse.json({
        catalog,
        schema,
        ontology,
        proposals,
        summary: {
          tablesSeen: listed.tableCount,
          classes: ontology.classes.length,
          relationships: ontology.relationships.length,
          proposals: proposals.length,
          blocked: proposals.filter((p) =>
            p.issues.some((i) => i.severity === "blocking" || i.severity === "error")
          ).length,
        },
      });
    }

    if (body.op === "build") {
      if (!body.graphSourceId || !body.personaId) {
        return NextResponse.json(
          { error: "graphSourceId and personaId are required" },
          { status: 400 }
        );
      }
      const { backend, source } = await resolveNeo4jSource(body.graphSourceId);
      const catalog = body.catalog || "workspace";
      const schema = body.schema || "default";
      const listed = await ucListTables(catalog, schema);
      const ontology = deriveOntology(listed.tables, {
        tableFilter: body.tableFilter,
        stripPrefix: body.stripPrefix,
      });

      // Default to every class/relationship that is NOT blocked, so a caller
      // can build without hand-listing — but a blocked proposal is never
      // materialised, and an explicit list always wins.
      const proposals = deriveProposals(ontology);
      const blockedClassLabels = new Set(
        proposals
          .filter(
            (p) =>
              p.proposalKind === "class" &&
              p.issues.some((i) => i.severity === "blocking" || i.severity === "error")
          )
          .map((p) => p.ontologyLabel)
      );
      const approvedClassLabels =
        body.approvedClassLabels ??
        ontology.classes.map((c) => c.label).filter((l) => !blockedClassLabels.has(l));
      const approvedRelationshipLabels =
        body.approvedRelationshipLabels ?? ontology.relationships.map((r) => r.label);

      const buildId = `kgb-${Math.random().toString(36).slice(2, 10)}`;
      const result = await materializeKnowledgeGraph({
        graphSourceId: body.graphSourceId,
        personaId: body.personaId,
        backend,
        allowedHosts: source.allowedHosts,
        ontology,
        approvedClassLabels,
        approvedRelationshipLabels,
        includeInstances: body.includeInstances ?? true,
        buildId,
      });
      return NextResponse.json({ graphSourceId: body.graphSourceId, ontology, ...result });
    }

    if (body.op === "drop") {
      if (!body.graphSourceId || !body.buildId) {
        return NextResponse.json(
          { error: "graphSourceId and buildId are required" },
          { status: 400 }
        );
      }
      const { backend, source } = await resolveNeo4jSource(body.graphSourceId);
      const removed = await dropBuild(backend, body.buildId, source.allowedHosts);
      logAudit({
        category: "graph",
        action: "kg-drop",
        actor: "console-user",
        detail: `Dropped knowledge-graph build ${body.buildId} (${removed} node(s))`,
      });
      return NextResponse.json({ buildId: body.buildId, removed });
    }

    return NextResponse.json({ error: "unknown operation" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
