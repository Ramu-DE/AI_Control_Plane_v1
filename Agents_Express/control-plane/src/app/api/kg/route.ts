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
  authorizeBuild,
  dropBuild,
  kgScopedPolicyExists,
  kgScopedTool,
  materializeKnowledgeGraph,
} from "@/lib/kg/materialize";
import { MAX_DEPTH, readKnowledgeGraph, readNeighborhood } from "@/lib/kg/read";
import type { GraphSource, KgSpec, Neo4jBackend } from "@/lib/graph/entities";
import { evaluate } from "@/lib/evaluator";
import { personaTenantDecision } from "@/lib/personas";
import { describeKgSpec, validateKgSpec } from "@/lib/kg/spec";
import { latestBuild, readSourceGraph, readSourceNeighborhood } from "@/lib/kg/sourceRead";
import { KgJobError, jobLog, startOntologyBuild } from "@/lib/kg/jobs";
import { setGraphSourceKgSpec } from "@/lib/graph/service";

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

/** Resolve an Approved graph source (any backend) for KG operations. */
async function resolveSource(graphSourceId: string): Promise<GraphSource> {
  const ctl = await controlStore();
  const source = await ctl.getGraphSource(graphSourceId);
  if (!source) throw new KgConfigError(`graph source '${graphSourceId}' not found`);
  if (source.status !== "Approved") {
    throw new KgConfigError(`graph source '${graphSourceId}' is ${source.status}, not Approved`);
  }
  return source;
}

const tenantOf = (s: GraphSource) => s.tenantId ?? s.bu;

/**
 * Reading a source's graph is a `queryGraphSource` in its tenant: membership,
 * the viewer minimum, and the GxP / residency policies all apply — exploring
 * BioMedical needs the same clearance as querying it.
 */
function authorizeRead(source: GraphSource, personaId: string | null): NextResponse | null {
  if (!personaId) {
    return NextResponse.json(
      { error: "personaId is required: exploring a graph is a governed read", code: "PERSONA_REQUIRED" },
      { status: 400 });
  }
  const d = evaluate({
    personaId, agentId: "kg-explorer", action: "queryGraphSource", tool: "omda",
    resource: source.graphSourceId, tenantId: tenantOf(source),
  });
  if (d.allowed) return null;
  return NextResponse.json(
    { error: d.decisions[d.decisions.length - 1]?.reason ?? "denied", code: "KG_READ_DENIED" },
    { status: 403 });
}

/** What the page needs to know about a source to offer the right actions. */
function sourceSummary(s: GraphSource) {
  const spec = s.kgSpec;
  return {
    graphSourceId: s.graphSourceId,
    displayName: s.displayName,
    backend: s.backend.type,
    status: s.status,
    tenantId: tenantOf(s),
    kgSpec: spec ?? null,
    specSummary: describeKgSpec(spec),
    canBuild: !!spec && spec.mode !== "native" &&
      (spec.mode === "ontology-first" || s.backend.type === "neo4j"),
    canExplore: !!spec && s.backend.type === "neo4j",
  };
}

async function readForSource(source: GraphSource, opts: { buildId?: string; includeInstances: boolean }) {
  const spec = source.kgSpec;
  if (!spec) throw new KgConfigError(`'${source.graphSourceId}' has no build spec; set one first`);
  if (source.backend.type !== "neo4j") {
    throw new KgConfigError(
      `'${source.graphSourceId}' is a ${source.backend.type} source; explore it with SPARQL on the Graph Sources page`);
  }
  const backend = source.backend as Neo4jBackend;
  if (spec.mode === "native") {
    return { mode: spec.mode, ...(await readSourceGraph(backend, { kind: "native", labels: spec.labels })) };
  }
  if (spec.mode === "ontology-first") {
    const latest = await latestBuild(backend, source.graphSourceId);
    if (!latest) {
      return { mode: spec.mode, latestBuild: null, nodes: [], edges: [],
        counts: { classes: 0, properties: 0, instances: 0, edges: 0 }, buildIds: [],
        truncation: { limit: 0, nodesReturned: 0, nodesTotal: 0, edgesReturned: 0, edgesTotal: 0,
          edgesOmitted: 0, complete: true } };
    }
    const graph = await readSourceGraph(backend, {
      kind: "ontology-first", graphSourceId: source.graphSourceId, buildId: latest.buildId });
    return { mode: spec.mode, latestBuild: latest, ...graph, buildIds: [latest.buildId] };
  }
  return {
    mode: spec.mode,
    ...(await readKnowledgeGraph(backend, {
      buildId: opts.buildId, includeInstances: opts.includeInstances, graphSourceId: source.graphSourceId })),
  };
}

