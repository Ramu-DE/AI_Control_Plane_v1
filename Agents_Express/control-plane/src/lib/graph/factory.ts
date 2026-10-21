// Store selection & configuration — fail-closed.
//
// GRAPH_CONTROL_STORE = local | dynamodb   (default: local)
//   local    -> LocalGraphControlStore (in-memory, no AWS, no network)
//   dynamodb -> DynamoDbGraphControlStore; REQUIRES:
//                 GRAPH_CONTROL_TABLE  (table name)
//                 AWS_REGION | AWS_DEFAULT_REGION
//
// Misconfiguration fails CLOSED with a typed error — we never silently fall
// back to a different store. No network calls or table creation happen here;
// the DynamoDB client is created lazily inside the adapter on first use.

import { DynamoDbGraphControlStore } from "./dynamoStore";
import { LocalGraphControlStore } from "./localStore";
import type { GraphControlStore } from "./store";

export type GraphControlStoreKind = "local" | "dynamodb";

export class GraphControlConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GraphControlConfigError";
    this.code = code;
  }
}

export function resolveStoreKind(): GraphControlStoreKind {
  const raw = (process.env.GRAPH_CONTROL_STORE || "").trim().toLowerCase();
  if (raw === "dynamodb") return "dynamodb";
  if (raw === "local" || raw === "") return "local";
  throw new GraphControlConfigError(
    "STORE_UNKNOWN",
    `GRAPH_CONTROL_STORE='${raw}' is not recognized (use 'local' or 'dynamodb').`
  );
}

function resolveRegion(): string {
  const region =
    (process.env.AWS_REGION || "").trim() || (process.env.AWS_DEFAULT_REGION || "").trim();
  if (!region) {
    throw new GraphControlConfigError(
      "REGION_UNSET",
      "dynamodb store requires AWS_REGION or AWS_DEFAULT_REGION (no hardcoded fallback)."
    );
  }
  return region;
}

let _cached: { kind: GraphControlStoreKind; table?: string; region?: string; store: GraphControlStore } | null = null;

/**
 * Return the configured store. Cached per (kind, table, region) so config
 * changes in dev are picked up. Throws GraphControlConfigError on misconfig.
 */
export function getGraphControlStore(): GraphControlStore {
  const kind = resolveStoreKind();

  if (kind === "local") {
    if (!_cached || _cached.kind !== "local") {
      _cached = { kind, store: new LocalGraphControlStore() };
    }
    return _cached.store;
  }

  // dynamodb
  const table = (process.env.GRAPH_CONTROL_TABLE || "").trim();
  if (!table) {
    throw new GraphControlConfigError(
      "TABLE_UNSET",
      "dynamodb store requires GRAPH_CONTROL_TABLE (the DynamoDB table name)."
    );
  }
  const region = resolveRegion();
  if (
    !_cached ||
    _cached.kind !== "dynamodb" ||
    _cached.table !== table ||
    _cached.region !== region
  ) {
    _cached = {
      kind,
      table,
      region,
      store: new DynamoDbGraphControlStore({ tableName: table, region }),
    };
  }
  return _cached.store;
}

/** Test/helper hook to drop the cached store (never used in production flow). */
export function __resetGraphControlStoreCache(): void {
  _cached = null;
}
