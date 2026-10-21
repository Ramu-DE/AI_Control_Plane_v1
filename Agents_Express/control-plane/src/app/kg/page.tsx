"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, EmptyState, Pill } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { GraphCanvas, KIND_STYLE } from "@/components/GraphCanvas";
import type { KgGraph, KgNode } from "@/lib/kg/read";

interface SourceOption {
  graphSourceId: string;
  displayName: string;
  backend: string;
  status: string;
}
interface PersonaOption { id: string; name: string; groups: string[] }
interface KgMeta {
  sources: SourceOption[];
  personas: PersonaOption[];
  policy: { action: string; perimeterTool: string; scopedToolExample: string };
}

interface DeriveSummary {
  tablesSeen: number;
  classes: number;
  relationships: number;
  proposals: number;
  blocked: number;
}

export default function KnowledgeGraphPage() {
  const [meta, setMeta] = useState<KgMeta | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [catalog, setCatalog] = useState("workspace");
  const [schema, setSchema] = useState("default");
  const [tableFilter, setTableFilter] = useState("agentexpress_");
  const [includeInstances, setIncludeInstances] = useState(true);
  const [graph, setGraph] = useState<KgGraph | null>(null);
  const [derived, setDerived] = useState<DeriveSummary | null>(null);
  const [buildInfo, setBuildInfo] = useState<string>("");
  const [selected, setSelected] = useState<KgNode | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [depth, setDepth] = useState(1);
  const [mode, setMode] = useState<"full" | "traversal">("full");
  const [expanding, setExpanding] = useState<string | undefined>(undefined);

  useEffect(() => {
    getJSON<KgMeta>("/api/kg")
      .then((m) => {
        setMeta(m);
        const neo = m.sources.find((s) => s.backend === "neo4j" && s.status === "Approved");
        setSourceId(neo?.graphSourceId ?? m.sources[0]?.graphSourceId ?? "");
        setPersonaId(m.personas[0]?.id ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function derive() {
    setBusy("derive");
    setError("");
    try {
      const d = await sendJSON<{ summary: DeriveSummary }>("/api/kg", "POST", {
        op: "derive",
        catalog,
        schema,
        tableFilter: tableFilter || undefined,
      });
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
        buildId: string;
        classNodes: number;
        propertyNodes: number;
        relationshipEdges: number;
        instanceNodes: number;
        instanceEdges: number;
        skipped: string[];
        latencyMs: number;
      }>("/api/kg", "POST", {
        op: "build",
        graphSourceId: sourceId,
        personaId,
        catalog,
        schema,
        tableFilter: tableFilter || undefined,
        includeInstances,
      });
      setBuildInfo(
        `build ${r.buildId}: ${r.classNodes} class(es), ${r.propertyNodes} property node(s), ` +
          `${r.relationshipEdges} schema edge(s), ${r.instanceNodes} instance(s), ` +
          `${r.instanceEdges} instance edge(s) in ${r.latencyMs}ms` +
          (r.skipped.length ? ` · skipped: ${r.skipped.length}` : "")
      );
      await load();
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
      const g = await getJSON<KgGraph>(
        `/api/kg?graphSourceId=${encodeURIComponent(sourceId)}&instances=${includeInstances ? 1 : 0}`
      );
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

  return (
    <>
      <PageHeader
        title="Knowledge Graph"
        subtitle="Derive an ontology from live Unity Catalog metadata, materialise it into Neo4j under Cedar policy, and see how the graph connects."
      />

      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* ---- controls ---- */}
        <section className="card mb-4 p-5">
          <h2 className="text-base font-semibold">Build</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            <b>Derive</b> reads Unity Catalog metadata and proposes an ontology (read-only).
            <b> Build</b> materialises the approved classes into Neo4j — the one write path in the
            platform, gated by Cedar{" "}
            <span className="mono">{meta?.policy.action ?? "buildKnowledgeGraph"}</span>.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Graph source (neo4j, Approved)">
              <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                {(meta?.sources ?? []).map((s) => (
                  <option key={s.graphSourceId} value={s.graphSourceId}>
                    {s.displayName} — {s.backend} ({s.status})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Run as persona">
              <select className="input" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
                {(meta?.personas ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.groups.join(", ")})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Table prefix filter" hint="Limits which UC tables become classes.">
              <input className="input" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} />
            </Field>
            <Field label="UC catalog">
              <input className="input" value={catalog} onChange={(e) => setCatalog(e.target.value)} />
            </Field>
            <Field label="UC schema">
              <input className="input" value={schema} onChange={(e) => setSchema(e.target.value)} />
            </Field>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={includeInstances}
                  onChange={(e) => setIncludeInstances(e.target.checked)}
                />
                include instance rows
              </label>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={derive} disabled={busy !== ""}>
              {busy === "derive" ? "Deriving…" : "1 · Derive ontology"}
            </button>
            <button className="btn-primary" onClick={build} disabled={busy !== "" || !sourceId || !personaId}>
              {busy === "build" ? "Building…" : "2 · Build knowledge graph"}
            </button>
            <button className="btn-ghost" onClick={load} disabled={busy !== "" || !sourceId}>
              {busy === "load" ? "Loading…" : "3 · Load graph"}
            </button>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              traversal depth
              <select
                className="input w-16 py-1"
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
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
            <div className="mt-2 rounded-lg bg-green-50 px-4 py-3 text-xs text-green-800">
              {buildInfo}
            </div>
          )}
        </section>

        {/* ---- the graph ---- */}
        {!graph || graph.nodes.length === 0 ? (
          <EmptyState text="No knowledge graph loaded yet. Derive, build, then load." />
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