export async function GET(req: NextRequest) {
  const graphSourceId = req.nextUrl.searchParams.get("graphSourceId");
  const buildId = req.nextUrl.searchParams.get("buildId") ?? undefined;
  const includeInstances = req.nextUrl.searchParams.get("instances") !== "0";
  const personaId = req.nextUrl.searchParams.get("personaId");

  if (!graphSourceId) {
    const ctl = await controlStore();
    const statuses = ["Approved", "Draft", "Pending approval"] as const;
    const seen = new Map<string, ReturnType<typeof sourceSummary>>();
    for (const status of statuses) {
      for (const s of await ctl.listGraphSources({ status })) seen.set(s.graphSourceId, sourceSummary(s));
    }
    return NextResponse.json({
      sources: [...seen.values()],
      personas: store.personas.filter((p) => !p.disabled).map(({ id, name, groups, memberships }) => ({
        id, name, groups, memberships: memberships ?? [] })),
      policy: {
        action: KG_BUILD_ACTION,
        perimeterTool: KG_PERIMETER_TOOL,
        scopedToolExample: kgScopedTool("<graphSourceId>"),
      },
    });
  }

  try {
    const source = await resolveSource(graphSourceId);
    if (req.nextUrl.searchParams.get("runs") === "1") {
      const runs = (await (await controlStore()).listBuildRuns({ graphSourceId }))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 10)
        .map((r) => ({ ...r, log: jobLog(r.buildRunId) }));
      return NextResponse.json({ graphSourceId, runs });
    }
    const denied = authorizeRead(source, personaId);
    if (denied) return denied;
    const graph = await readForSource(source, { buildId, includeInstances });
    return NextResponse.json({ graphSourceId, source: sourceSummary(source), ...graph });
  } catch (e) {
    return errorResponse(e);
  }
}

