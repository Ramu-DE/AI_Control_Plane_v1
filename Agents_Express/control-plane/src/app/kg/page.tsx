"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, EmptyState, Pill } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { GraphCanvas, KIND_STYLE } from "@/components/GraphCanvas";
import type { KgGraph, KgNode } from "@/lib/kg/read";
import { ActingAsSelect, useActingPersona } from "@/components/ActingAs";

type KgSpec =
  | { mode: "native"; labels: string[] }
  | {
      mode: "ontology-first";
      ontology: string;
      namespace: string;
      dataset: { kind: "uc"; catalog: string; schema: string; tableFilter?: string } | { kind: "csv"; dir: string };
      approvalProfile: "gxp-strict" | "standard" | "exploratory";
    }
  | { mode: "derived"; catalog: string; schema: string; tableFilter?: string };

interface SourceOption {
  graphSourceId: string;
  displayName: string;
  backend: string;
  status: string;
  tenantId: string;
  kgSpec: KgSpec | null;
  specSummary: string;
  canBuild: boolean;
  canExplore: boolean;
}
interface KgMeta {
  sources: SourceOption[];
  policy: { action: string; perimeterTool: string; scopedToolExample: string };
}
interface DeriveSummary {
  tablesSeen: number;
  classes: number;
  relationships: number;
  proposals: number;
  blocked: number;
}
interface BuildRunView {
  buildRunId: string;
  status: string;
  trigger: string;
  message?: string;
  startedAt: string;
  finishedAt?: string;
  log: string[];
}
type LoadedGraph = KgGraph & {
  mode?: string;
  latestBuild?: { buildId: string; loadedAt: string; meta: Record<string, unknown> } | null;
};

const MODE_BADGE: Record<string, string> = {
  native: "bg-teal-50 text-teal-700",
  "ontology-first": "bg-indigo-50 text-indigo-700",
  derived: "bg-amber-50 text-amber-800",
};

