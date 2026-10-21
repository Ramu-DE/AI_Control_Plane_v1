// Deterministic force-directed layout — no dependency, no canvas.
//
// A graph view needs positions. Rather than add a visualisation library
// (react-force-graph, cytoscape, d3) for one page, this is a compact
// Fruchterman–Reingold implementation: ~40 lines of physics, seeded so the same
// graph always lays out the same way (important for screenshots and for tests).
//
// Pure and synchronous: the React page renders plain SVG from the result.

export interface LayoutNode {
  id: string;
  /** Pinned ring: classes are placed inward, instances outward. */
  ring?: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
  /** Deterministic seed so layouts are reproducible. */
  seed?: number;
}

/** Tiny deterministic PRNG (mulberry32) — avoids Math.random in layout. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lay out a graph.
 *
 * Nodes start on concentric rings by `ring` (so the ontology layer sits inside
 * and instances orbit outside — which is what makes the picture readable), then
 * a short force simulation separates overlaps while edges pull related nodes
 * together.
 */
export function forceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions = {}
): Positioned[] {
  const width = opts.width ?? 900;
  const height = opts.height ?? 620;
  const iterations = opts.iterations ?? 220;
  const random = rng(opts.seed ?? 42);

  if (nodes.length === 0) return [];

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const pos = nodes.map((n, i) => {
    // Seed on a ring: deterministic, and already roughly untangled.
    const ring = n.ring ?? 1;
    const count = nodes.filter((m) => (m.ring ?? 1) === ring).length || 1;
    const rank = nodes.filter((m, j) => (m.ring ?? 1) === ring && j < i).length;
    const angle = (rank / count) * Math.PI * 2 + ring * 0.6;
    const radius = (Math.min(width, height) / 2) * (0.22 + 0.3 * ring);
    return {
      x: width / 2 + Math.cos(angle) * radius + (random() - 0.5) * 8,
      y: height / 2 + Math.sin(angle) * radius + (random() - 0.5) * 8,
    };
  });

  const area = width * height;
  const k = Math.sqrt(area / nodes.length) * 0.75; // ideal edge length
  let temperature = Math.min(width, height) / 8;
  const cooling = temperature / (iterations + 1);

  const disp = nodes.map(() => ({ x: 0, y: 0 }));

  for (let step = 0; step < iterations; step++) {
    for (const d of disp) {
      d.x = 0;
      d.y = 0;
    }

    // Repulsion between every pair (n is small for a governed KG view).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          // Deterministic jitter so coincident nodes separate.
          dx = (random() - 0.5) * 0.1;
          dy = (random() - 0.5) * 0.1;
          dist = Math.hypot(dx, dy) || 0.01;
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].x += fx;
        disp[i].y += fy;
        disp[j].x -= fx;
        disp[j].y -= fy;
      }
    }

    // Attraction along edges.
    for (const e of edges) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (a === undefined || b === undefined || a === b) continue;
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[a].x -= fx;
      disp[a].y -= fy;
      disp[b].x += fx;
      disp[b].y += fy;
    }

    // Apply, clamped by temperature, and keep inside the viewport.
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
      const limited = Math.min(d, temperature);
      pos[i].x += (disp[i].x / d) * limited;
      pos[i].y += (disp[i].y / d) * limited;
      pos[i].x = Math.max(40, Math.min(width - 40, pos[i].x));
      pos[i].y = Math.max(40, Math.min(height - 40, pos[i].y));
    }
    temperature -= cooling;
  }

  return nodes.map((n, i) => ({ id: n.id, x: pos[i].x, y: pos[i].y }));
}

/** Ring assignment that makes the ontology readable: schema in, data out. */
export function ringFor(kind: "class" | "property" | "instance"): number {
  if (kind === "class") return 0;
  if (kind === "property") return 1;
  return 2;
}