type DeriveBody = { op: "derive"; graphSourceId?: string; catalog?: string; schema?: string; tableFilter?: string; stripPrefix?: string };
type BuildBody = {
  op: "build";
  graphSourceId: string;
  personaId: string;
  stripPrefix?: string;
  approvedClassLabels?: string[];
  approvedRelationshipLabels?: string[];
  includeInstances?: boolean;
};
type DropBody = { op: "drop"; graphSourceId: string; buildId: string; personaId?: string };
type NeighborsBody = { op: "neighbors"; graphSourceId: string; nodeId: string; depth?: number; limit?: number; buildId?: string; personaId?: string };
type SpecBody = { op: "set-spec"; graphSourceId: string; kgSpec: KgSpec; personaId?: string };
type Body = DeriveBody | BuildBody | DropBody | NeighborsBody | SpecBody;

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.op === "set-spec") {
      // Where a source's graph comes from decides what gets written into its
      // database, so only an ADMIN of the source's tenant may set it.
      const ctl = await controlStore();
      const source = await ctl.getGraphSource(body.graphSourceId);
      if (!source) return NextResponse.json({ error: "graph source not found" }, { status: 404 });
      const persona = store.personas.find((p) => p.id === body.personaId && !p.disabled);
      if (!persona) {
        return NextResponse.json({ error: "personaId is required to set a build spec", code: "ACTOR_REQUIRED" }, { status: 400 });
      }
      const member = personaTenantDecision(persona, tenantOf(source), store.tenants);
      if (!member.allowed || member.role !== "admin") {
        const why = member.allowed
          ? `${persona.name} is ${member.role} in '${member.via}'; setting a build spec needs admin`
          : member.reason;
        return NextResponse.json({ error: why, code: "ACTOR_NOT_PERMITTED" }, { status: 403 });
      }
      const err = validateKgSpec(body.kgSpec, source);
      if (err) return NextResponse.json({ error: err, code: "BAD_SPEC" }, { status: 400 });
      const updated = await setGraphSourceKgSpec(source.graphSourceId, body.kgSpec);
      logAudit({ category: "graph", action: "kg-set-spec", actor: persona.name, tenantId: tenantOf(source),
        detail: `Build spec of '${source.graphSourceId}' set: ${describeKgSpec(body.kgSpec)}` });
      return NextResponse.json(sourceSummary(updated));
    }

    if (body.op === "derive") {
      // Preview what a DERIVED build would produce. The UC location is the
      // source's spec when a source is given, never free text over it.
      let catalog = body.catalog || "workspace";
      let schema = body.schema || "default";
      let tableFilter = body.tableFilter;
      if (body.graphSourceId) {
        const source = await resolveSource(body.graphSourceId);
        const spec = source.kgSpec;
        if (spec?.mode !== "derived") {
          return NextResponse.json(
            { error: `'${source.graphSourceId}' is not a derived source (${describeKgSpec(spec)})`, code: "NOT_DERIVED" },
            { status: 409 });
        }
        ({ catalog, schema } = spec);
        tableFilter = spec.tableFilter;
      }
      const listed = await ucListTables(catalog, schema);
      const ontology = deriveOntology(listed.tables, { tableFilter, stripPrefix: body.stripPrefix });
      const proposals = deriveProposals(ontology);
      logAudit({
        category: "graph", action: "kg-derive", actor: "console-user",
        detail: `Derived ontology from ${catalog}.${schema}: ${ontology.classes.length} class(es), ` +
          `${ontology.relationships.length} relationship(s), ${proposals.length} proposal(s)`,
      });
      return NextResponse.json({
        catalog, schema, ontology, proposals,
        summary: {
          tablesSeen: listed.tableCount,
          classes: ontology.classes.length,
          relationships: ontology.relationships.length,
          proposals: proposals.length,
          blocked: proposals.filter((p) =>
            p.issues.some((i) => i.severity === "blocking" || i.severity === "error")).length,
        },
      });
    }

    if (body.op === "build") {
      if (!body.graphSourceId || !body.personaId) {
        return NextResponse.json({ error: "graphSourceId and personaId are required" }, { status: 400 });
      }
      const source = await resolveSource(body.graphSourceId);
      const spec = source.kgSpec;
      if (!spec) {
        return NextResponse.json(
          { error: `'${source.graphSourceId}' has no build spec. Set where its graph comes from first.`, code: "NO_SPEC" },
          { status: 409 });
      }
      if (spec.mode === "native") {
        return NextResponse.json(
          { error: `'${source.graphSourceId}' is a native graph: its data is loaded by its own pipeline, so the platform does not build it. Explore it instead.`, code: "NATIVE_SOURCE" },
          { status: 409 });
      }
      const persona = store.personas.find((p) => p.id === body.personaId);
      const auth = authorizeBuild(source.graphSourceId, body.personaId, tenantOf(source));
      if (!auth.allowed || !persona) {
        logAudit({ category: "graph", action: "kg-build-denied", actor: persona?.name ?? body.personaId,
          tenantId: tenantOf(source), detail: `DENY build of '${source.graphSourceId}': ${auth.perimeter.reason}` });
        return NextResponse.json(
          { error: `Cedar denied buildKnowledgeGraph: ${auth.scoped.evaluated ? auth.scoped.reason : auth.perimeter.reason}`,
            code: "KG_DENIED", authorization: auth },
          { status: 403 });
      }

      if (spec.mode === "ontology-first") {
        // A GxP publication is signed by a human approver.
        if (spec.approvalProfile === "gxp-strict") {
          const m = personaTenantDecision(persona, tenantOf(source), store.tenants);
          if (!m.allowed || (m.role !== "approver" && m.role !== "admin")) {
            return NextResponse.json(
              { error: `profile gxp-strict publishes under a named approver; ${persona.name} is ${m.role ?? "not a member"} here`, code: "PUBLISHER_NOT_PERMITTED" },
              { status: 403 });
          }
        }
        try {
          const run = await startOntologyBuild(source, spec, persona);
          return NextResponse.json({ graphSourceId: source.graphSourceId, mode: spec.mode, run }, { status: 202 });
        } catch (e) {
          if (e instanceof KgJobError) {
            return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
          }
          throw e;
        }
      }

      // Derived (legacy): the UC location comes from the spec.
      if (source.backend.type !== "neo4j") {
        return NextResponse.json({ error: "derived builds write to Neo4j sources only" }, { status: 409 });
      }
      const backend = source.backend as Neo4jBackend;
      const listed = await ucListTables(spec.catalog, spec.schema);
      const ontology = deriveOntology(listed.tables, { tableFilter: spec.tableFilter, stripPrefix: body.stripPrefix });
      const proposals = deriveProposals(ontology);
      const blockedClassLabels = new Set(
        proposals
          .filter((p) => p.proposalKind === "class" &&
            p.issues.some((i) => i.severity === "blocking" || i.severity === "error"))
          .map((p) => p.ontologyLabel));
      const approvedClassLabels = body.approvedClassLabels ??
        ontology.classes.map((c) => c.label).filter((l) => !blockedClassLabels.has(l));
      const approvedRelationshipLabels = body.approvedRelationshipLabels ?? ontology.relationships.map((r) => r.label);
      const buildId = `kgb-${Math.random().toString(36).slice(2, 10)}`;
      const result = await materializeKnowledgeGraph({
        graphSourceId: source.graphSourceId,
        personaId: body.personaId,
        tenantId: tenantOf(source),
        backend,
        allowedHosts: source.allowedHosts,
        ontology,
        approvedClassLabels,
        approvedRelationshipLabels,
        includeInstances: body.includeInstances ?? true,
        buildId,
      });
      return NextResponse.json({ graphSourceId: source.graphSourceId, mode: spec.mode, ontology, ...result });
    }

    if (body.op === "neighbors") {
      if (!body.graphSourceId || !body.nodeId) {
        return NextResponse.json({ error: "graphSourceId and nodeId are required" }, { status: 400 });
      }
      const source = await resolveSource(body.graphSourceId);
      const denied = authorizeRead(source, body.personaId ?? null);
      if (denied) return denied;
      const spec = source.kgSpec;
      if (!spec || source.backend.type !== "neo4j") {
        return NextResponse.json({ error: describeKgSpec(spec), code: "NOT_EXPLORABLE" }, { status: 409 });
      }
      const backend = source.backend as Neo4jBackend;
      try {
        if (spec.mode === "native") {
          const graph = await readSourceNeighborhood(backend, { kind: "native", labels: spec.labels }, body.nodeId, body.depth ?? 1);
          return NextResponse.json({ graphSourceId: body.graphSourceId, ...graph });
        }
        if (spec.mode === "ontology-first") {
          const latest = await latestBuild(backend, source.graphSourceId);
          if (!latest) return NextResponse.json({ error: "no build loaded yet" }, { status: 404 });
          const graph = await readSourceNeighborhood(backend,
            { kind: "ontology-first", graphSourceId: source.graphSourceId, buildId: latest.buildId },
            body.nodeId, body.depth ?? 1);
          return NextResponse.json({ graphSourceId: body.graphSourceId, ...graph });
        }
        const graph = await readNeighborhood(backend, {
          nodeId: body.nodeId, depth: body.depth, limit: body.limit, buildId: body.buildId,
          graphSourceId: source.graphSourceId,
        });
        return NextResponse.json({ graphSourceId: body.graphSourceId, ...graph });
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message, code: "KG_TRAVERSAL", maxDepth: MAX_DEPTH }, { status: 400 });
      }
    }

    if (body.op === "drop") {
      if (!body.graphSourceId || !body.buildId) {
        return NextResponse.json({ error: "graphSourceId and buildId are required" }, { status: 400 });
      }
      const source = await resolveSource(body.graphSourceId);
      if (source.backend.type !== "neo4j") {
        return NextResponse.json({ error: "drop applies to Neo4j derived builds" }, { status: 409 });
      }
      const persona = store.personas.find((p) => p.id === body.personaId);
      const auth = body.personaId ? authorizeBuild(source.graphSourceId, body.personaId, tenantOf(source)) : null;
      if (!persona || !auth?.allowed) {
        return NextResponse.json(
          { error: "dropping a build is a governed write: personaId with buildKnowledgeGraph in the source's tenant is required", code: "KG_DENIED" },
          { status: 403 });
      }
      const removed = await dropBuild(source.backend as Neo4jBackend, body.buildId, source.allowedHosts, source.graphSourceId);
      logAudit({
        category: "graph", action: "kg-drop", actor: persona.name, tenantId: tenantOf(source),
        detail: `Dropped knowledge-graph build ${body.buildId} from '${source.graphSourceId}' (${removed} node(s))`,
      });
      return NextResponse.json({ buildId: body.buildId, removed });
    }

    return NextResponse.json({ error: "unknown operation" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
