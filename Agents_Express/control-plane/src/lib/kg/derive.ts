// Derive an ontology + mapping proposals from live Unity Catalog metadata.
//
// WHY THIS EXISTS: graph-utility's precision path needs an ontology to propose
// mappings against, but the only configured ontology source (Neptune) is a
// placeholder. Unity Catalog IS live, so we derive the ontology from real table
// metadata instead of inventing one.
//
// The rules mirror graph-utility's `propose_mappings` discipline exactly:
//   - a table becomes a candidate CLASS
//   - a column becomes a candidate DATATYPE PROPERTY
//   - a column that looks like a foreign key becomes a candidate RELATIONSHIP,
//     and only when the referenced table actually exists
//   - name similarity may PROPOSE, never approve: every proposal starts
//     `proposed`, carries evidence + confidence, and is capped below any
//     auto-approve threshold
//
// Pure and deterministic — no I/O, so the derivation logic is fully testable.

import type { MappingEvidence, MappingIssue, ProposalKind } from "../graph/entities";

/** A table as Unity Catalog reports it (see lib/tools/uc.ts `ucListTables`). */
export interface UcTableMeta {
  fullName: string;
  tableType: string;
  comment?: string;
  /** "name:TYPE" pairs, as the UC tool returns them. */
  columns: string[];
}

export interface OntologyColumn {
  name: string;
  datatype: string;
}

/** A derived ontology class — one per table. */
export interface OntologyClass {
  uri: string;
  label: string;
  table: string;
  comment?: string;
  columns: OntologyColumn[];
  /** Column(s) that identify a row. Derived by shape, never assumed. */
  subjectColumns: string[];
}

