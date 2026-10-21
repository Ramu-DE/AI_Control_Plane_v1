"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, EmptyState, Pill } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { forceLayout, ringFor } from "@/lib/kg/layout";
import type { KgEdge, KgGraph, KgNode } from "@/lib/kg/read";

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

const KIND_STYLE: Record<KgNode["kind"], { fill: string; stroke: string; r: number }> = {
  class: { fill: "#e1242a", stroke: "#9a171c", r: 16 },
  property: { fill: "#94a3b8", stroke: "#64748b", r: 6 },
  instance: { fill: "#0ea5e9", stroke: "#0369a1", r: 9 },
};

const WIDTH = 900;
const HEIGHT = 620;

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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  // Layout is deterministic, so the picture is stable across renders.
  const positioned = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return null;
    const pos = forceLayout(
      graph.nodes.map((n) => ({ id: n.id, ring: ringFor(n.kind) })),
      graph.edges,
      { width: WIDTH, height: HEIGHT, seed: 7 }
    );
    const byId = new Map(pos.map((p) => [p.id, p]));
    return { byId, nodes: graph.nodes, edges: graph.edges };
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
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <Legend kind="class" label="class" />
                  <Legend kind="property" label="property" />
                  <Legend kind="instance" label="instance" />
                </div>
              </div>
              <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                className="h-[620px] w-full bg-slate-50"
                role="img"
                aria-label="Knowledge graph"
              >
                {positioned &&
                  positioned.edges.map((e: KgEdge, i) => {
                    const a = positioned.byId.get(e.source);
                    const b = positioned.byId.get(e.target);
                    if (!a || !b) return null;
                    const isSchema = e.type === "HAS_PROPERTY" || e.type === "INSTANCE_OF";
                    return (
                      <line
                        key={i}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke={isSchema ? "#cbd5e1" : "#fca5a5"}
                        strokeWidth={isSchema ? 1 : 1.8}
                        strokeDasharray={e.type === "INSTANCE_OF" ? "3 3" : undefined}
                      />
                    );
                  })}
                {positioned &&
                  positioned.nodes.map((n) => {
                    const p = positioned.byId.get(n.id);
                    if (!p) return null;
                    const style = KIND_STYLE[n.kind];
                    const isSel = selected?.id === n.id;
                    return (
                      <g key={n.id} onClick={() => setSelected(n)} className="cursor-pointer">
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={isSel ? style.r + 4 : style.r}
                          fill={style.fill}
                          stroke={isSel ? "#0f172a" : style.stroke}
                          strokeWidth={isSel ? 3 : 1.5}
                          opacity={n.kind === "property" ? 0.85 : 1}
                        />
                        {(n.kind !== "property" || isSel) && (
                          <text
                            x={p.x}
                            y={p.y - style.r - 5}
                            textAnchor="middle"
                            fontSize={n.kind === "class" ? 12 : 10}
                            fontWeight={n.kind === "class" ? 600 : 400}
                            fill="#0f172a"
                          >
                            {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
              </svg>
            </section>

            {/* ---- detail panel ---- */}
            <aside className="card h-fit p-4">
              <h3 className="text-sm font-semibold">Selected node</h3>
              {!selected ? (
                <p className="mt-2 text-xs text-slate-500">
                  Click a node to inspect it. Red = ontology class, grey = property, blue = data
                  instance. Dashed edges are <span className="mono">INSTANCE_OF</span>.
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
