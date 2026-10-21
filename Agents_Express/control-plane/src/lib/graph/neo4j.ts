// Server-only Neo4j (Bolt) execution module.
//
// Runs Cypher DIRECTLY against a Neo4j / Aura database via the official
// neo4j-driver. This is the "real execution" seam for GraphSources whose
// backend.type === "neo4j": there is no external HTTP serving endpoint — the
// control plane evaluates policy, then opens a short-lived Bolt session and
// executes read-only Cypher.
//
// Security posture:
//  - NEVER import this from client code. It reads credentials and opens egress.
//  - Credentials are referenced, never stored: the password/token is resolved
//    at runtime from a SecretRef.envVar (or the NEO4J_PASSWORD fallback). The
//    GraphSource record only persists the URI / database / username.
//  - The Bolt URI host is validated against the same private/metadata SSRF
//    denylist used for https targets, and (when provided) an allowlist.
//  - Queries run in an explicit READ transaction with a row cap and timeout so
//    a governed "ask this graph" request can never mutate data.

import neo4j, { Driver, Neo4jError } from "neo4j-driver";
import type { Neo4jBackend } from "./entities";

// Bolt schemes the driver understands. `+s`/`+ssc` enable TLS (Aura requires it).
const BOLT_SCHEMES = new Set(["neo4j", "neo4j+s", "neo4j+ssc", "bolt", "bolt+s", "bolt+ssc"]);

/** Reuse the https SSRF denylist semantics for Bolt hosts. */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./, // link-local incl. 169.254.169.254 (cloud metadata)
  /^::1$/,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

export interface BoltUrlPolicyResult {
  ok: boolean;
  reason?: string;
  placeholder?: boolean;
}

/**
 * Validate a Bolt URI: must use a bolt/neo4j scheme, must not point at a
 * private/loopback/metadata host, and (when an allowlist is supplied) the host
 * must be allowlisted. Placeholder URIs (REPLACE-ME) are reported so callers
 * can treat the source as "preview-only / not configured".
 */
export function validateBoltUri(value: string, allowedHosts?: string[]): BoltUrlPolicyResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "not a valid URI" };
  }
  // URL keeps the trailing ':' on protocol.
  const scheme = url.protocol.replace(/:$/, "");
  if (!BOLT_SCHEMES.has(scheme)) {
    return { ok: false, reason: `URI must use a bolt/neo4j scheme (got '${scheme}')` };
  }
  const host = url.hostname;
  if (host.toUpperCase().includes("REPLACE-ME")) {
    return { ok: false, reason: "placeholder host", placeholder: true };
  }
  for (const pat of PRIVATE_HOST_PATTERNS) {
    if (pat.test(host)) {
      return { ok: false, reason: `host '${host}' is not a permitted (private/metadata) address` };
    }
  }
  if (allowedHosts && allowedHosts.length > 0) {
    const normalized = host.toLowerCase();
    const allowed = allowedHosts.some((h) => {
      const a = h.trim().toLowerCase();
      return a && (normalized === a || normalized.endsWith(`.${a}`));
    });
    if (!allowed) return { ok: false, reason: `host '${host}' is not in the allowlist` };
  }
  return { ok: true };
}

/** True when the backend's Bolt URI is HTTPS/TLS-able, configured, SSRF-safe. */
export function isConfiguredBoltUri(value: string, allowedHosts?: string[]): boolean {
  if (!value) return false;
  return validateBoltUri(value, allowedHosts).ok;
}

/**
 * Resolve the Neo4j password at runtime. Precedence:
 *   1. backend.authSecret.envVar  (explicit per-source env var)
 *   2. NEO4J_PASSWORD             (platform default)
 * The secret value is read ONLY here and never returned to callers/UI.
 */
export function resolveNeo4jPassword(backend: Neo4jBackend): string | null {
  const envVar = backend.authSecret?.envVar;
  if (envVar && process.env[envVar]) return process.env[envVar] as string;
  if (process.env.NEO4J_PASSWORD) return process.env.NEO4J_PASSWORD;
  return null;
}