/** A derived relationship between two classes. */
export interface OntologyRelationship {
  uri: string;
  label: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface DerivedOntology {
  namespace: string;
  classes: OntologyClass[];
  relationships: OntologyRelationship[];
}

/** Name-similarity confidence is capped well below any approval threshold. */
export const NAME_ONLY_MAX_CONFIDENCE = 0.5;
/** A relationship backed by a real referenced table + key column scores higher. */
export const KEY_EVIDENCE_CONFIDENCE = 0.7;

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

function tableName(fullName: string): string {
  const parts = fullName.split(".");
  return parts[parts.length - 1] || fullName;
}

/** snake_case / prefixed table name -> PascalCase class label. */
export function toClassLabel(table: string, stripPrefix?: string): string {
  let base = table;
  if (stripPrefix && base.startsWith(stripPrefix)) base = base.slice(stripPrefix.length);
  base = base.replace(/^_+/, "");
  const singular = base.replace(/ies$/, "y").replace(/s$/, "");
  return singular
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

/** snake_case column -> camelCase property label. */
export function toPropertyLabel(column: string): string {
  const parts = column.split(/[_\s]+/).filter(Boolean);
  if (parts.length === 0) return column;
  return (
    parts[0].toLowerCase() +
    parts
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join("")
  );
}

export function parseColumns(columns: string[]): OntologyColumn[] {
  const out: OntologyColumn[] = [];
  for (const raw of columns) {
    const idx = raw.lastIndexOf(":");
    if (idx <= 0) continue;
    out.push({ name: raw.slice(0, idx), datatype: raw.slice(idx + 1) });
  }
  return out;
}

/** Columns that identify a row, by shape only (`<table_singular>_id`, or `id`). */
export function deriveSubjectColumns(table: string, columns: OntologyColumn[]): string[] {
  const names = columns.map((c) => c.name);
  const singular = tableName(table).replace(/^.*?_/, "").replace(/ies$/, "y").replace(/s$/, "");
  const preferred = [`${singular}_id`, `${tableName(table)}_id`, "id"];
  for (const p of preferred) {
    const hit = names.find((n) => n.toLowerCase() === p.toLowerCase());
    if (hit) return [hit];
  }
  // Fall back to the first *_id column; if none, the class has no stable key.
  const anyId = names.find((n) => /(^|_)id$/i.test(n));
  return anyId ? [anyId] : [];
}

/**
 * Is this column a candidate foreign key, and to which table?
 *
 * Shape rule: `<something>_id` where a table exists whose own subject column is
 * exactly that name. Requiring the TARGET to actually declare the column is
 * what keeps this from inventing joins.
 */
export function candidateForeignKey(
  column: OntologyColumn,
  ownTable: string,
  classes: OntologyClass[]
): { toTable: string; toColumn: string } | null {
  if (!/(^|_)id$/i.test(column.name)) return null;
  for (const cls of classes) {
    if (cls.table === ownTable) continue;
    if (cls.subjectColumns.length === 0) continue;
    if (cls.subjectColumns[0].toLowerCase() === column.name.toLowerCase()) {
      return { toTable: cls.table, toColumn: cls.subjectColumns[0] };
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Derivation
// --------------------------------------------------------------------------- //

export interface DeriveOptions {
  namespace?: string;
  /** Prefix stripped from table names when building class labels. */
  stripPrefix?: string;
  /** Only consider tables starting with this prefix. */
  tableFilter?: string;
}

/** Build the ontology from UC table metadata. Pure. */
export function deriveOntology(
  tables: UcTableMeta[],
  opts: DeriveOptions = {}
): DerivedOntology {
  const namespace = opts.namespace || "http://agentexpress.local/ontology/uc#";
  const considered = opts.tableFilter
    ? tables.filter((t) => tableName(t.fullName).startsWith(opts.tableFilter!))
    : tables;

  const classes: OntologyClass[] = considered.map((t) => {
    const columns = parseColumns(t.columns);
    const short = tableName(t.fullName);
    const label = toClassLabel(short, opts.stripPrefix);
    return {
      uri: `${namespace}${label}`,
      label,
      table: t.fullName,
      ...(t.comment ? { comment: t.comment } : {}),
      columns,
      subjectColumns: deriveSubjectColumns(t.fullName, columns),
    };
  });

  const relationships: OntologyRelationship[] = [];
  for (const cls of classes) {
    for (const col of cls.columns) {
      // A class's own subject column is its identity, not a reference.
      if (cls.subjectColumns.includes(col.name)) continue;
      const fk = candidateForeignKey(col, cls.table, classes);
      if (!fk) continue;
      const target = classes.find((c) => c.table === fk.toTable)!;
      const label = `has${target.label}`;
      relationships.push({
        uri: `${namespace}${label}`,
        label,
        fromTable: cls.table,
        fromColumn: col.name,
        toTable: fk.toTable,
        toColumn: fk.toColumn,
      });
    }
  }

  return { namespace, classes, relationships };
}

// --------------------------------------------------------------------------- //
// Mapping proposals (control-plane shape — see lib/graph/entities.ts)
// --------------------------------------------------------------------------- //

export interface DerivedProposal {
  ontologyUri: string;
  ontologyLabel: string;
  entityType: "class" | "property";
  proposalKind: ProposalKind;
  ontologyType: string;
  ucCatalog?: string;
  ucSchema?: string;
  ucTable?: string;
  ucColumn?: string | null;
  dataType?: string | null;
  logicalType?: string;
  subjectColumns?: string[];
  join?: {
    leftTable: string;
    leftColumns: string[];
    rightTable: string;
    rightColumns: string[];
    cardinality: "many-to-one";
    origin: "discovered";
    name: string;
  };
  confidence: number;
  evidence: MappingEvidence[];
  issues: MappingIssue[];
}

function splitFullName(fullName: string): { catalog?: string; schema?: string; table: string } {
  const p = fullName.split(".");
  if (p.length === 3) return { catalog: p[0], schema: p[1], table: p[2] };
  return { table: fullName };
}

/**
 * Turn the derived ontology into reviewable proposals.
 *
 * Every proposal starts PROPOSED with a `name-similarity-only` warning where
 * that is all the evidence there is — so the existing approval gate still
 * decides, and nothing is materialised without a human decision.
 */
export function deriveProposals(ontology: DerivedOntology): DerivedProposal[] {
  const out: DerivedProposal[] = [];

  for (const cls of ontology.classes) {
    const parts = splitFullName(cls.table);
    const evidence: MappingEvidence[] = [
      {
        kind: "name-similarity",
        detail: `table '${parts.table}' -> class '${cls.label}'`,
        weight: NAME_ONLY_MAX_CONFIDENCE,
      },
    ];
    const issues: MappingIssue[] = [
      {
        severity: "warning",
        code: "name-similarity-only",
        message: "class derived from the table name alone; requires review",
      },
    ];
    if (cls.comment) {
      evidence.push({ kind: "ontology-label", detail: `table comment: ${cls.comment}`, weight: 0.1 });
    }
    if (cls.subjectColumns.length > 0) {
      evidence.push({
        kind: "key-metadata",
        detail: `subject key ${JSON.stringify(cls.subjectColumns)} derived by shape`,
        weight: 0.2,
      });
    } else {
      // Without a key we cannot mint stable IRIs — block it, do not guess.
      issues.push({
        severity: "blocking",
        code: "no-subject-key",
        message: `table '${parts.table}' has no id-shaped column; cannot mint stable subject IRIs`,
      });
    }

    out.push({
      ontologyUri: cls.uri,
      ontologyLabel: cls.label,
      entityType: "class",
      proposalKind: "class",
      ontologyType: "class",
      ucCatalog: parts.catalog,
      ucSchema: parts.schema,
      ucTable: parts.table,
      ucColumn: null,
      subjectColumns: cls.subjectColumns,
      confidence: cls.subjectColumns.length > 0 ? NAME_ONLY_MAX_CONFIDENCE : 0.2,
      evidence,
      issues,
    });

    for (const col of cls.columns) {
      const label = toPropertyLabel(col.name);
      out.push({
        ontologyUri: `${ontology.namespace}${label}`,
        ontologyLabel: label,
        entityType: "property",
        proposalKind: "direct",
        ontologyType: "datatype-property",
        ucCatalog: parts.catalog,
        ucSchema: parts.schema,
        ucTable: parts.table,
        ucColumn: col.name,
        dataType: col.datatype,
        logicalType: col.datatype.toLowerCase(),
        confidence: NAME_ONLY_MAX_CONFIDENCE,
        evidence: [
          {
            kind: "name-similarity",
            detail: `column '${col.name}' -> property '${label}'`,
            weight: NAME_ONLY_MAX_CONFIDENCE,
          },
          { kind: "data-type", detail: `declared type ${col.datatype}`, weight: 0.2 },
        ],
        issues: [
          {
            severity: "warning",
            code: "name-similarity-only",
            message: "property derived from the column name alone; requires review",
          },
        ],
      });
    }
  }

  for (const rel of ontology.relationships) {
    const from = splitFullName(rel.fromTable);
    out.push({
      ontologyUri: rel.uri,
      ontologyLabel: rel.label,
      entityType: "property",
      proposalKind: "relationship",
      ontologyType: "object-property",
      ucCatalog: from.catalog,
      ucSchema: from.schema,
      ucTable: from.table,
      ucColumn: rel.fromColumn,
      join: {
        leftTable: rel.fromTable,
        leftColumns: [rel.fromColumn],
        rightTable: rel.toTable,
        rightColumns: [rel.toColumn],
        cardinality: "many-to-one",
        origin: "discovered",
        name: rel.label,
      },
      confidence: KEY_EVIDENCE_CONFIDENCE,
      evidence: [
        {
          kind: "key-metadata",
          detail:
            `'${rel.fromColumn}' matches the subject key of '${splitFullName(rel.toTable).table}'`,
          weight: 0.5,
        },
        { kind: "ontology-relationship", detail: `${rel.fromTable} -> ${rel.toTable}`, weight: 0.2 },
      ],
      issues: [],
    });
  }

  return out;
}
