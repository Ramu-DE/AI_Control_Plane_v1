// LocalGraphControlStore — in-memory implementation for offline use and tests.
//
// Deterministic, no AWS, no network. Enforces the same invariants as the
// DynamoDB adapter: optimistic concurrency via `rev`, conditional state
// transitions, and create-if-not-exists semantics. Data is held on a
// globalThis singleton so it survives Next.js dev hot-reloads.

import {
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from "./entities";
import type {
  ApprovalDecision,
  BuildRun,
  BuildRunStatus,
  GraphSource,
  MappingProposal,
  MappingVersion,
} from "./entities";
import type {
  GraphControlStore,
  ListBuildRunsQuery,
  ListGraphSourcesQuery,
  ListProposalsQuery,
} from "./store";
import { canTransition } from "./logic";
import type { RecordStatus } from "../types";

interface LocalData {
  sources: Map<string, GraphSource>;
  buildRuns: Map<string, BuildRun>;
  proposals: Map<string, MappingProposal>;
  versions: Map<string, MappingVersion>;
}

function freshData(): LocalData {
  return {
    sources: new Map(),
    buildRuns: new Map(),
    proposals: new Map(),
    versions: new Map(),
  };
}

const globalForLocal = globalThis as unknown as {
  __graphControlLocal?: LocalData;
};

// Deep-ish clone so callers can't mutate stored records by reference.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class LocalGraphControlStore implements GraphControlStore {
  private data: LocalData;

  /**
   * @param isolated when true, use a private data set (used by unit tests so
   * each test starts clean). Otherwise share the dev-global singleton.
   */
  constructor(isolated = false) {
    if (isolated) {
      this.data = freshData();
    } else {
      this.data = globalForLocal.__graphControlLocal ?? freshData();
      globalForLocal.__graphControlLocal = this.data;
    }
  }

  // ---- GraphSource ----
  async listGraphSources(query: ListGraphSourcesQuery = {}): Promise<GraphSource[]> {
    let items = [...this.data.sources.values()];
    if (query.tenantId) items = items.filter((s) => (s.tenantId ?? s.bu) === query.tenantId);
    if (query.status) items = items.filter((s) => s.status === query.status);
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return clone(items);
  }

  async getGraphSource(graphSourceId: string): Promise<GraphSource | null> {
    const s = this.data.sources.get(graphSourceId);
    return s ? clone(s) : null;
  }

  async createGraphSource(source: GraphSource): Promise<GraphSource> {
    if (this.data.sources.has(source.graphSourceId)) {
      throw new VersionConflictError(`graph source '${source.graphSourceId}' already exists`);
    }
    const stored: GraphSource = { ...clone(source), rev: source.rev ?? 1 };
    this.data.sources.set(stored.graphSourceId, stored);
    return clone(stored);
  }

  async updateGraphSource(
    graphSourceId: string,
    patch: Partial<GraphSource>,
    expectedRev: number
  ): Promise<GraphSource> {
    const current = this.data.sources.get(graphSourceId);
    if (!current) throw new NotFoundError(`graph source '${graphSourceId}' not found`);
    if ((current.rev ?? 1) !== expectedRev) throw new VersionConflictError();
    const next: GraphSource = {
      ...current,
      ...clone(patch),
      graphSourceId: current.graphSourceId,
      rev: (current.rev ?? 1) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.data.sources.set(graphSourceId, next);
    return clone(next);
  }

  async transitionGraphSource(
    graphSourceId: string,
    nextStatus: RecordStatus,
    expectedRev: number
  ): Promise<GraphSource> {
    const current = this.data.sources.get(graphSourceId);
    if (!current) throw new NotFoundError(`graph source '${graphSourceId}' not found`);
    if ((current.rev ?? 1) !== expectedRev) throw new VersionConflictError();
    if (!canTransition(current.status, nextStatus)) {
      throw new InvalidTransitionError(`invalid transition ${current.status} → ${nextStatus}`);
    }
    const next: GraphSource = {
      ...current,
      status: nextStatus,
      rev: (current.rev ?? 1) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.data.sources.set(graphSourceId, next);
    return clone(next);
  }

  // ---- BuildRun ----
  async listBuildRuns(query: ListBuildRunsQuery = {}): Promise<BuildRun[]> {
    let items = [...this.data.buildRuns.values()];
    if (query.graphSourceId) items = items.filter((r) => r.graphSourceId === query.graphSourceId);
    if (query.tenantId) items = items.filter((r) => r.tenantId === query.tenantId);
    if (query.status) items = items.filter((r) => r.status === query.status);
    items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return clone(items);
  }

  async getBuildRun(buildRunId: string): Promise<BuildRun | null> {
    const r = this.data.buildRuns.get(buildRunId);
    return r ? clone(r) : null;
  }

  async createBuildRun(run: BuildRun): Promise<BuildRun> {
    if (this.data.buildRuns.has(run.buildRunId)) {
      throw new VersionConflictError(`build run '${run.buildRunId}' already exists`);
    }
    const stored: BuildRun = { ...clone(run), rev: run.rev ?? 1 };
    this.data.buildRuns.set(stored.buildRunId, stored);
    return clone(stored);
  }

  async updateBuildRunStatus(
    buildRunId: string,
    status: BuildRunStatus,
    patch: Partial<Pick<BuildRun, "message" | "stats" | "finishedAt" | "externalRef">>,
    expectedRev: number
  ): Promise<BuildRun> {
    const current = this.data.buildRuns.get(buildRunId);
    if (!current) throw new NotFoundError(`build run '${buildRunId}' not found`);
    if ((current.rev ?? 1) !== expectedRev) throw new VersionConflictError();
    const next: BuildRun = {
      ...current,
      ...clone(patch),
      status,
      rev: (current.rev ?? 1) + 1,
    };
    this.data.buildRuns.set(buildRunId, next);
    return clone(next);
  }

  // ---- MappingProposal ----
  async listProposals(query: ListProposalsQuery = {}): Promise<MappingProposal[]> {
    let items = [...this.data.proposals.values()];
    if (query.graphSourceId) items = items.filter((p) => p.graphSourceId === query.graphSourceId);
    if (query.tenantId) items = items.filter((p) => p.tenantId === query.tenantId);
    if (query.buildRunId) items = items.filter((p) => p.buildRunId === query.buildRunId);
    if (query.status) items = items.filter((p) => p.status === query.status);
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return clone(items);
  }

  async getProposal(proposalId: string): Promise<MappingProposal | null> {
    const p = this.data.proposals.get(proposalId);
    return p ? clone(p) : null;
  }

  async createProposal(proposal: MappingProposal): Promise<MappingProposal> {
    if (this.data.proposals.has(proposal.proposalId)) {
      throw new VersionConflictError(`proposal '${proposal.proposalId}' already exists`);
    }
    const stored: MappingProposal = { ...clone(proposal), rev: proposal.rev ?? 1 };
    this.data.proposals.set(stored.proposalId, stored);
    return clone(stored);
  }

  async decideProposal(
    proposalId: string,
    decision: ApprovalDecision,
    expectedRev: number
  ): Promise<MappingProposal> {
    const current = this.data.proposals.get(proposalId);
    if (!current) throw new NotFoundError(`proposal '${proposalId}' not found`);
    if ((current.rev ?? 1) !== expectedRev) throw new VersionConflictError();
    const next: MappingProposal = {
      ...current,
      status: decision.decision === "approved" ? "approved" : "rejected",
      decision: clone(decision),
      rev: (current.rev ?? 1) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.data.proposals.set(proposalId, next);
    return clone(next);
  }

  // ---- MappingVersion ----
  async listMappingVersions(graphSourceId: string): Promise<MappingVersion[]> {
    const items = [...this.data.versions.values()].filter(
      (v) => v.graphSourceId === graphSourceId
    );
    items.sort((a, b) => b.version - a.version);
    return clone(items);
  }

  async getMappingVersion(mappingVersionId: string): Promise<MappingVersion | null> {
    const v = this.data.versions.get(mappingVersionId);
    return v ? clone(v) : null;
  }

  async createMappingVersion(version: MappingVersion): Promise<MappingVersion> {
    if (this.data.versions.has(version.mappingVersionId)) {
      throw new VersionConflictError(`mapping version '${version.mappingVersionId}' already exists`);
    }
    const stored: MappingVersion = { ...clone(version), rev: version.rev ?? 1 };
    this.data.versions.set(stored.mappingVersionId, stored);
    return clone(stored);
  }
}
