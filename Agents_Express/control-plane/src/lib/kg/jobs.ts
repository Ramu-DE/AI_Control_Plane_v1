// Run graph-utility's ontology-first build for ONE Graph Source, from the
// control plane, as a tracked background job.
//
// Everything the build needs comes from the SOURCE, not from the request:
// its ontology, dataset and approval profile (kgSpec), its tenant, and its own
// database (the Neo4j backend's URI/user/password, or the Neptune endpoint).
// The request contributes only who is asking — and that persona must already
// have passed Cedar `buildKnowledgeGraph` in the source's tenant.
//
// Safety:
//   - spawn() with an argument LIST, never a shell string;
//   - the ontology is a path under graph-utility/ontologies/, validated by the
//     spec and re-checked here after resolution;
//   - one running build per source;
//   - a hard timeout.
//
// Tracking: a BuildRun in the graph-control store (pending → running →
// succeeded | failed), plus the last lines of output in memory for the UI.

import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { controlStore, startBuildRun, updateGraphSourceBackend } from "../graph/service";
import { resolveNeo4jPassword } from "../graph/neo4j";
import { logAudit } from "../store";
import type { BuildRun, GraphSource, KgSpec, Neo4jBackend, NeptuneBackend } from "../graph/entities";

const TIMEOUT_MS = 15 * 60 * 1000;
const LOG_LINES = 80;

const g = globalThis as unknown as { __kgJobLogs?: Map<string, string[]> };
const logs: Map<string, string[]> = (g.__kgJobLogs ??= new Map());

export function jobLog(buildRunId: string): string[] {
  return logs.get(buildRunId) ?? [];
}

export function graphUtilityDir(): string {
  return process.env.GRAPH_UTILITY_DIR || path.resolve(process.cwd(), "../../graph-utility");
}

export class KgJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type OntologySpec = Extract<KgSpec, { mode: "ontology-first" }>;

