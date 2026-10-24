// Graph Source build specs — the answer to "where does THIS source's knowledge
// graph come from?".
//
// Without one, the Knowledge Graph page built whatever Unity Catalog location
// was typed into its form, into whichever database was selected: choosing the
// BioMedical source wrote a contracts graph from UC demo tables into the
// BioMedical database. The spec moves that decision onto the source, where it
// is governed (only a tenant admin may set it) and visible, and the page simply
// follows it.

import type { GraphSource, KgSpec } from "../graph/entities";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE = new Set(["gxp-strict", "standard", "exploratory"]);

/** Validate a spec. Returns an error message, or null. */
export function validateKgSpec(spec: unknown, source: Pick<GraphSource, "backend">): string | null {
  const s = spec as KgSpec;
  if (!s || typeof s !== "object") return "kgSpec is required";
  if (s.mode === "native") {
    if (source.backend.type !== "neo4j") return "native mode is for Neo4j sources";
    if (!Array.isArray(s.labels) || s.labels.length === 0) {
      return "native mode needs the node labels that make up this source (scopes Explore)";
    }
    const bad = s.labels.filter((l) => !IDENT.test(l));
    return bad.length ? `labels must be plain identifiers: ${bad.join(", ")}` : null;
  }
  if (s.mode === "ontology-first") {
    if (source.backend.type !== "neo4j" && source.backend.type !== "neptune") {
      return "ontology-first builds target Neo4j or Neptune sources";
    }
    // The ontology must be a file graph-utility ships — never an arbitrary path.
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(ttl|owl|rdf|nt)$/.test(s.ontology ?? "")) {
      return "ontology must be a relative path under graph-utility/ontologies/ (e.g. takeda/rnd-clinical.ttl)";
    }
    if (!/^https?:\/\/\S+[#/]$/.test(s.namespace ?? "")) return "namespace must be an IRI ending in # or /";
    if (!PROFILE.has(s.approvalProfile)) return `approvalProfile must be one of ${[...PROFILE].join(", ")}`;
    const d = s.dataset;
    if (d?.kind === "uc") {
      if (!IDENT.test(d.catalog ?? "") || !IDENT.test(d.schema ?? "")) return "dataset catalog/schema must be identifiers";
      if (d.tableFilter && !IDENT.test(d.tableFilter)) return "tableFilter must be an identifier prefix";
    } else if (d?.kind === "csv") {
      if (!/^[A-Za-z0-9_/.-]+$/.test(d.dir ?? "") || d.dir.includes("..")) return "csv dir must be a plain path";
    } else {
      return "dataset.kind must be 'uc' or 'csv'";
    }
    return null;
  }
  if (s.mode === "derived") {
    if (source.backend.type !== "neo4j") return "derived mode writes to Neo4j sources";
    if (!IDENT.test(s.catalog ?? "") || !IDENT.test(s.schema ?? "")) return "catalog/schema must be identifiers";
    if (s.tableFilter && !IDENT.test(s.tableFilter)) return "tableFilter must be an identifier prefix";
    return null;
  }
  return "mode must be 'native', 'ontology-first' or 'derived'";
}

/** One line for the UI: where this source's graph comes from. */
export function describeKgSpec(spec: KgSpec | undefined): string {
  if (!spec) return "No build spec — set one to build or explore this source.";
  if (spec.mode === "native") return `Native graph: data loaded by its own pipeline (labels ${spec.labels.join(", ")}).`;
  if (spec.mode === "derived") {
    return `Derived from Unity Catalog metadata of ${spec.catalog}.${spec.schema}` +
      (spec.tableFilter ? ` (tables ${spec.tableFilter}*)` : "") + ".";
  }
  const d = spec.dataset;
  const ds = d.kind === "uc" ? `${d.catalog}.${d.schema}${d.tableFilter ? ` (${d.tableFilter}*)` : ""}` : `CSV ${d.dir}`;
  return `Ontology-first: ${spec.ontology} over ${ds}, profile ${spec.approvalProfile}.`;
}
