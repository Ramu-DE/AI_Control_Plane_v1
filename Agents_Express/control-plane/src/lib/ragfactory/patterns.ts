// Retrieval patterns a corpus can be built with, and how one is recommended.
//
// Each pattern maps to something the factory EXECUTES (its chunker at ingest,
// plus top-k and the query-time behaviour that chunker implies). Patterns the
// factory cannot run end to end are deliberately not offered.
//
// The recommendation is a rule over the corpus profile, with its reasons
// spelled out, so the approver sees why — and can choose another. Pure.

import type { FinalizedDocument } from "../docintel/contract";
import type { CorpusProfile } from "./model";

export interface RagPattern {
  id: string;
  name: string;
  chunker: "fixed_chunking" | "semantic_chunking" | "sentence_window_chunking" | "structured_chunking";
  topK: number;
  bestFor: string;
  howItWorks: string;
}

export const PATTERNS: RagPattern[] = [
  {
    id: "structured-fields",
    name: "Structured fields + tables",
    chunker: "structured_chunking",
    topK: 6,
    bestFor: "Invoices, claims, forms, certificates, batch records",
    howItWorks:
      "Text in 500-character chunks, plus one chunk per group of reviewed fields and per block of table rows (header repeated), so exact values are retrievable on their own.",
  },
  {
    id: "narrative-window",
    name: "Sentence window",
    chunker: "sentence_window_chunking",
    topK: 8,
    bestFor: "Contracts, reports, protocols, SOPs",
    howItWorks:
      "Matches on single sentences, answers from the surrounding ±3 sentences: precise hits without losing context.",
  },
  {
    id: "semantic-sentences",
    name: "Semantic sentences",
    chunker: "semantic_chunking",
    topK: 8,
    bestFor: "Medium-length prose made of distinct statements",
    howItWorks: "One chunk per sentence; many small, focused passages.",
  },
  {
    id: "fixed-baseline",
    name: "Fixed chunks (baseline)",
    chunker: "fixed_chunking",
    topK: 5,
    bestFor: "Short or mixed documents; a predictable default",
    howItWorks: "500-character chunks with 50 characters of overlap.",
  },
];

export function patternById(id: string): RagPattern | undefined {
  return PATTERNS.find((p) => p.id === id);
}

export function profileCorpus(docs: FinalizedDocument[]): CorpusProfile {
  const n = docs.length;
  const docTypes: Record<string, number> = {};
  let textTotal = 0;
  let maxText = 0;
  let fields = 0;
  let withTables = 0;
  let rows = 0;
  const regions = new Set<string>();
  for (const d of docs) {
    docTypes[d.classification.docType] = (docTypes[d.classification.docType] ?? 0) + 1;
    const len = d.content.text.length;
    textTotal += len;
    maxText = Math.max(maxText, len);
    fields += d.content.fields.length;
    if (d.content.tables.length) withTables += 1;
    rows += d.content.tables.reduce((s, t) => s + t.rows.length, 0);
    if (d.classification.region) regions.add(d.classification.region);
  }
  return {
    docCount: n,
    docTypes,
    avgTextChars: n ? Math.round(textTotal / n) : 0,
    maxTextChars: maxText,
    avgFields: n ? Math.round((fields / n) * 10) / 10 : 0,
    docsWithTables: withTables,
    tableRows: rows,
    gxp: docs.some((d) => d.classification.gxp),
    regions: [...regions].sort(),
  };
}

const LONG_TEXT = 8000;
const MEDIUM_TEXT = 2000;

export function recommendPattern(p: CorpusProfile): { patternId: string; reasons: string[] } {
  if (p.docCount === 0) return { patternId: "fixed-baseline", reasons: ["no documents yet"] };
  const tableShare = p.docsWithTables / p.docCount;
  const reasons: string[] = [];
  if ((tableShare >= 0.5 || p.avgFields >= 5) && p.avgTextChars < LONG_TEXT) {
    if (p.avgFields >= 5) reasons.push(`documents carry ${p.avgFields} reviewed fields on average`);
    if (tableShare >= 0.5) reasons.push(`${p.docsWithTables} of ${p.docCount} documents contain tables (${p.tableRows} rows)`);
    reasons.push(`text is short (${p.avgTextChars} characters on average), so the structure carries the facts`);
    return { patternId: "structured-fields", reasons };
  }
  if (p.avgTextChars >= LONG_TEXT) {
    return {
      patternId: "narrative-window",
      reasons: [`long narrative text (${p.avgTextChars} characters on average, up to ${p.maxTextChars})`,
        "answers need the surrounding sentences, not just the matching one"],
    };
  }
  if (p.avgTextChars >= MEDIUM_TEXT) {
    return {
      patternId: "semantic-sentences",
      reasons: [`medium-length prose (${p.avgTextChars} characters on average) with few extracted fields (${p.avgFields})`],
    };
  }
  return {
    patternId: "fixed-baseline",
    reasons: [`short documents (${p.avgTextChars} characters on average) with little structure (${p.avgFields} fields)`],
  };
}

/** Qdrant collection for a corpus: tenant-prefixed, so one tenant's data never shares a collection. */
export function collectionFor(tenantId: string, corpusId: string): string {
  return `cp_${tenantId}_${corpusId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}