/** Build the argument list and environment for one source. Pure apart from env reads. */
export function buildCommand(
  source: GraphSource,
  spec: OntologySpec,
  publisher: string
): { python: string; args: string[]; env: NodeJS.ProcessEnv; target: "neo4j" | "neptune" } {
  const dir = graphUtilityDir();
  const ontologyPath = path.resolve(dir, "ontologies", spec.ontology);
  if (!ontologyPath.startsWith(path.resolve(dir, "ontologies") + path.sep)) {
    throw new KgJobError("BAD_ONTOLOGY", "ontology path escapes graph-utility/ontologies");
  }
  if (!existsSync(ontologyPath)) {
    throw new KgJobError("BAD_ONTOLOGY", `ontology file not found: ontologies/${spec.ontology}`);
  }
  const tenant = source.tenantId ?? source.bu;
  const args = [
    "-I", "integration/build_graph_live.py",
    "--ontology", path.relative(dir, ontologyPath),
    "--namespace", spec.namespace,
    "--profile-keys", "--profile-joins", "--reason",
    "--tenant", tenant,
    "--approval-profile", spec.approvalProfile,
    "--graph-source-id", source.graphSourceId,
  ];
  if (spec.approvalProfile === "gxp-strict") args.push("--publisher", publisher);
  if (spec.dataset.kind === "uc") {
    args.push("--catalog", spec.dataset.catalog, "--schema", spec.dataset.schema);
    if (spec.dataset.tableFilter) args.push("--table-filter", spec.dataset.tableFilter);
  } else {
    args.push("--csv-dir", spec.dataset.dir);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  let target: "neo4j" | "neptune";
  if (source.backend.type === "neo4j") {
    const b = source.backend as Neo4jBackend;
    const password = resolveNeo4jPassword(b);
    if (!password) throw new KgJobError("NOT_CONFIGURED", "this source's Neo4j password is not configured");
    // The build writes into THIS source's database, whatever the platform default is.
    Object.assign(env, { NEO4J_URI: b.uri, NEO4J_USERNAME: b.username, NEO4J_DATABASE: b.database,
      NEO4J_PASSWORD: password });
    args.push("--neo4j");
    target = "neo4j";
  } else if (source.backend.type === "neptune") {
    const b = source.backend as NeptuneBackend;
    const url = new URL(b.endpoint);
    if (!env.NEPTUNE_S3_BUCKET || !env.NEPTUNE_LOADER_ROLE_ARN) {
      throw new KgJobError("NOT_CONFIGURED",
        "NEPTUNE_S3_BUCKET and NEPTUNE_LOADER_ROLE_ARN must be set in the control plane's environment");
    }
    Object.assign(env, { NEPTUNE_ENDPOINT: url.hostname, NEPTUNE_PORT: url.port || "8182" });
    args.push("--neptune");
    target = "neptune";
  } else {
    throw new KgJobError("UNSUPPORTED_BACKEND", `cannot build into a ${source.backend.type} source`);
  }
  return { python: path.join(dir, ".venv", "bin", "python"), args, env, target };
}

/** Parse the facts the UI and BuildRun need from the build's output. */
export function parseBuildOutput(lines: string[]): {
  buildGraph?: string; instances?: number; literals?: number; edges?: number; auto?: string;
} {
  const text = lines.join("\n");
  const graph = /<(urn:kg:build:kgb-[a-z0-9]+)>/.exec(text)?.[1];
  const inst = /instances\s*:\s*(\d+)\s+literals:\s*(\d+)\s+edges:\s*(\d+)/.exec(text);
  const auto = /auto\s*:\s*(\d+) approved by policy/.exec(text)?.[1];
  return {
    ...(graph ? { buildGraph: graph } : {}),
    ...(inst ? { instances: Number(inst[1]), literals: Number(inst[2]), edges: Number(inst[3]) } : {}),
    ...(auto ? { auto } : {}),
  };
}

/** Start a build. Returns the BuildRun immediately; the job continues in the background. */
export async function startOntologyBuild(
  source: GraphSource,
  spec: OntologySpec,
  persona: { id: string; name: string }
): Promise<BuildRun> {
  const ctl = await controlStore();
  const running = (await ctl.listBuildRuns({ graphSourceId: source.graphSourceId }))
    .filter((r) => r.status === "running" || r.status === "pending");
  if (running.length) {
    throw new KgJobError("BUILD_RUNNING", `a build is already running for '${source.graphSourceId}' (${running[0].buildRunId})`);
  }
  const cmd = buildCommand(source, spec, persona.name);
  const run = await startBuildRun(source.graphSourceId, `graph-utility:${cmd.target}`);
  const lines: string[] = [`$ build_graph_live.py ${cmd.args.slice(2).join(" ")}`];
  logs.set(run.buildRunId, lines);

  let current = await ctl.updateBuildRunStatus(run.buildRunId, "running", {}, run.rev ?? 1);
  const child = spawn(cmd.python, cmd.args, { cwd: graphUtilityDir(), env: cmd.env });
  const push = (chunk: Buffer) => {
    for (const ln of chunk.toString().split("\n")) {
      if (!ln.trim()) continue;
      lines.push(ln);
      if (lines.length > LOG_LINES) lines.splice(1, lines.length - LOG_LINES);
    }
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);

  child.on("close", async (code) => {
    clearTimeout(timer);
    const facts = parseBuildOutput(lines);
    const ok = code === 0;
    try {
      if (ok && cmd.target === "neptune" && facts.buildGraph) {
        // The Neptune source now reads the build it just got.
        await updateGraphSourceBackend(source.graphSourceId, {
          ...(source.backend as NeptuneBackend),
          namedGraphs: [facts.buildGraph, `${facts.buildGraph}:inferred`],
        });
      }
      current = await ctl.updateBuildRunStatus(run.buildRunId, ok ? "succeeded" : "failed", {
        finishedAt: new Date().toISOString(),
        message: ok
          ? `${facts.buildGraph ?? "build"}: ${facts.instances ?? "?"} entities, ${facts.edges ?? "?"} edges` +
            (facts.auto ? `, ${facts.auto} mappings auto-approved` : "")
          : `exit ${code}: ${lines.slice(-3).join(" | ").slice(0, 400)}`,
        ...(facts.instances !== undefined ? { stats: { classes: undefined, rows: facts.instances } } : {}),
        ...(facts.buildGraph ? { externalRef: facts.buildGraph } : {}),
      }, current.rev ?? 2);
    } catch (e) {
      lines.push(`[control-plane] could not record the result: ${(e as Error).message}`);
    }
    logAudit({
      category: "graph", action: ok ? "kg-build-ontology" : "kg-build-ontology-failed", actor: persona.name,
      tenantId: source.tenantId ?? source.bu,
      detail: `Ontology-first build of '${source.graphSourceId}' (${spec.ontology}) ${ok ? "succeeded" : "failed"}` +
        (facts.buildGraph ? `: ${facts.buildGraph}` : ""),
    });
  });
  child.on("error", (e) => lines.push(`[control-plane] could not start the build: ${e.message}`));
  return current;
}
