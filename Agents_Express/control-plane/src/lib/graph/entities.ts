// Graph control-plane domain entities.
//
// These model the GOVERNANCE lifecycle that sits in front of graph-utility's
// build plane. graph-utility derives mapping rows from an ontology; the control
// plane turns those rows into reviewable MappingProposals, records human
// ApprovalDecisions, and — only when every included proposal is approved and
// valid — publishes an immutable MappingVersion (an artifact reference, never
// the data itself).
//
// Secrets are NEVER stored here. Only *references* (secret ARNs, role ARNs,
// connection ids) are persisted. See ConnectionRef / SecretRef below.

import type { RecordStatus } from "../types";

export type ISO = string;

// --------------------------------------------------------------------------- //
// Connection / secret references (never raw credentials)
// --------------------------------------------------------------------------- //

/**
 * A reference to a secret held elsewhere (Secrets Manager / SSM / env). We
 * persist only the pointer, never the material. Exactly one locator is set.
 */
export interface SecretRef {
  /** AWS Secrets Manager secret ARN or name. */
  secretArn?: string;
  /** SSM Parameter Store name (SecureString). */
  ssmParameter?: string;
  /** Name of an environment variable resolved at runtime. */
  envVar?: string;
  /** Optional JSON key within the secret payload. */
  jsonKey?: string;
}

/**
 * A reference to an outbound connection. Auth is by reference only:
 *  - sigv4-assume-role -> roleArn (STS AssumeRole at runtime)
 *  - secret-ref        -> secretRef (bearer/token resolved at runtime)
 *  - none              -> no credential
 */
export interface ConnectionRef {
  id: string;
  kind: "sigv4-assume-role" | "secret-ref" | "none";
  roleArn?: string;
  secretRef?: SecretRef;
  /** Free-form, non-secret description (e.g. "Databricks workspace US"). */
  description?: string;
}

/** Scope of assets a graph source may touch (additive, backward-compatible). */
export interface AssetScope {
  /** Allowed catalogs (Unity Catalog, warehouse, etc.). */
  catalogs?: string[];
  /** Allowed schemas, fully or partially qualified. */
  schemas?: string[];
  /** Allowed tables. */
  tables?: string[];
  /** Allowed vector indexes/collections. */
  vectorIndexes?: string[];
}

// --------------------------------------------------------------------------- //
// GraphSource (control-plane persisted shape)
// --------------------------------------------------------------------------- //

export interface GraphSourceOntology {
  type: "neptune";
  sparqlUrl: string;
  graphUri: string;
  namespace: string;
  auth?: "sigv4-assume-role";
  roleArn?: string;
  region?: string;
}

export interface GraphSourceBackend {
  type: "databricks-uc";
  catalog: string;
  schema: string;
  registryTable: string;
  /**
   * Legacy single-join-key seam for the databricks-uc query engine ONLY.
   * The precision build/plan path (graph-utility) derives joins from
   * DISCOVERED keys per relationship and does NOT use this field, so it is
   * OPTIONAL and must never default to another tenant's join key.
   */
  universalJoinKey?: string;
  vectorIndex?: string;
  vectorEndpoint?: string;
}

/**
 * The persisted GraphSource entity. A superset of the legacy GraphSourceRecord
 * shape: all legacy fields are kept so existing readers keep working, and the
 * new governance/connection fields are OPTIONAL (additive).
 */
export interface GraphSource {
  graphSourceId: string;
  bu: string;
  displayName: string;
  description: string;
  ontology: GraphSourceOntology;
  backend: GraphSourceBackend;
  llmEndpoint: string;
  queryEngineUrl: string;
  tags: Record<string, string>;
  version: string;
  status: RecordStatus;
  owner: string;
  createdAt: ISO;
  updatedAt: ISO;

