"use client";

// Interactive SVG graph canvas — zoom, pan, node dragging, traversal.
//
// Still no visualisation dependency: one <svg>, one transform group, and
// pointer events. That keeps the render exactly as precise as the data —
// nothing is resampled, clustered or approximated behind our back.
//
// Precision rules this component follows:
//   - a node whose TRUE degree exceeds the edges visible here is ringed and
//     labelled, so a partial view is never mistaken for a complete one;
//   - dragging PINS a node: pinned nodes keep their position across re-layouts
//     (expanding the graph must not teleport what you were looking at);
//   - the layout is seeded, so the same data always lays out the same way.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { forceLayout, ringFor } from "@/lib/kg/layout";
import type { KgEdge, KgNode } from "@/lib/kg/read";

export const KIND_STYLE: Record<KgNode["kind"], { fill: string; stroke: string; r: number }> = {
  class: { fill: "#e1242a", stroke: "#9a171c", r: 16 },
  property: { fill: "#94a3b8", stroke: "#64748b", r: 6 },
  instance: { fill: "#0ea5e9", stroke: "#0369a1", r: 9 },
};

const WIDTH = 1000;
const HEIGHT = 640;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

interface View {
  k: number;
  tx: number;
  ty: number;
}

export interface GraphCanvasProps {
  nodes: KgNode[];
  edges: KgEdge[];
  selectedId?: string;
  originId?: string;
  onSelect: (node: KgNode) => void;
  onExpand: (node: KgNode) => void;
  /** Node ids currently being fetched, for a spinner-ish cue. */
  busyNodeId?: string;
}

