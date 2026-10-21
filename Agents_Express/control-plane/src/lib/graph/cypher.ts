// Pure, read-only Cypher builder for neo4j-backed GraphSources.
//
// The Databricks path ships a natural-language question to an external serving
// endpoint that performs NL→SQL. For a native Neo4j backend we keep the request
// governed and SAFE without an LLM in the hot path:
//
//   1. If the caller supplies explicit `cypher`, we REQUIRE it to be read-only
//      (reject any write/admin clause) and run it verbatim.
//   2. Otherwise we derive a deterministic, read-only EXPLORATION query from the
//      natural-language question (label mentioned → sample that label; else a
//      label inventory). This never mutates data and always returns rows the UI
//      can render, so "ask this graph" produces a real result.
//
// No I/O here — this module is pure and unit-testable.

// Clauses that mutate data or change the database/schema. A query containing
// any of these (as a whole word) is rejected on the governed read path.
//
// This list is DEFENCE IN DEPTH, not the primary control. The authoritative
// guarantee is that `runReadQuery` opens the session with
// `defaultAccessMode: READ` and uses `executeRead`, so Neo4j itself refuses any
// write with `Neo.ClientError.Statement.AccessMode` — verified against a live
// instance, including writes nested inside a CALL subquery.
//
// Because the scan covers the whole statement, a write clause is still caught
// wherever it appears, including inside `CALL { ... }`. We therefore do NOT
// reject `CALL {` itself: read-only subqueries are ordinary, legitimate Cypher
// (the derived label-inventory plan below is one), and blanket-rejecting them
// denied valid queries while adding no protection the server does not already
// provide.
const WRITE_CLAUSES = [
  "CREATE",
  "MERGE",
  "DELETE",
  "DETACH",
  "SET",
  "REMOVE",
  "DROP",
  "FOREACH",
  "LOAD CSV",
];

// Administrative / procedure surfaces we never allow on the ad-hoc query path.
const ADMIN_PATTERNS: RegExp[] = [
  /\bUSING\s+PERIODIC\s+COMMIT\b/i,
  /\bCREATE\s+(USER|ROLE|DATABASE|INDEX|CONSTRAINT)\b/i,
  /\bDROP\s+(USER|ROLE|DATABASE|INDEX|CONSTRAINT)\b/i,
  /\bapoc\.(create|merge|refactor|trigger|periodic)\b/i,
  /\bdbms\.(security|setConfigValue|killQuery)\b/i,
];

export interface CypherPlan {
  cypher: string;
  params: Record<string, unknown>;
  /** How the query was produced, for preview/audit transparency. */
  source: "explicit" | "derived-label-sample" | "derived-label-inventory";
  /** Human-readable note shown in the preview. */
  note: string;
}

export class UnsafeCypherError extends Error {
  readonly code = "UNSAFE_CYPHER";
  constructor(message: string) {
    super(message);
    this.name = "UnsafeCypherError";
  }
}

/** True when the Cypher text contains no write/admin surface (read-only). */
export function isReadOnlyCypher(cypher: string): boolean {
  const upper = cypher.toUpperCase();
  for (const clause of WRITE_CLAUSES) {
    // whole-word match so e.g. "created_at" property names don't trip CREATE
    const re = new RegExp(`(^|[^A-Z_])${clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z_]|$)`);
    if (re.test(upper)) return false;
  }
  for (const re of ADMIN_PATTERNS) if (re.test(cypher)) return false;
  return true;
}

/**
 * Extract a candidate node label from a natural-language question. Labels in
 * Neo4j are typically PascalCase (Supplier, Contract). We look for a capitalized
 * word that plausibly names a label; fall back to the first known-ish token.
 */
function extractLabel(question: string): string | null {
  // Prefer an explicit PascalCase token (Supplier, PurchaseOrder).
  const pascal = question.match(/\b([A-Z][a-zA-Z0-9]{2,})\b/);
  if (pascal) return pascal[1];
  return null;
}

/**
 * Build a governed read-only Cypher plan.
 *
 * @param question  the natural-language question from the UI
 * @param limit     row cap applied to derived queries
 * @param explicit  optional explicit Cypher supplied by the caller
 */
export function buildCypher(
  question: string,
  limit: number,
  explicit?: string
): CypherPlan {
  const safeLimit = Math.min(Math.max(limit || 50, 1), 1000);

  /**
   * Final gate for EVERY plan, derived or explicit. Applying it to the derived
   * templates too means a future edit that introduced a write clause would fail
   * here rather than reach the database.
   */
  const guard = (plan: CypherPlan): CypherPlan => {
    if (!isReadOnlyCypher(plan.cypher)) {
      throw new UnsafeCypherError(
        plan.source === "explicit"
          ? "Only read-only Cypher is permitted on the governed query path (write/admin clauses are rejected)."
          : `internal error: derived plan '${plan.source}' is not read-only`
      );
    }
    return plan;
  };

  if (explicit && explicit.trim()) {
    return guard({
      cypher: explicit.trim(),
      params: { limit: safeLimit },
      source: "explicit",
      note: "Caller-supplied read-only Cypher, executed verbatim.",
    });
  }

  const label = extractLabel(question);
  if (label) {
    // Sample nodes of the mentioned label. Parameterizing a label is not
    // supported by Cypher, so the label is validated (alnum only) and inlined.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(label)) {
      throw new UnsafeCypherError(`derived label '${label}' is not a valid identifier`);
    }
    return guard({
      cypher: `MATCH (n:\`${label}\`) RETURN n LIMIT $limit`,
      params: { limit: safeLimit },
      source: "derived-label-sample",
      note: `No explicit Cypher supplied; sampling up to ${safeLimit} :${label} nodes mentioned in the question.`,
    });
  }

  // Fallback: a read-only inventory of labels + counts so the user always gets
  // a meaningful, safe result describing the graph.
  return guard({
    cypher:
      "CALL db.labels() YIELD label " +
      "CALL { WITH label MATCH (n) WHERE label IN labels(n) RETURN count(n) AS count } " +
      "RETURN label, count ORDER BY count DESC LIMIT $limit",
    params: { limit: safeLimit },
    source: "derived-label-inventory",
    note: "No explicit Cypher and no label detected in the question; returning a read-only label inventory with counts.",
  });
}
