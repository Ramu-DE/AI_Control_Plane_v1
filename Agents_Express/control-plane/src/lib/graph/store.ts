// GraphControlStore — the persistence seam for the graph control plane.
//
// Two implementations:
//   - LocalGraphControlStore  (in-memory; offline/tests; default)
//   - DynamoDbGraphControlStore (single-table; conditional writes)
//
// Selected at runtime by GRAPH_CONTROL_STORE=local|dynamodb. The store is
// fully async so both back-ends share one interface. No implementation makes
// network calls or creates tables at module import time.

import type {
  ApprovalDecision,
  BuildRun,
  BuildRunStatus,
  GraphSource,
  MappingProposal,
  MappingVersion,
  ProposalStatus,
} from "./entities";
import type { RecordStatus } from "../types";

// --------------------------------------------------------------------------- //
// Query shapes
// --------------------------------------------------------------------------- //

export interface ListGraphSourcesQuery {
  tenantId?: string;
  status?: RecordStatus;
}

export interface ListProposalsQuery {
  graphSourceId?: string;
  tenantId?: string;
  buildRunId?: string;
  status?: ProposalStatus;
}

export interface ListBuildRunsQuery {
  graphSourceId?: string;
  tenantId?: string;
  status?: BuildRunStatus;
}

// --------------------------------------------------------------------------- //
// The store interface
// --------------------------------------------------------------------------- //

export interface GraphControlStore {
  // ---- GraphSource lifecycle ----
  listGraphSources(query?: ListGraphSourcesQuery): Promise<GraphSource[]>;
  getGraphSource(graphSourceId: string): Promise<GraphSource | null>;
  /** Create a new source. Fails if the id already exists. */
  createGraphSource(source: GraphSource): Promise<GraphSource>;
  /**
   * Conditionally update a source. `expectedRev` enforces optimistic
   * concurrency; a mismatch throws VersionConflictError.
   */
  updateGraphSource(
    graphSourceId: string,
    patch: Partial<GraphSource>,
    expectedRev: number
  ): Promise<GraphSource>;
  /** State-machine transition with conditional write. */
  transitionGraphSource(
    graphSourceId: string,
    next: RecordStatus,
    expectedRev: number,
    /** Decision metadata (submitter / reviewer) written with the transition. */
    meta?: ApprovalMeta
  ): Promise<GraphSource>;

  // ---- BuildRun ----
  listBuildRuns(query?: ListBuildRunsQuery): Promise<BuildRun[]>;
  getBuildRun(buildRunId: string): Promise<BuildRun | null>;
  createBuildRun(run: BuildRun): Promise<BuildRun>;
  updateBuildRunStatus(
    buildRunId: string,
    status: BuildRunStatus,
    patch: Partial<Pick<BuildRun, "message" | "stats" | "finishedAt" | "externalRef">>,
    expectedRev: number
  ): Promise<BuildRun>;

  // ---- MappingProposal ----
  listProposals(query?: ListProposalsQuery): Promise<MappingProposal[]>;
  getProposal(proposalId: string): Promise<MappingProposal | null>;
  createProposal(proposal: MappingProposal): Promise<MappingProposal>;
  /** Record an approve/reject decision with conditional write. */
  decideProposal(
    proposalId: string,
    decision: ApprovalDecision,
    expectedRev: number
  ): Promise<MappingProposal>;

  // ---- MappingVersion ----
  listMappingVersions(graphSourceId: string): Promise<MappingVersion[]>;
  getMappingVersion(mappingVersionId: string): Promise<MappingVersion | null>;
  createMappingVersion(version: MappingVersion): Promise<MappingVersion>;
}

/** Who moved a governed resource through its lifecycle. */
export type ApprovalMeta = Partial<
  Pick<GraphSource, "submittedByPersonaId" | "decidedBy" | "decidedByPersonaId" | "decidedAt">
>;