export default function KnowledgeGraphPage() {
  const [meta, setMeta] = useState<KgMeta | null>(null);
  const [sourceId, setSourceId] = useState("");
  const acting = useActingPersona();
  const personaId = acting.personaId;
  const [includeInstances, setIncludeInstances] = useState(true);
  const [graph, setGraph] = useState<LoadedGraph | null>(null);
  const [derived, setDerived] = useState<DeriveSummary | null>(null);
  const [buildInfo, setBuildInfo] = useState<string>("");
  const [runs, setRuns] = useState<BuildRunView[]>([]);
  const [selected, setSelected] = useState<KgNode | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [depth, setDepth] = useState(1);
  const [mode, setMode] = useState<"full" | "traversal">("full");
  const [expanding, setExpanding] = useState<string | undefined>(undefined);
  const [editingSpec, setEditingSpec] = useState(false);

  async function loadMeta(keep?: string) {
    const m = await getJSON<KgMeta>("/api/kg");
    setMeta(m);
    const approved = m.sources.filter((s) => s.status === "Approved");
    setSourceId((cur) => keep ?? (cur && approved.some((s) => s.graphSourceId === cur) ? cur : approved[0]?.graphSourceId ?? ""));
  }
  useEffect(() => {
    loadMeta().catch((e: Error) => setError(e.message));
  }, []);

  const source = meta?.sources.find((s) => s.graphSourceId === sourceId) ?? null;
  const spec = source?.kgSpec ?? null;

  // Switching source clears everything derived from the previous one.
  useEffect(() => {
    setGraph(null);
    setDerived(null);
    setBuildInfo("");
    setSelected(null);
    setError("");
    setRuns([]);
    if (sourceId) refreshRuns(sourceId);
  }, [sourceId]);

  async function refreshRuns(id = sourceId) {
    if (!id) return;
    try {
      const r = await getJSON<{ runs: BuildRunView[] }>(`/api/kg?graphSourceId=${encodeURIComponent(id)}&runs=1`);
      setRuns(r.runs);
      return r.runs;
    } catch {
      return [];
    }
  }

  // Poll while an ontology-first build is running.
  useEffect(() => {
    if (!runs.some((r) => r.status === "running" || r.status === "pending")) return;
    const t = setTimeout(async () => {
      const latest = await refreshRuns();
      if (latest && !latest.some((r) => r.status === "running" || r.status === "pending") && source?.canExplore) {
        await load();
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [runs]);

  async function derive() {
    setBusy("derive");
    setError("");
    try {
      const d = await sendJSON<{ summary: DeriveSummary }>("/api/kg", "POST", { op: "derive", graphSourceId: sourceId });
      setDerived(d.summary);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function build() {
    setBusy("build");
    setError("");
    setBuildInfo("");
    try {
      const r = await sendJSON<{
        mode: string;
        run?: BuildRunView;
        buildId?: string;
        classNodes?: number;
        propertyNodes?: number;
        relationshipEdges?: number;
        instanceNodes?: number;
        instanceEdges?: number;
        skipped?: string[];
        latencyMs?: number;
      }>("/api/kg", "POST", { op: "build", graphSourceId: sourceId, personaId, includeInstances });
      if (r.mode === "ontology-first") {
        setBuildInfo(`Build started (${r.run?.buildRunId}). graph-utility is running the ontology-first build for this source; progress below.`);
        await refreshRuns();
      } else {
        setBuildInfo(
          `build ${r.buildId}: ${r.classNodes} class(es), ${r.propertyNodes} property node(s), ` +
            `${r.relationshipEdges} schema edge(s), ${r.instanceNodes} instance(s), ` +
            `${r.instanceEdges} instance edge(s) in ${r.latencyMs}ms` +
            (r.skipped?.length ? ` · skipped: ${r.skipped.length}` : ""));
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function load() {
    setBusy("load");
    setError("");
    try {
      const g = await getJSON<LoadedGraph>(
        `/api/kg?graphSourceId=${encodeURIComponent(sourceId)}&instances=${includeInstances ? 1 : 0}` +
          `&personaId=${encodeURIComponent(personaId)}`);
      setGraph(g);
      setSelected(null);
      setMode("full");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  /** TRAVERSAL: expand one node's neighbourhood to the chosen depth. */
  async function expand(node: KgNode) {
    setExpanding(node.id);
    setError("");
    try {
      const g = await sendJSON<KgGraph>("/api/kg", "POST", {
        op: "neighbors",
        graphSourceId: sourceId,
        nodeId: node.id,
        depth,
        personaId,
      });
      setGraph(g);
      setSelected(node);
      setMode("traversal");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExpanding(undefined);
    }
  }

  const hiddenTotal = useMemo(() => {
    if (!graph) return 0;
    const shown = new Map<string, number>();
    for (const e of graph.edges) {
      shown.set(e.source, (shown.get(e.source) ?? 0) + 1);
      shown.set(e.target, (shown.get(e.target) ?? 0) + 1);
    }
    return graph.nodes.reduce(
      (acc, n) =>
        acc + (typeof n.degree === "number" ? Math.max(0, n.degree - (shown.get(n.id) ?? 0)) : 0),
      0
    );
  }, [graph]);

  const approvedSources = (meta?.sources ?? []).filter((s) => s.status === "Approved");

  return (
    <>
      <PageHeader
        title="Knowledge Graph"
        subtitle="Each Graph Source says where its knowledge graph comes from. Pick a source; the page builds or explores THAT source's graph, in its own database, under Cedar policy."
      />

      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* ---- source + its spec ---- */}
        <section className="card mb-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Graph source (Approved)">
              <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                {approvedSources.map((s) => (
                  <option key={s.graphSourceId} value={s.graphSourceId}>
                    {s.displayName} — {s.backend} · {s.kgSpec?.mode ?? "no spec"}
                  </option>
                ))}
                {meta && approvedSources.length === 0 && <option value="">No approved Graph Source</option>}
              </select>
            </Field>
            <div>
              <ActingAsSelect {...acting}
                hint="Exploring needs queryGraphSource (viewer+) in the source's tenant; building needs buildKnowledgeGraph (analyst+). GxP and residency policies apply." />
            </div>
          </div>

          {source && (
            <div className="mt-4 rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${MODE_BADGE[spec?.mode ?? ""] ?? "bg-red-50 text-red-700"}`}>
                  {spec?.mode ?? "no build spec"}
                </span>
                <span className="text-sm text-slate-700">{source.specSummary}</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                tenant <span className="mono">{source.tenantId}</span> · database backend{" "}
                <span className="mono">{source.backend}</span>
                {spec?.mode === "native" && " · Build is not offered: this source's data is loaded by its own pipeline."}
                {source.backend === "neptune" && " · Explore Neptune sources with SPARQL on the Graph Sources page."}
              </div>
              <button className="btn-ghost mt-2 text-xs" onClick={() => setEditingSpec((v) => !v)}>
                {editingSpec ? "Close build spec editor" : "Edit build spec (tenant admin)"}
              </button>
              {editingSpec && (
                <SpecEditor
                  source={source}
                  personaId={personaId}
                  onSaved={async () => {
                    setEditingSpec(false);
                    await loadMeta(source.graphSourceId);
                  }}
                />
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {spec?.mode === "derived" && (
              <button className="btn-ghost" onClick={derive} disabled={busy !== ""}>
                {busy === "derive" ? "Deriving…" : "Preview derived ontology"}
              </button>
            )}
            {source?.canBuild && (
              <button className="btn-primary" onClick={build} disabled={busy !== "" || !personaId}>
                {busy === "build" ? "Starting…" : spec?.mode === "ontology-first" ? "Build from ontology" : "Build knowledge graph"}
              </button>
            )}
            {source?.canExplore && (
              <button className="btn-ghost" onClick={load} disabled={busy !== "" || !personaId}>
                {busy === "load" ? "Loading…" : "Explore graph"}
              </button>
            )}
            {spec?.mode === "derived" && (
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={includeInstances} onChange={(e) => setIncludeInstances(e.target.checked)} />
                include instance rows
              </label>
            )}
            <label className="flex items-center gap-2 text-xs text-slate-600">
              traversal depth
              <select className="input w-16 py-1" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            {!personaId && <span className="text-xs text-amber-700">Choose who is acting.</span>}
          </div>
          {derived && (
            <div className="mt-3 rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-700">
              Derived from {derived.tablesSeen} table(s): <b>{derived.classes}</b> class(es),{" "}
              <b>{derived.relationships}</b> relationship(s), {derived.proposals} proposal(s)
              {derived.blocked > 0 && (
                <span className="text-amber-700">
                  {" "}· {derived.blocked} blocked (no subject key — will not be materialised)
                </span>
              )}
            </div>
          )}
          {buildInfo && (
            <div className="mt-2 rounded-lg bg-green-50 px-4 py-3 text-xs text-green-800">{buildInfo}</div>
          )}
          {graph?.latestBuild && (
            <div className="mt-2 text-xs text-slate-500">
              Showing build <span className="mono">{graph.latestBuild.buildId}</span> loaded {graph.latestBuild.loadedAt}
              {graph.latestBuild.meta?.approval_profile ? ` · profile ${String(graph.latestBuild.meta.approval_profile)}` : ""}
              {graph.latestBuild.meta?.ontology ? ` · ontology ${String(graph.latestBuild.meta.ontology)}` : ""}
            </div>
          )}
          {runs.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-slate-600">Build runs</div>
              <div className="mt-1 space-y-2">
                {runs.slice(0, 3).map((r) => (
                  <details key={r.buildRunId} open={r.status === "running" || r.status === "pending"}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
                    <summary className="cursor-pointer">
                      <Pill status={r.status === "succeeded" ? "Approved" : r.status === "failed" ? "Rejected" : "Pending approval"} />{" "}
                      <span className="mono">{r.buildRunId}</span> · {r.status} · {r.trigger} · {r.startedAt}
                      {r.message ? ` — ${r.message}` : ""}
                    </summary>
                    {r.log.length > 0 && (
                      <pre className="mono mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-2 text-[11px] text-slate-100">
                        {r.log.join("\n")}
                      </pre>
                    )}
                  </details>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ---- the graph ---- */}
        {!graph || graph.nodes.length === 0 ? (
          <EmptyState text="Nothing loaded yet. Pick a source, choose who is acting, then Explore (or Build first)." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <section className="card overflow-hidden p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
                <div className="flex flex-wrap gap-2">
                  <span className="badge bg-brand-50 text-brand-700">
                    {graph.counts.classes} classes
                  </span>
                  <span className="badge bg-slate-100 text-slate-600">
                    {graph.counts.properties} properties
                  </span>
                  <span className="badge bg-sky-50 text-sky-700">
                    {graph.counts.instances} instances
                  </span>
                  <span className="badge bg-slate-100 text-slate-600">
                    {graph.counts.edges} edges
                  </span>
                  {mode === "traversal" && (
                    <span className="badge bg-indigo-50 text-indigo-700">
                      traversal depth {depth}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <Legend kind="class" label="class" />
                  <Legend kind="property" label="property" />
                  <Legend kind="instance" label="instance" />
                </div>
              </div>

              {/* PRECISION: never present a partial view as complete. */}
              <div
                className={`border-b px-4 py-2 text-xs ${
                  graph.truncation.complete
                    ? "border-green-200 bg-green-50 text-green-800"
                    : "border-amber-300 bg-amber-50 text-amber-900"
                }`}
              >
                {graph.truncation.complete ? (
                  <>
                    Complete view — all {graph.truncation.nodesTotal} node(s) and{" "}
                    {graph.truncation.edgesTotal} relationship(s) in this build are shown.
                  </>
                ) : (
                  <>
                    <b>Partial view.</b> Showing {graph.truncation.nodesReturned} of{" "}
                    {graph.truncation.nodesTotal} node(s) and {graph.truncation.edgesReturned} of{" "}
                    {graph.truncation.edgesTotal} relationship(s)
                    {graph.truncation.edgesOmitted > 0 && (
                      <> · {graph.truncation.edgesOmitted} edge(s) omitted (endpoint outside this view)</>
                    )}
                    {hiddenTotal > 0 && <> · {hiddenTotal} hidden connection(s), ringed amber</>}
                    . Double-click a node to traverse from it.
                  </>
                )}
              </div>

              <GraphCanvas
                nodes={graph.nodes}
                edges={graph.edges}
                selectedId={selected?.id}
                originId={graph.origin}
                onSelect={setSelected}
                onExpand={expand}
                busyNodeId={expanding}
              />
            </section>

            {/* ---- detail panel ---- */}
            <aside className="card h-fit p-4">
              <h3 className="text-sm font-semibold">Selected node</h3>
              {!selected ? (
                <p className="mt-2 text-xs text-slate-500">
                  Click a node to inspect it, drag to pin it, double-click to traverse from it.
                  Red = ontology class, grey = property, blue = data instance. Dashed edges are{" "}
                  <span className="mono">INSTANCE_OF</span>. An amber dashed ring means the node has
                  connections not shown here.
                </p>
              ) : (
                <div className="mt-2 space-y-2 text-xs">
                  <div>
                    <div className="font-medium text-slate-900">{selected.label}</div>
                    <Pill status={selected.kind === "class" ? "Approved" : "Draft"} />
                  </div>
                  <D k="kind" v={selected.kind} />
                  {selected.group && <D k="group" v={selected.group} />}
                  <D k="id" v={selected.id} mono />
                  {selected.properties &&
                    Object.entries(selected.properties).map(([k, v]) => (
                      <D key={k} k={k} v={v === null ? "—" : String(v)} mono />
                    ))}
                  <div className="pt-1">
                    <button
                      type="button"
                      className="btn-primary w-full"
                      disabled={expanding !== undefined}
                      onClick={() => selected && expand(selected)}
                    >
                      {expanding === selected.id ? "Traversing…" : `Traverse ${depth} hop(s) from here`}
                    </button>
                  </div>
                  {typeof selected.degree === "number" && (
                    <D
                      k="edges"
                      v={`${graph.edges.filter((e) => e.source === selected.id || e.target === selected.id).length} shown / ${selected.degree} total`}
                    />
                  )}
                  <div className="pt-2">
                    <div className="font-medium text-slate-700">Connections</div>
                    <ul className="mt-1 space-y-0.5">
                      {graph.edges
                        .filter((e) => e.source === selected.id || e.target === selected.id)
                        .slice(0, 12)
                        .map((e, i) => {
                          const otherId = e.source === selected.id ? e.target : e.source;
                          const other = graph.nodes.find((n) => n.id === otherId);
                          const dir = e.source === selected.id ? "→" : "←";
                          return (
                            <li key={i} className="text-slate-600">
                              <span className="mono">{e.type}</span> {dir}{" "}
                              {other?.label ?? otherId}
                            </li>
                          );
                        })}
                    </ul>
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </>
  );
}

function Legend({ kind, label }: { kind: KgNode["kind"]; label: string }) {
  const s = KIND_STYLE[kind];
  return (
    <span className="flex items-center gap-1">
      <svg width="12" height="12" aria-hidden="true">
        <circle cx="6" cy="6" r="5" fill={s.fill} stroke={s.stroke} />
      </svg>
      {label}
    </span>
  );
}

function D({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <span className="text-slate-400">{k}: </span>
      <span className={`break-all text-slate-800 ${mono ? "mono" : ""}`}>{v}</span>
    </div>
  );
}

/** Admin-only editor for where a source's graph comes from. */
function SpecEditor({ source, personaId, onSaved }: { source: SourceOption; personaId: string; onSaved: () => Promise<void> }) {
  const cur = source.kgSpec;
  const [mode, setModeSel] = useState<KgSpec["mode"]>(cur?.mode ?? (source.backend === "neo4j" ? "native" : "ontology-first"));
  const [labels, setLabels] = useState(cur?.mode === "native" ? cur.labels.join(", ") : "");
  const [ontology, setOntology] = useState(cur?.mode === "ontology-first" ? cur.ontology : "takeda/");
  const [namespace, setNamespace] = useState(cur?.mode === "ontology-first" ? cur.namespace : "http://example.org/");
  const ds = cur?.mode === "ontology-first" ? cur.dataset : null;
  const [dsKind, setDsKind] = useState<"uc" | "csv">(ds?.kind ?? "uc");
  const [catalog, setCatalog] = useState(ds?.kind === "uc" ? ds.catalog : cur?.mode === "derived" ? cur.catalog : "workspace");
  const [schema, setSchema] = useState(ds?.kind === "uc" ? ds.schema : cur?.mode === "derived" ? cur.schema : "");
  const [tableFilter, setTableFilter] = useState(ds?.kind === "uc" ? ds.tableFilter ?? "" : cur?.mode === "derived" ? cur.tableFilter ?? "" : "");
  const [dir, setDir] = useState(ds?.kind === "csv" ? ds.dir : "");
  const [profile, setProfile] = useState<string>(cur?.mode === "ontology-first" ? cur.approvalProfile : "standard");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const kgSpec: KgSpec =
      mode === "native"
        ? { mode, labels: labels.split(/[\s,]+/).filter(Boolean) }
        : mode === "derived"
          ? { mode, catalog, schema, ...(tableFilter ? { tableFilter } : {}) }
          : {
              mode, ontology, namespace,
              approvalProfile: profile as "gxp-strict" | "standard" | "exploratory",
              dataset: dsKind === "uc" ? { kind: "uc", catalog, schema, ...(tableFilter ? { tableFilter } : {}) } : { kind: "csv", dir },
            };
    try {
      await sendJSON("/api/kg", "POST", { op: "set-spec", graphSourceId: source.graphSourceId, kgSpec, personaId });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Mode">
          <select className="input" value={mode} onChange={(e) => setModeSel(e.target.value as KgSpec["mode"])}>
            {source.backend === "neo4j" && <option value="native">native — data already in the graph</option>}
            <option value="ontology-first">ontology-first — graph-utility builds it</option>
            {source.backend === "neo4j" && <option value="derived">derived — legacy UC metadata demo</option>}
          </select>
        </Field>
        {mode === "native" && (
          <Field label="Labels that make up this source" hint="Comma separated; scopes Explore.">
            <input className="input" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="ClinicalTrial, Disease" />
          </Field>
        )}
        {mode === "ontology-first" && (
          <>
            <Field label="Ontology (under graph-utility/ontologies/)">
              <input className="input" value={ontology} onChange={(e) => setOntology(e.target.value)} />
            </Field>
            <Field label="Ontology namespace">
              <input className="input" value={namespace} onChange={(e) => setNamespace(e.target.value)} />
            </Field>
            <Field label="Approval profile">
              <select className="input" value={profile} onChange={(e) => setProfile(e.target.value)}>
                <option value="gxp-strict">gxp-strict</option>
                <option value="standard">standard</option>
                <option value="exploratory">exploratory</option>
              </select>
            </Field>
            <Field label="Dataset">
              <select className="input" value={dsKind} onChange={(e) => setDsKind(e.target.value as "uc" | "csv")}>
                <option value="uc">Unity Catalog</option>
                <option value="csv">CSV directory</option>
              </select>
            </Field>
          </>
        )}
        {(mode === "derived" || (mode === "ontology-first" && dsKind === "uc")) && (
          <>
            <Field label="UC catalog"><input className="input" value={catalog} onChange={(e) => setCatalog(e.target.value)} /></Field>
            <Field label="UC schema"><input className="input" value={schema} onChange={(e) => setSchema(e.target.value)} /></Field>
            <Field label="Table prefix (optional)"><input className="input" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} /></Field>
          </>
        )}
        {mode === "ontology-first" && dsKind === "csv" && (
          <Field label="CSV directory"><input className="input" value={dir} onChange={(e) => setDir(e.target.value)} /></Field>
        )}
      </div>
      <button className="btn-primary" onClick={save} disabled={!personaId}>Save build spec</button>
      {!personaId && <span className="ml-2 text-xs text-amber-700">Choose who is acting (an admin of {source.tenantId}).</span>}
    </div>
  );
}