  // --- additive, backward-compatible governance/connection fields ---
  /** Multi-tenant partition (defaults to the source's `bu` when unset). */
  tenantId?: string;
  /** Connection references for ontology/backend/serving (auth by reference). */
  connections?: ConnectionRef[];
  /** The set of data assets this source is permitted to read. */
  assetScope?: AssetScope;
  /** Allowlist of hosts permitted for outbound serving/ontology URLs. */
  allowedHosts?: string[];
  /** Optimistic-concurrency token; bumped on every write. */
  rev?: number;
}

// --------------------------------------------------------------------------- //
// BuildRun — a record of a graph-utility build job (status/audit only)
// --------------------------------------------------------------------------- //

export type BuildRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface BuildRun {
  buildRunId: string;
  graphSourceId: string;
  tenantId: string;
  status: BuildRunStatus;
  /** Where the build ran (e.g. "databricks-job", "local-dry-run"). */
  trigger: string;
  /** Opaque external job reference (job run id / url). Non-secret. */
  externalRef?: string;
  /** Build-plane step counts mirrored from graph-utility run_build result. */
  stats?: {
    classes?: number;
    properties?: number;
    relationships?: number;
    rows?: number;
    registryTotal?: number;
  };
  /** Human-readable message on terminal states. */
  message?: string;
  startedAt: ISO;
  finishedAt?: ISO;
  rev?: number;
}

// --------------------------------------------------------------------------- //
// MappingProposal — one derived ontology→backend mapping awaiting review
// --------------------------------------------------------------------------- //

export type ProposalStatus = "proposed" | "approved" | "rejected";

/** An evidence item backing a proposed mapping (why the mapping was derived). */
/**
 * An evidence item backing a proposed mapping (why the mapping was derived).
 * The vocabulary is the union of the control-plane kinds and the graph-utility
 * (Python) `Evidence.kind` values, so evidence produced by the build plane is
 * preserved verbatim here. `weight` mirrors the Python per-evidence confidence
 * contribution [0..1] and is optional for control-plane-authored evidence.
 */
export interface MappingEvidence {
  kind:
    // control-plane kinds
    | "ontology-label"
    | "alias-match"
    | "schema-column"
    | "data-type"
    | "join-key"
    | "other"
    // graph-utility (Python) kinds
    | "name-similarity"
    | "type-compatibility"
    | "ontology-relationship"
    | "key-metadata"
    | "profile";
  detail: string;
  /** Contribution to confidence [0..1] (from the build plane). */
  weight?: number;
}

export interface MappingProposal {
  proposalId: string;
  graphSourceId: string;
  tenantId: string;
  /** The build run that produced this proposal. */
  buildRunId: string;
  status: ProposalStatus;

  // --- the derived mapping (mirrors graph-utility registry_row) ---
  ontologyUri: string;
  ontologyLabel: string;
  entityType: "class" | "property";
  ucCatalog?: string;
  ucSchema?: string;
  ucTable?: string;
  ucColumn?: string | null;
  joinKey?: string;
  dataType?: string | null;

  // --- cross-language precision fields (mirror graph-utility MappingProposal) ---
  /** The mapping kind (direct|class|relationship). */
  proposalKind?: ProposalKind;
  /** The ontology entity type string (class|datatype-property|object-property). */
  ontologyType?: string;
  /** Discovered logical type of the target column (authority for SUM/AVG/ILIKE). */
  logicalType?: string;
  /** Subject-key columns for a CLASS mapping (from the discovered PK). */
  subjectColumns?: string[];
  /** Relationship join (composite-aware) for a RELATIONSHIP mapping. */
  join?: MappingJoin;
  /** Content-addressed fingerprint of the published mapping set (when known). */
  mappingFingerprint?: string;
  /** Fingerprint of the discovery inputs that produced this proposal. */
  sourceFingerprint?: string;
  /** Fingerprint of this proposal's identity. */
  proposalFingerprint?: string;
  /** Optional bounded + masked profile summary for reviewer context. */
  profileSummary?: ProfileSummary;

  // --- governance signals ---
  /** 0..1 confidence that the mapping is correct. */
  confidence: number;
  /** Supporting evidence used by reviewers. */
  evidence: MappingEvidence[];
  /** Validation issues; a proposal with blocking issues can't be published. */
  issues: MappingIssue[];

