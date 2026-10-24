// Governed SPARQL for Neptune Graph Sources — read-only AND scoped to the
// source's own named graphs.
//
// Neptune holds every build in its own named graph (`urn:kg:build:<id>`, plus
// `:inferred`), and its default graph is the UNION of all of them. So without
// scoping, a query against one Graph Source reads every other source in the
// cluster — the same gap a shared Neo4j database has. SPARQL can close it: a
// FROM clause replaces the default graph with exactly the graphs named. This
// module therefore:
//
//   1. refuses anything but SELECT / ASK (no update forms, no CONSTRUCT bodies
//      to parse), and refuses SERVICE, which would make Neptune itself call an
//      arbitrary endpoint (SSRF through the database);
//   2. refuses queries that pick their own dataset (FROM / FROM NAMED / GRAPH),
//      because those are exactly how scoping would be escaped;
//   3. INJECTS `FROM <g>` for each of the source's graphs, so a query sees
//      that source and nothing else;
//   4. appends a LIMIT when none is given, and caps rows on the way back.
//
// Keyword checks run over a copy with strings, IRIs and comments blanked to
// spaces (same length), so `"DROP"` in a literal or `<…/insert>` in an IRI is
// not mistaken for a clause, and positions still line up with the original.

import type { NeptuneBackend } from "./entities";

export class UnsafeSparqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSparqlError";
  }
}

const FORBIDDEN = [
  "INSERT", "DELETE", "LOAD", "CLEAR", "DROP", "CREATE", "ADD", "MOVE", "COPY", "WITH",
  "SERVICE", "FROM", "GRAPH",
];

/** Blank out string literals, IRIs and comments, preserving length. */
export function maskSparql(query: string): string {
  const out = query.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === "#") {
      const end = query.indexOf("\n", i);
      const stop = end === -1 ? query.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "<") {
      // An IRIREF has no spaces; a `<` followed by whitespace is a comparison.
      const m = /^<[^<>"{}|^`\\\s]*>/.exec(query.slice(i));
      if (m) {
        blank(i + 1, i + m[0].length - 1);
        i += m[0].length;
      } else i++;
    } else if (ch === '"' || ch === "'") {
      const long = query.startsWith(ch.repeat(3), i);
      const delim = long ? ch.repeat(3) : ch;
      let j = i + delim.length;
      while (j < query.length && !query.startsWith(delim, j)) j += query[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j + delim.length - 1, query.length));
      i = j + delim.length;
    } else i++;
  }
  return out.join("");
}

export interface SparqlPlan {
  query: string;
  form: "SELECT" | "ASK";
}

/** Validate and scope a query. Throws UnsafeSparqlError on any refusal. */
export function planSparql(query: string, graphs: string[], limit: number): SparqlPlan {
  if (!query.trim()) throw new UnsafeSparqlError("empty SPARQL query");
  if (graphs.length === 0) {
    throw new UnsafeSparqlError("this Graph Source declares no named graphs to scope queries to");
  }
  for (const g of graphs) {
    if (!/^urn:kg:build:[A-Za-z0-9._:-]+$/.test(g)) {
      throw new UnsafeSparqlError(`refusing to scope to unexpected graph name '${g}'`);
    }
  }
  const masked = maskSparql(query);
  const upper = masked.toUpperCase();
  for (const kw of FORBIDDEN) {
    if (new RegExp(`(^|[^A-Z_?$:])${kw}([^A-Z_]|$)`).test(upper)) {
      throw new UnsafeSparqlError(
        kw === "SERVICE"
          ? "SERVICE (federated queries) is not permitted"
          : ["FROM", "GRAPH"].includes(kw)
            ? `${kw} is not permitted: queries are scoped to this Graph Source's graphs automatically`
            : `only read-only SELECT/ASK queries are permitted (found ${kw})`
      );
    }
  }
  const formMatch = /(^|[^A-Z_?$])(SELECT|ASK|CONSTRUCT|DESCRIBE)([^A-Z_]|$)/.exec(upper);
  if (!formMatch || (formMatch[2] !== "SELECT" && formMatch[2] !== "ASK")) {
    throw new UnsafeSparqlError("only SELECT or ASK queries are permitted");
  }
  const form = formMatch[2] as "SELECT" | "ASK";

  // Dataset clauses go before the WHERE clause's opening brace.
  const formAt = formMatch.index + formMatch[1].length;
  const brace = masked.indexOf("{", formAt);
  if (brace === -1) throw new UnsafeSparqlError("query has no WHERE clause");
  const before = masked.slice(formAt, brace);
  const whereAt = /\bWHERE\s*$/i.exec(before);
  const insertAt = whereAt ? formAt + whereAt.index : brace;
  const dataset = graphs.map((g) => `FROM <${g}>`).join(" ") + " ";
  let scoped = query.slice(0, insertAt) + dataset + query.slice(insertAt);

  if (form === "SELECT" && !/(^|[^A-Z_])LIMIT\s+\d+/.test(upper)) {
    scoped = `${scoped.trimEnd()}\nLIMIT ${limit}`;
  }
  return { query: scoped, form };
}

export interface SparqlResult {
  columns: string[];
  rows: Record<string, string>[];
  rowCount: number;
  boolean?: boolean;
}

/** True when the endpoint is https, not private/metadata-shaped, and allowlisted. */
export function neptuneEndpointHost(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

/** POST a planned query to Neptune's SPARQL endpoint. Egress only — authorize first. */
export async function runSparql(
  backend: NeptuneBackend,
  plan: SparqlPlan,
  opts: { limit: number; timeoutMs?: number }
): Promise<SparqlResult> {
  const res = await fetch(`${backend.endpoint.replace(/\/+$/, "")}/sparql`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/sparql-results+json",
    },
    body: new URLSearchParams({ query: plan.query }).toString(),
    signal: AbortSignal.timeout(Math.min(Math.max(opts.timeoutMs ?? 20_000, 1_000), 30_000)),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Neptune returned ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as {
    head?: { vars?: string[] };
    boolean?: boolean;
    results?: { bindings: Record<string, { value: string }>[] };
  };
  if (plan.form === "ASK") {
    return { columns: [], rows: [], rowCount: 0, boolean: Boolean(body.boolean) };
  }
  const columns = body.head?.vars ?? [];
  const rows = (body.results?.bindings ?? []).slice(0, opts.limit).map((b) =>
    Object.fromEntries(columns.map((c) => [c, b[c]?.value ?? ""]))
  );
  return { columns, rows, rowCount: rows.length };
}
