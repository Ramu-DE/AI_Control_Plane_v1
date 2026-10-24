// RAG Factory — the control plane's record of a corpus: a tenant-owned,
// approved set of finalized documents, the retrieval pattern chosen for it,
// and every build that turned it into a searchable collection.
//
// The pattern is chosen ONCE PER CORPUS (from its profile) and approved by a
// second person, then executed by the factory at ingest. That replaces the
// factory's own per-query routing, which picked a pattern and then ran dense
// top-k anyway.

export type CorpusStatus =
  | "Draft"
  | "Pending approval"
  | "Rejected"
  | "Building"
  | "Built"
  | "Failed";

/** One finalized document pinned into a corpus, at a specific version. */
export interface CorpusMember {
  documentId: string;
  finalizedDocumentId: string;
  version: number;
  docType: string;
  fileName: string;
}

export interface CorpusProfile {
  docCount: number;
  docTypes: Record<string, number>;
  avgTextChars: number;
  maxTextChars: number;
  avgFields: number;
  docsWithTables: number;
  tableRows: number;
  gxp: boolean;
  regions: string[];
}

export interface CorpusBuildDoc {
  finalizedDocumentId: string;
  version: number;
  status: "ingested" | "failed";
  chunks?: number;
  pointsDeleted?: number;
  error?: string;
}

export interface CorpusBuild {
  buildId: string;
  trigger: "approval" | "rebuild" | "new-version";
  by: string; // personaId
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "partial" | "failed";
  collection: string;
  chunker: string;
  docs: CorpusBuildDoc[];
  error?: string;
}

export interface Corpus {
  corpusId: string; // corp-xxxx
  tenantId: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: CorpusMember[];
  profile: CorpusProfile;
  recommendation: { patternId: string; reasons: string[] };
  patternId: string;
  /** Re-ingest automatically when a member document is finalized as a new version. */
  followNewVersions: boolean;
  status: CorpusStatus;
  submittedBy?: string;
  submittedAt?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  /** Qdrant collection, fixed at first build. */
  collection?: string;
  /** Knowledge Base record registered for agents after the first good build. */
  kbRecordId?: string;
  /** Newer finalized versions of members, not yet in the corpus (followNewVersions off). */
  updatesAvailable: { documentId: string; finalizedDocumentId: string; version: number }[];
  builds: CorpusBuild[]; // newest first, capped
}