export function GraphCanvas({
  nodes,
  edges,
  selectedId,
  originId,
  onSelect,
  onExpand,
  busyNodeId,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const [pinned, setPinned] = useState<Record<string, { x: number; y: number }>>({});
  const [drag, setDrag] = useState<
    | { kind: "pan"; startX: number; startY: number; from: View }
    | { kind: "node"; id: string }
    | null
  >(null);
  const [hover, setHover] = useState<string | null>(null);

  // Base layout. Deterministic, and recomputed only when the graph changes.
  const base = useMemo(() => {
    const positions = forceLayout(
      nodes.map((n) => ({ id: n.id, ring: ringFor(n.kind) })),
      edges,
      { width: WIDTH, height: HEIGHT, seed: 7 }
    );
    return new Map(positions.map((p) => [p.id, { x: p.x, y: p.y }]));
  }, [nodes, edges]);

  /** Pinned position wins, so a node you dragged stays where you put it. */
  const posOf = useCallback(
    (id: string) => pinned[id] ?? base.get(id) ?? { x: WIDTH / 2, y: HEIGHT / 2 },
    [pinned, base]
  );

  // How many of each node's real edges are actually on screen.
  const shownDegree = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of edges) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1);
      m.set(e.target, (m.get(e.target) ?? 0) + 1);
    }
    return m;
  }, [edges]);

  /** Convert a client point into SVG user space, accounting for the transform. */
  const toLocal = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      const sx = ((clientX - rect.left) / rect.width) * WIDTH;
      const sy = ((clientY - rect.top) / rect.height) * HEIGHT;
      return { x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k };
    },
    [view]
  );

  // ---- zoom (wheel, anchored on the pointer) ----
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function onWheel(ev: WheelEvent) {
      ev.preventDefault();
      const rect = svg!.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * WIDTH;
      const py = ((ev.clientY - rect.top) / rect.height) * HEIGHT;
      setView((v) => {
        const factor = Math.exp(-ev.deltaY * 0.0015);
        const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.k * factor));
        // Keep the point under the cursor fixed while scaling.
        return { k, tx: px - ((px - v.tx) / v.k) * k, ty: py - ((py - v.ty) / v.k) * k };
      });
    }
    // Non-passive so preventDefault actually stops page scroll.
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // ---- pan + node drag ----
  function onPointerDownBackground(ev: React.PointerEvent) {
    if (ev.button !== 0) return;
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    setDrag({ kind: "pan", startX: ev.clientX, startY: ev.clientY, from: view });
  }

  function onPointerDownNode(ev: React.PointerEvent, node: KgNode) {
    ev.stopPropagation();
    if (ev.button !== 0) return;
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    setDrag({ kind: "node", id: node.id });
    onSelect(node);
  }

  function onPointerMove(ev: React.PointerEvent) {
    if (!drag) return;
    if (drag.kind === "pan") {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const dx = ((ev.clientX - drag.startX) / rect.width) * WIDTH;
      const dy = ((ev.clientY - drag.startY) / rect.height) * HEIGHT;
      setView({ k: drag.from.k, tx: drag.from.tx + dx, ty: drag.from.ty + dy });
    } else {
      const p = toLocal(ev.clientX, ev.clientY);
      setPinned((cur) => ({ ...cur, [drag.id]: p }));
    }
  }

  function onPointerUp() {
    setDrag(null);
  }

  function reset() {
    setView({ k: 1, tx: 0, ty: 0 });
  }
  function unpinAll() {
    setPinned({});
  }
  function zoomBy(factor: number) {
    setView((v) => {
      const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.k * factor));
      const cx = WIDTH / 2;
      const cy = HEIGHT / 2;
      return { k, tx: cx - ((cx - v.tx) / v.k) * k, ty: cy - ((cy - v.ty) / v.k) * k };
    });
  }

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <div className="relative">
      {/* controls */}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <button type="button" className="btn-ghost px-2 py-1" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="btn-ghost px-2 py-1" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="btn-ghost px-2 py-1 text-[10px]" onClick={reset} aria-label="Reset view">
          fit
        </button>
        {Object.keys(pinned).length > 0 && (
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-[10px]"
            onClick={unpinAll}
            aria-label="Release pinned nodes"
          >
            unpin
          </button>
        )}
      </div>
      <div className="absolute left-3 top-3 z-10 rounded bg-white/85 px-2 py-1 text-[11px] text-slate-500">
        scroll = zoom · drag background = pan · drag node = pin · double-click node = expand
        {" · "}
        <span className="mono">{(view.k * 100).toFixed(0)}%</span>
        {Object.keys(pinned).length > 0 && (
          <span> · {Object.keys(pinned).length} pinned</span>
        )}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className={`h-[640px] w-full bg-slate-50 ${drag?.kind === "pan" ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={onPointerDownBackground}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        role="img"
        aria-label="Interactive knowledge graph"
      >
        <defs>
          <marker id="kg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
          </marker>
        </defs>

        <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
          {/* edges */}
          {edges.map((e, i) => {
            const a = posOf(e.source);
            const b = posOf(e.target);
            const isSchema = e.type === "HAS_PROPERTY" || e.type === "INSTANCE_OF";
            const touched = hover === e.source || hover === e.target || selectedId === e.source || selectedId === e.target;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            return (
              <g key={`${e.source}-${e.type}-${e.target}-${i}`}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={touched ? "#0f172a" : isSchema ? "#cbd5e1" : "#fca5a5"}
                  strokeWidth={touched ? 2.2 : isSchema ? 1 : 1.8}
                  strokeDasharray={e.type === "INSTANCE_OF" ? "3 3" : undefined}
                  markerEnd={isSchema ? undefined : "url(#kg-arrow)"}
                />
                {/* Only label edges near the focus, or the picture turns to soup. */}
                {touched && view.k > 0.5 && (
                  <text x={mx} y={my - 3} textAnchor="middle" fontSize={9} fill="#334155">
                    {e.type}
                  </text>
                )}
              </g>
            );
          })}

          {/* nodes */}
          {nodes.map((n) => {
            const p = posOf(n.id);
            const style = KIND_STYLE[n.kind];
            const isSel = selectedId === n.id;
            const isOrigin = originId === n.id;
            const shown = shownDegree.get(n.id) ?? 0;
            const hidden = typeof n.degree === "number" ? Math.max(0, n.degree - shown) : 0;
            const isBusy = busyNodeId === n.id;
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                onPointerDown={(ev) => onPointerDownNode(ev, n)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(null)}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  onExpand(n);
                }}
                className="cursor-pointer"
              >
                {/* hidden-neighbour ring: the precision cue */}
                {hidden > 0 && (
                  <circle
                    r={style.r + 5}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    strokeDasharray="2 2"
                  />
                )}
                {isOrigin && (
                  <circle r={style.r + 9} fill="none" stroke="#0f172a" strokeWidth={1} opacity={0.35} />
                )}
                <circle
                  r={isSel ? style.r + 4 : style.r}
                  fill={style.fill}
                  stroke={isSel ? "#0f172a" : style.stroke}
                  strokeWidth={isSel ? 3 : 1.5}
                  opacity={isBusy ? 0.5 : n.kind === "property" ? 0.85 : 1}
                />
                {pinned[n.id] && <circle r={2} fill="#0f172a" />}
                {(n.kind !== "property" || isSel || hover === n.id) && view.k > 0.4 && (
                  <text
                    y={-style.r - 6}
                    textAnchor="middle"
                    fontSize={n.kind === "class" ? 12 : 10}
                    fontWeight={n.kind === "class" ? 600 : 400}
                    fill="#0f172a"
                  >
                    {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
                  </text>
                )}
                {hidden > 0 && view.k > 0.5 && (
                  <text y={style.r + 13} textAnchor="middle" fontSize={9} fill="#b45309">
                    +{hidden}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {hover && nodeById.get(hover) && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-slate-900/90 px-3 py-2 text-xs text-white">
          <div className="font-medium">{nodeById.get(hover)!.label}</div>
          <div className="text-slate-300">
            {nodeById.get(hover)!.kind}
            {typeof nodeById.get(hover)!.degree === "number" && (
              <>
                {" · "}
                {shownDegree.get(hover) ?? 0}/{nodeById.get(hover)!.degree} edges shown
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