/**
 * Convert top-level params that are SAFE WHOLE NUMBERS into Neo4j integers.
 * Cypher's LIMIT/SKIP (and integer-typed properties) require a true INTEGER;
 * with `disableLosslessIntegers` a plain JS number serializes as a FLOAT, which
 * Neo4j rejects for those positions. Non-integer numbers and other types are
 * passed through unchanged. Shallow by design — nested params should be typed
 * explicitly by the caller.
 */
function coerceIntegerParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === "number" && Number.isInteger(v) ? neo4j.int(v) : v;
  }
  return out;
}

function makeDriver(backend: Neo4jBackend, password: string): Driver {
  return neo4j.driver(backend.uri, neo4j.auth.basic(backend.username, password), {
    // Bounded pool + connection acquisition so a stuck DB can't hang the route.
    maxConnectionPoolSize: 10,
    connectionAcquisitionTimeout: 10_000,
    connectionTimeout: 10_000,
    disableLosslessIntegers: true, // return plain JS numbers, not Integer objects
  });
}

export interface Neo4jQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  server?: { address?: string; agent?: string };
}

/**
 * Open a short-lived driver, run a READ-only Cypher query with parameters, and
 * return capped rows. The caller is responsible for policy evaluation BEFORE
 * invoking this — this function performs the egress only.
 */
export async function runReadQuery(
  backend: Neo4jBackend,
  cypher: string,
  params: Record<string, unknown> = {},
  opts: { limit?: number; timeoutMs?: number } = {}
): Promise<Neo4jQueryResult> {
  const password = resolveNeo4jPassword(backend);
  if (!password) {
    throw new Error("Neo4j password is not configured (set backend.authSecret.envVar or NEO4J_PASSWORD)");
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 20_000, 1_000), 30_000);

  const driver = makeDriver(backend, password);
  try {
    const session = driver.session({
      database: backend.database,
      defaultAccessMode: neo4j.session.READ, // fail closed: no writes on the query path
    });
    try {
      // Cypher's LIMIT/SKIP require a true INTEGER. With disableLosslessIntegers
      // a plain JS number is sent as a FLOAT (10 -> 10.0) which Neo4j rejects,
      // so coerce whole-number params to neo4j integers.
      const coerced = coerceIntegerParams(params);
      const result = await session.executeRead(
        (tx) => tx.run(cypher, coerced),
        { timeout: timeoutMs }
      );
      const records = result.records.slice(0, limit);
      const columns = result.records.length > 0 ? result.records[0].keys.map(String) : [];
      const rows = records.map((rec) => {
        const obj: Record<string, unknown> = {};
        for (const key of rec.keys) obj[String(key)] = rec.get(key);
        return obj;
      });
      return {
        columns,
        rows,
        rowCount: rows.length,
        server: {
          address: result.summary.server.address,
          agent: result.summary.server.agent,
        },
      };
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

/** Verify the database is reachable + authenticated. Returns server identity. */
export async function verifyNeo4j(backend: Neo4jBackend): Promise<{ address?: string; version?: string; edition?: string }> {
  const password = resolveNeo4jPassword(backend);
  if (!password) throw new Error("Neo4j password is not configured");
  const driver = makeDriver(backend, password);
  try {
    await driver.verifyConnectivity();
    const session = driver.session({ database: backend.database, defaultAccessMode: neo4j.session.READ });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          "CALL dbms.components() YIELD name, versions, edition RETURN versions[0] AS version, edition LIMIT 1"
        )
      );
      const rec = res.records[0];
      return {
        address: res.summary.server.address,
        version: rec?.get("version"),
        edition: rec?.get("edition"),
      };
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

/** Narrow a thrown error to a Neo4j driver error for friendlier messages. */
export function isNeo4jError(e: unknown): e is Neo4jError {
  return e instanceof Neo4jError;
}
