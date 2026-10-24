// Executable-tool registry — the governance gate for tool execution.
//
// A tool is only offered to a model when BOTH are true:
//   1. the platform has an IMPLEMENTATION for that tool name here, and
//   2. the name is exposed by an APPROVED registry record attached to the agent.
//
// So the Registry stays the source of truth for *what an agent may use*, and
// this module is the source of truth for *what the platform can actually run*.
// A name that is approved but unimplemented is reported, never silently
// ignored, and never faked.

import { UcToolError, ucDescribeTable, ucListTables, ucQuery } from "./uc";
import { deriveOntology, deriveProposals } from "../kg/derive";
import { queryGraphAsAgent } from "../graph/query";

/** JSON-Schema-shaped parameter spec, as the model APIs expect. */
export interface ToolParameters {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

/**
 * Who a tool call runs for. UC tools ignore it (the platform credential is
 * shared and bounded by DATABRICKS_UC_ALLOWED_SCOPES); tools that authorize per
 * caller — graph_query — refuse to run without it.
 */
export interface ToolContext {
  personaId: string;
  tenantId: string;
  agentId?: string;
  origin: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** Execute the tool. Returns a JSON-serializable result. */
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
}

/** A tool context is only a graph caller when it names an agent. */
function graphCaller(ctx: ToolContext | undefined) {
  return ctx && ctx.agentId
    ? { personaId: ctx.personaId, tenantId: ctx.tenantId, agentId: ctx.agentId, origin: ctx.origin }
    : undefined;
}

// Label and relationship-type inventory, so a model writes Cypher against the
// graph that exists rather than one it imagines.
const GRAPH_SCHEMA_CYPHER =
  "MATCH (n) UNWIND labels(n) AS name RETURN 'node' AS kind, name, count(*) AS count " +
  "UNION ALL " +
  "MATCH ()-[r]->() RETURN 'relationship' AS kind, type(r) AS name, count(*) AS count";
// The same inventory for an RDF source: classes and predicates with counts.
// Scoped to the source's graphs by planSparql, like every SPARQL query.
const GRAPH_SCHEMA_SPARQL =
  "SELECT ?kind ?name (COUNT(*) AS ?count) WHERE { " +
  "{ ?s a ?name BIND('class' AS ?kind) } UNION " +
  "{ ?s ?name ?o FILTER(?name != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>) " +
  "BIND('predicate' AS ?kind) } } GROUP BY ?kind ?name ORDER BY ?kind ?name";

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new UcToolError(`missing required string argument '${key}'`);
  }
  return v.trim();
}

/** Every tool the platform can really execute, keyed by the name a model calls. */
export const TOOL_IMPLEMENTATIONS: Record<string, ToolSpec> = {
  uc_list_tables: {
    name: "uc_list_tables",
    description:
      "List the tables in a Unity Catalog schema, with their type and column names.",
    parameters: {
      type: "object",
      properties: {
        catalog: { type: "string", description: "Unity Catalog catalog name, e.g. workspace" },
        schema: { type: "string", description: "Schema name, e.g. default" },
      },
      required: ["catalog", "schema"],
    },
    execute: (args) => ucListTables(str(args, "catalog"), str(args, "schema")),
  },
  uc_describe_table: {
    name: "uc_describe_table",
    description:
      "Describe one Unity Catalog table: its columns, types, nullability and comment.",
    parameters: {
      type: "object",
      properties: {
        full_name: {
          type: "string",
          description: "Three-part name: catalog.schema.table",
        },
      },
      required: ["full_name"],
    },
    execute: (args) => ucDescribeTable(str(args, "full_name")),
  },
  kg_derive_ontology: {
    name: "kg_derive_ontology",
    description:
      "Inspect Unity Catalog metadata and derive a candidate ontology: classes (tables), " +
      "properties (columns) and relationships (id-shaped columns that match another table's " +
      "key). Read-only — it proposes, it does not build anything.",
    parameters: {
      type: "object",
      properties: {
        catalog: { type: "string", description: "UC catalog, e.g. workspace" },
        schema: { type: "string", description: "UC schema, e.g. default" },
        table_prefix: {
          type: "string",
          description: "Optional prefix limiting which tables become classes",
        },
      },
      required: ["catalog", "schema"],
    },
    execute: async (args) => {
      const catalog = str(args, "catalog");
      const schema = str(args, "schema");
      const prefix = typeof args.table_prefix === "string" ? args.table_prefix : undefined;
      const listed = await ucListTables(catalog, schema);
      const ontology = deriveOntology(listed.tables, { tableFilter: prefix });
      const proposals = deriveProposals(ontology);
      // Return a COMPACT summary: a full ontology would blow the context window.
      return {
        catalog,
        schema,
        tablesSeen: listed.tableCount,
        classes: ontology.classes.map((c) => ({
          label: c.label,
          table: c.table,
          subjectColumns: c.subjectColumns,
          propertyCount: c.columns.length,
        })),
        relationships: ontology.relationships.map((r) => ({
          label: r.label,
          from: r.fromTable,
          fromColumn: r.fromColumn,
          to: r.toTable,
        })),
        proposalCount: proposals.length,
        blockedCount: proposals.filter((p) =>
          p.issues.some((i) => i.severity === "blocking" || i.severity === "error")
        ).length,
      };
    },
  },
  uc_query: {
    name: "uc_query",
    description:
      "Run ONE read-only SQL statement (SELECT/SHOW/DESCRIBE/WITH/EXPLAIN) against Unity " +
      "Catalog and return the rows. Writes and DDL are rejected.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single read-only SQL statement" },
      },
      required: ["sql"],
    },
    execute: (args) => ucQuery(str(args, "sql")),
  },
  graph_schema: {
    name: "graph_schema",
    description:
      "List what an approved Graph Source contains: node labels and relationship types " +
      "(Neo4j) or classes and predicates with full IRIs (Neptune), with counts. Call this " +
      "first so queries use real names.",
    parameters: {
      type: "object",
      properties: {
        graph_source_id: { type: "string", description: "Graph Source id, e.g. biomedical" },
      },
      required: ["graph_source_id"],
    },
    execute: (args, ctx) =>
      queryGraphAsAgent(
        {
          graphSourceId: str(args, "graph_source_id"),
          cypher: GRAPH_SCHEMA_CYPHER,
          sparql: GRAPH_SCHEMA_SPARQL,
          limit: 100,
        },
        graphCaller(ctx)
      ),
  },
  graph_sparql: {
    name: "graph_sparql",
    description:
      "Run ONE read-only SPARQL SELECT or ASK against an approved Neptune (RDF) Graph Source " +
      "and return the bindings. The query is automatically scoped to that source's graphs, so " +
      "do not use FROM, GRAPH or SERVICE; updates are rejected. Use full IRIs or PREFIX " +
      "declarations from graph_schema. Access is checked for this agent, persona and tenant.",
    parameters: {
      type: "object",
      properties: {
        graph_source_id: { type: "string", description: "Graph Source id, e.g. scm-kg-rdf" },
        sparql: { type: "string", description: "A single SPARQL SELECT or ASK query" },
        limit: { type: "number", description: "Maximum rows (1-100, default 25)" },
      },
      required: ["graph_source_id", "sparql"],
    },
    execute: (args, ctx) =>
      queryGraphAsAgent(
        {
          graphSourceId: str(args, "graph_source_id"),
          sparql: str(args, "sparql"),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        },
        graphCaller(ctx)
      ),
  },
  graph_query: {
    name: "graph_query",
    description:
      "Run ONE read-only Cypher query (MATCH/RETURN; use $limit for LIMIT) against an approved " +
      "Neo4j Graph Source and return the rows. Writes, procedures that modify data and admin " +
      "commands are rejected. Access is checked for this agent, persona and tenant.",
    parameters: {
      type: "object",
      properties: {
        graph_source_id: { type: "string", description: "Graph Source id, e.g. biomedical" },
        cypher: { type: "string", description: "A single read-only Cypher statement" },
        limit: { type: "number", description: "Maximum rows (1-100, default 25)" },
      },
      required: ["graph_source_id", "cypher"],
    },
    execute: (args, ctx) =>
      queryGraphAsAgent(
        {
          graphSourceId: str(args, "graph_source_id"),
          cypher: str(args, "cypher"),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        },
        graphCaller(ctx)
      ),
  },
};