  /** The approval decision, when one has been made. */
  decision?: ApprovalDecision;

  createdAt: ISO;
  updatedAt: ISO;
  rev?: number;
}

export interface MappingIssue {
  // "blocking" is the control-plane term; "error" is the graph-utility
  // (Python) term for the same publish-blocking severity. Both are accepted so
  // proposals produced by the build plane are evaluated identically here.
  severity: "info" | "warning" | "blocking" | "error";
  code: string;
  message: string;
}

// --------------------------------------------------------------------------- //
// Cross-language precision mapping shapes (mirror graph-utility Python)
// --------------------------------------------------------------------------- //

/**
 * The kind of mapping a proposal represents, mirroring graph-utility's
 * `ProposalKind`:
 *   - direct       : ontology datatype-property -> table.column
 *   - class        : ontology class -> table (carries subject-key columns)
 *   - relationship : ontology object-property -> a join between two tables
 */
export type ProposalKind = "direct" | "class" | "relationship";

/**
 * A relationship join, mirroring graph-utility's `JoinMetadata`. Column lists
 * are positionally paired and may be COMPOSITE. `origin` records whether the
 * join was declared (FK), discovered, or proposed by a human.
 */
export interface MappingJoin {
  leftTable: string;
  leftColumns: string[];
  rightTable: string;
  rightColumns: string[];
  cardinality?: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  origin?: "declared" | "discovered" | "proposed";
  name?: string;
}

/**
 * An optional, bounded + masked profile summary carried alongside a proposal
 * for reviewer context. Never contains raw values (mirrors graph-utility's
 * masked ColumnProfile samples).
 */
export interface ProfileSummary {
  rowEstimate?: number;
  nonNullCount?: number;
  nullCount?: number;
  distinctEstimate?: number;
  /** Masked representative samples (e.g. "<str:8:ab12cd34>"). */
  maskedSamples?: string[];
}

// --------------------------------------------------------------------------- //
// ApprovalDecision — a mandatory-reviewer, mandatory-note human decision
// --------------------------------------------------------------------------- //

export interface ApprovalDecision {
  decision: "approved" | "rejected";
  /** Mandatory reviewer identity. */
  reviewer: string;
  /** Mandatory free-text note explaining the decision. */
  note: string;
  decidedAt: ISO;
}

// --------------------------------------------------------------------------- //
// MappingVersion — the immutable published artifact reference
// --------------------------------------------------------------------------- //

export type MappingVersionStatus = "published" | "superseded";

export interface MappingVersion {
  mappingVersionId: string;
  graphSourceId: string;
  tenantId: string;
  /** 1-based, monotonically increasing per graph source. */
  version: number;
  status: MappingVersionStatus;
  /** The build run whose approved proposals were published. */
  buildRunId: string;
  /** Proposal ids included in this version (all approved + valid). */
  proposalIds: string[];
  /** Reference to the published registry artifact (table/URI). Not the data. */
  artifactRef: {
    registryTable?: string;
    objectUri?: string;
    checksum?: string;
  };
  publishedBy: string;
  publishedAt: ISO;
  rev?: number;
}

// --------------------------------------------------------------------------- //
// Query helpers
// --------------------------------------------------------------------------- //

/** Thrown when a conditional write loses an optimistic-concurrency race. */
export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";
  constructor(message = "Optimistic concurrency conflict") {
    super(message);
    this.name = "VersionConflictError";
  }
}

/** Thrown when a state transition is not permitted. */
export class InvalidTransitionError extends Error {
  readonly code = "INVALID_TRANSITION";
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

/** Thrown when the publish gate is not satisfied. */
export class PublishGateError extends Error {
  readonly code = "PUBLISH_GATE";
  constructor(message: string) {
    super(message);
    this.name = "PublishGateError";
  }
}

/** Thrown when an entity is not found. */
export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