export function isImplemented(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_IMPLEMENTATIONS, name);
}

export interface ToolSelection {
  /** Tools that are both approved and implemented — offered to the model. */
  available: ToolSpec[];
  /** Approved names with no implementation — reported, never faked. */
  unimplemented: string[];
}

/**
 * Narrow a set of approved tool names down to what the platform can execute.
 * Pure (no I/O) so step resolution stays testable.
 */
export function selectTools(approvedNames: string[]): ToolSelection {
  const available: ToolSpec[] = [];
  const unimplemented: string[] = [];
  const seen = new Set<string>();
  for (const name of approvedNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (isImplemented(name)) available.push(TOOL_IMPLEMENTATIONS[name]);
    else unimplemented.push(name);
  }
  return { available, unimplemented };
}

/** Render the OpenAI-compatible `tools` array sent to a serving endpoint. */
export function toOpenAiTools(specs: ToolSpec[]): Record<string, unknown>[] {
  return specs.map((s) => ({
    type: "function",
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  /** Truncated, JSON-stringified result or error — safe for a run record. */
  resultPreview: string;
  latencyMs: number;
}

const PREVIEW_CHARS = 600;

/**
 * Execute one model-requested tool call. Never throws: a tool failure is
 * returned to the model as an error payload so it can respond honestly rather
 * than the whole step collapsing.
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
  offered?: ToolSpec[]
): Promise<{ record: ToolCallRecord; payload: unknown }> {
  const started = Date.now();
  // A model can name any tool, not just the ones it was offered. Without this
  // check an implemented-but-unapproved tool would run because it exists.
  const notOffered = offered !== undefined && !offered.some((t) => t.name === name);
  const spec = notOffered ? undefined : TOOL_IMPLEMENTATIONS[name];
  if (!spec) {
    const payload = {
      error: notOffered
        ? `tool '${name}' was not offered to this step`
        : `tool '${name}' is not implemented by this platform`,
    };
    return {
      record: {
        name,
        arguments: args,
        ok: false,
        resultPreview: JSON.stringify(payload),
        latencyMs: 0,
      },
      payload,
    };
  }
  try {
    const payload = await spec.execute(args, ctx);
    const json = JSON.stringify(payload);
    return {
      record: {
        name,
        arguments: args,
        ok: true,
        resultPreview: json.slice(0, PREVIEW_CHARS),
        latencyMs: Date.now() - started,
      },
      payload,
    };
  } catch (e) {
    const payload = { error: (e as Error).message };
    return {
      record: {
        name,
        arguments: args,
        ok: false,
        resultPreview: JSON.stringify(payload).slice(0, PREVIEW_CHARS),
        latencyMs: Date.now() - started,
      },
      payload,
    };
  }
}
