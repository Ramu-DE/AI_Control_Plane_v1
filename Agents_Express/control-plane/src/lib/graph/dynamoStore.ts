// DynamoDbGraphControlStore — single-table adapter.
//
// Single-table design:
//   PK / SK                       entity
//   GS#<id>        | META         GraphSource
//   GS#<id>        | BR#<id>      BuildRun
//   GS#<id>        | PR#<id>      MappingProposal
//   GS#<id>        | MV#<version> MappingVersion
//
// GSIs:
//   GSI1 (tenant):  GSI1PK = T#<tenantId>         GSI1SK = <entityType>#<sortable>
//   GSI2 (status):  GSI2PK = <entityType>#<status> GSI2SK = <sortable>
//
// Conditional writes implement optimistic concurrency (`rev`) and
// state-transition guards. The adapter NEVER creates the table and makes NO
// network calls at import time — the DynamoDB client is created lazily on first
// use. Credentials come from the SDK default provider chain (never stored).

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
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

type EntityType = "GraphSource" | "BuildRun" | "MappingProposal" | "MappingVersion";

interface KeyedItem {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
  _type: EntityType;
  [k: string]: unknown;
}

const GSI1 = "GSI1"; // tenant
const GSI2 = "GSI2"; // status

export interface DynamoStoreConfig {
  tableName: string;
  region: string;
}

export class DynamoDbGraphControlStore implements GraphControlStore {
  private readonly tableName: string;
  private readonly region: string;
  // Lazily created — NOTHING here runs at module import.
  private _doc?: DynamoDBDocumentClient;

  constructor(config: DynamoStoreConfig) {
    if (!config.tableName) throw new Error("GRAPH_CONTROL_TABLE is required for dynamodb store");
    if (!config.region) throw new Error("AWS region is required for dynamodb store");
    this.tableName = config.tableName;
    this.region = config.region;
  }

  private doc(): DynamoDBDocumentClient {
    if (!this._doc) {
      // No credentials passed — default provider chain. Created on first use.
      const base = new DynamoDBClient({ region: this.region });
      this._doc = DynamoDBDocumentClient.from(base, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    return this._doc;
  }

  // ------------------------------------------------------------------- //
  // Key helpers
  // ------------------------------------------------------------------- //
  private gsPk(id: string) {
    return `GS#${id}`;
  }

  private wrapSource(s: GraphSource): KeyedItem {
    const tenantId = s.tenantId ?? s.bu;
    return {
      ...s,
      PK: this.gsPk(s.graphSourceId),
      SK: "META",
      GSI1PK: `T#${tenantId}`,
      GSI1SK: `GraphSource#${s.createdAt}#${s.graphSourceId}`,
      GSI2PK: `GraphSource#${s.status}`,
      GSI2SK: `${s.createdAt}#${s.graphSourceId}`,
      _type: "GraphSource",
    };
  }

  private wrapBuildRun(r: BuildRun): KeyedItem {
    return {
      ...r,
      PK: this.gsPk(r.graphSourceId),
      SK: `BR#${r.buildRunId}`,
      GSI1PK: `T#${r.tenantId}`,
      GSI1SK: `BuildRun#${r.startedAt}#${r.buildRunId}`,
      GSI2PK: `BuildRun#${r.status}`,
      GSI2SK: `${r.startedAt}#${r.buildRunId}`,
      _type: "BuildRun",
    };
  }

  private wrapProposal(p: MappingProposal): KeyedItem {
    return {
      ...p,
      PK: this.gsPk(p.graphSourceId),
      SK: `PR#${p.proposalId}`,
      GSI1PK: `T#${p.tenantId}`,
      GSI1SK: `MappingProposal#${p.createdAt}#${p.proposalId}`,
      GSI2PK: `MappingProposal#${p.status}`,
      GSI2SK: `${p.createdAt}#${p.proposalId}`,
      _type: "MappingProposal",
    };
  }

  private wrapVersion(v: MappingVersion): KeyedItem {
    return {
      ...v,
      PK: this.gsPk(v.graphSourceId),
      SK: `MV#${String(v.version).padStart(10, "0")}`,
      GSI1PK: `T#${v.tenantId}`,
      GSI1SK: `MappingVersion#${v.publishedAt}#${v.mappingVersionId}`,
      GSI2PK: `MappingVersion#${v.status}`,
      GSI2SK: `${v.publishedAt}#${v.mappingVersionId}`,
      _type: "MappingVersion",
    };
  }

  private strip<T>(item: Record<string, unknown> | undefined): T | null {
    if (!item) return null;
    const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, _type, ...rest } = item;
    void PK;
    void SK;
    void GSI1PK;
    void GSI1SK;
    void GSI2PK;
    void GSI2SK;
    void _type;
    return rest as T;
  }

  // ------------------------------------------------------------------- //
  // GraphSource
  // ------------------------------------------------------------------- //
  async listGraphSources(query: ListGraphSourcesQuery = {}): Promise<GraphSource[]> {
    if (query.tenantId) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
          ExpressionAttributeValues: { ":pk": `T#${query.tenantId}`, ":sk": "GraphSource#" },
        })
      );
      let items = (res.Items ?? []).map((i) => this.strip<GraphSource>(i)!);
      if (query.status) items = items.filter((s) => s.status === query.status);
      return items;
    }
    if (query.status) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI2,
          KeyConditionExpression: "GSI2PK = :pk",
          ExpressionAttributeValues: { ":pk": `GraphSource#${query.status}` },
        })
      );
      return (res.Items ?? []).map((i) => this.strip<GraphSource>(i)!);
    }
    // No index key -> scan would be needed. Keep it honest: require a filter.
    throw new Error("listGraphSources requires tenantId or status in dynamodb mode");
  }

  async getGraphSource(graphSourceId: string): Promise<GraphSource | null> {
    const res = await this.doc().send(
      new GetCommand({ TableName: this.tableName, Key: { PK: this.gsPk(graphSourceId), SK: "META" } })
    );
    return this.strip<GraphSource>(res.Item);
  }

  async createGraphSource(source: GraphSource): Promise<GraphSource> {
    const stored: GraphSource = { ...source, rev: source.rev ?? 1 };
    try {
      await this.doc().send(
        new PutCommand({
          TableName: this.tableName,
          Item: this.wrapSource(stored),
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        throw new VersionConflictError(`graph source '${source.graphSourceId}' already exists`);
      }
      throw e;
    }
    return stored;
  }

  async updateGraphSource(
    graphSourceId: string,
    patch: Partial<GraphSource>,
    expectedRev: number
  ): Promise<GraphSource> {
    const current = await this.getGraphSource(graphSourceId);
    if (!current) throw new NotFoundError(`graph source '${graphSourceId}' not found`);
    const next: GraphSource = {
      ...current,
      ...patch,
      graphSourceId: current.graphSourceId,
      rev: expectedRev + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.conditionalPut(this.wrapSource(next), expectedRev);
    return next;
  }

  async transitionGraphSource(
    graphSourceId: string,
    nextStatus: RecordStatus,
    expectedRev: number
  ): Promise<GraphSource> {
    const current = await this.getGraphSource(graphSourceId);
    if (!current) throw new NotFoundError(`graph source '${graphSourceId}' not found`);
    if (!canTransition(current.status, nextStatus)) {
      throw new InvalidTransitionError(`invalid transition ${current.status} → ${nextStatus}`);
    }
    const next: GraphSource = {
      ...current,
      status: nextStatus,
      rev: expectedRev + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.conditionalPut(this.wrapSource(next), expectedRev);
    return next;
  }

  // ------------------------------------------------------------------- //
  // BuildRun
  // ------------------------------------------------------------------- //
  async listBuildRuns(query: ListBuildRunsQuery = {}): Promise<BuildRun[]> {
    if (query.graphSourceId) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": this.gsPk(query.graphSourceId), ":sk": "BR#" },
        })
      );
      let items = (res.Items ?? []).map((i) => this.strip<BuildRun>(i)!);
      if (query.tenantId) items = items.filter((r) => r.tenantId === query.tenantId);
      if (query.status) items = items.filter((r) => r.status === query.status);
      return items;
    }
    if (query.status) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI2,
          KeyConditionExpression: "GSI2PK = :pk",
          ExpressionAttributeValues: { ":pk": `BuildRun#${query.status}` },
        })
      );
      let items = (res.Items ?? []).map((i) => this.strip<BuildRun>(i)!);
      if (query.tenantId) items = items.filter((r) => r.tenantId === query.tenantId);
      return items;
    }
    if (query.tenantId) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
          ExpressionAttributeValues: { ":pk": `T#${query.tenantId}`, ":sk": "BuildRun#" },
        })
      );
      return (res.Items ?? []).map((i) => this.strip<BuildRun>(i)!);
    }
    throw new Error("listBuildRuns requires graphSourceId, tenantId or status in dynamodb mode");
  }

  async getBuildRun(buildRunId: string): Promise<BuildRun | null> {
    // buildRunId is not the PK; query GSI2 on all statuses is costly, so we
    // require callers to go through graphSource-scoped queries. We do a GSI2
    // lookup across statuses by scanning the known status partitions.
    for (const status of ["pending", "running", "succeeded", "failed", "cancelled"] as BuildRunStatus[]) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI2,
          KeyConditionExpression: "GSI2PK = :pk",
          FilterExpression: "buildRunId = :id",
          ExpressionAttributeValues: { ":pk": `BuildRun#${status}`, ":id": buildRunId },
        })
      );
      const hit = (res.Items ?? [])[0];
      if (hit) return this.strip<BuildRun>(hit);
    }
    return null;
  }

  async createBuildRun(run: BuildRun): Promise<BuildRun> {
    const stored: BuildRun = { ...run, rev: run.rev ?? 1 };
    try {
      await this.doc().send(
        new PutCommand({
          TableName: this.tableName,
          Item: this.wrapBuildRun(stored),
          ConditionExpression: "attribute_not_exists(SK)",
        })
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        throw new VersionConflictError(`build run '${run.buildRunId}' already exists`);
      }
      throw e;
    }
    return stored;
  }

  async updateBuildRunStatus(
    buildRunId: string,
    status: BuildRunStatus,
    patch: Partial<Pick<BuildRun, "message" | "stats" | "finishedAt" | "externalRef">>,
    expectedRev: number
  ): Promise<BuildRun> {
    const current = await this.getBuildRun(buildRunId);
    if (!current) throw new NotFoundError(`build run '${buildRunId}' not found`);
    const next: BuildRun = { ...current, ...patch, status, rev: expectedRev + 1 };
    await this.conditionalPutBySK(this.wrapBuildRun(next), expectedRev);
    return next;
  }

  // ------------------------------------------------------------------- //
  // MappingProposal
  // ------------------------------------------------------------------- //
  async listProposals(query: ListProposalsQuery = {}): Promise<MappingProposal[]> {
    if (query.graphSourceId) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": this.gsPk(query.graphSourceId), ":sk": "PR#" },
        })
      );
      let items = (res.Items ?? []).map((i) => this.strip<MappingProposal>(i)!);
      if (query.buildRunId) items = items.filter((p) => p.buildRunId === query.buildRunId);
      if (query.status) items = items.filter((p) => p.status === query.status);
      if (query.tenantId) items = items.filter((p) => p.tenantId === query.tenantId);
      return items;
    }
    if (query.status) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI2,
          KeyConditionExpression: "GSI2PK = :pk",
          ExpressionAttributeValues: { ":pk": `MappingProposal#${query.status}` },
        })
      );
      let items = (res.Items ?? []).map((i) => this.strip<MappingProposal>(i)!);
      if (query.tenantId) items = items.filter((p) => p.tenantId === query.tenantId);
      if (query.buildRunId) items = items.filter((p) => p.buildRunId === query.buildRunId);
      return items;
    }
    if (query.tenantId) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :sk)",
          ExpressionAttributeValues: { ":pk": `T#${query.tenantId}`, ":sk": "MappingProposal#" },
        })
      );
      return (res.Items ?? []).map((i) => this.strip<MappingProposal>(i)!);
    }
    throw new Error("listProposals requires graphSourceId, tenantId or status in dynamodb mode");
  }

  async getProposal(proposalId: string): Promise<MappingProposal | null> {
    for (const status of ["proposed", "approved", "rejected"] as const) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI2,
          KeyConditionExpression: "GSI2PK = :pk",
          FilterExpression: "proposalId = :id",
          ExpressionAttributeValues: { ":pk": `MappingProposal#${status}`, ":id": proposalId },
        })
      );
      const hit = (res.Items ?? [])[0];
      if (hit) return this.strip<MappingProposal>(hit);
    }
    return null;
  }

  async createProposal(proposal: MappingProposal): Promise<MappingProposal> {
    const stored: MappingProposal = { ...proposal, rev: proposal.rev ?? 1 };
    try {
      await this.doc().send(
        new PutCommand({
          TableName: this.tableName,
          Item: this.wrapProposal(stored),
          ConditionExpression: "attribute_not_exists(SK)",
        })
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        throw new VersionConflictError(`proposal '${proposal.proposalId}' already exists`);
      }
      throw e;
    }
    return stored;
  }

  async decideProposal(
    proposalId: string,
    decision: ApprovalDecision,
    expectedRev: number
  ): Promise<MappingProposal> {
    const current = await this.getProposal(proposalId);
    if (!current) throw new NotFoundError(`proposal '${proposalId}' not found`);
    const next: MappingProposal = {
      ...current,
      status: decision.decision === "approved" ? "approved" : "rejected",
      decision,
      rev: expectedRev + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.conditionalPutBySK(this.wrapProposal(next), expectedRev);
    return next;
  }

  // ------------------------------------------------------------------- //
  // MappingVersion
  // ------------------------------------------------------------------- //
  async listMappingVersions(graphSourceId: string): Promise<MappingVersion[]> {
    const res = await this.doc().send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": this.gsPk(graphSourceId), ":sk": "MV#" },
        ScanIndexForward: false,
      })
    );
    return (res.Items ?? []).map((i) => this.strip<MappingVersion>(i)!);
  }

  async getMappingVersion(mappingVersionId: string): Promise<MappingVersion | null> {
    for (const status of ["published", "superseded"] as const) {
      const res = await this.doc().send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI2,
          KeyConditionExpression: "GSI2PK = :pk",
          FilterExpression: "mappingVersionId = :id",
          ExpressionAttributeValues: { ":pk": `MappingVersion#${status}`, ":id": mappingVersionId },
        })
      );
      const hit = (res.Items ?? [])[0];
      if (hit) return this.strip<MappingVersion>(hit);
    }
    return null;
  }

  async createMappingVersion(version: MappingVersion): Promise<MappingVersion> {
    const stored: MappingVersion = { ...version, rev: version.rev ?? 1 };
    try {
      await this.doc().send(
        new PutCommand({
          TableName: this.tableName,
          Item: this.wrapVersion(stored),
          // version number is unique per source (SK = MV#<padded version>)
          ConditionExpression: "attribute_not_exists(SK)",
        })
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        throw new VersionConflictError(
          `mapping version ${version.version} for '${version.graphSourceId}' already exists`
        );
      }
      throw e;
    }
    return stored;
  }

  // ------------------------------------------------------------------- //
  // Conditional-write helpers (optimistic concurrency on `rev`)
  // ------------------------------------------------------------------- //
  private async conditionalPut(item: KeyedItem, expectedRev: number): Promise<void> {
    try {
      await this.doc().send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_exists(PK) AND #rev = :expected",
          ExpressionAttributeNames: { "#rev": "rev" },
          ExpressionAttributeValues: { ":expected": expectedRev },
        })
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new VersionConflictError();
      throw e;
    }
  }

  private async conditionalPutBySK(item: KeyedItem, expectedRev: number): Promise<void> {
    try {
      await this.doc().send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_exists(SK) AND #rev = :expected",
          ExpressionAttributeNames: { "#rev": "rev" },
          ExpressionAttributeValues: { ":expected": expectedRev },
        })
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new VersionConflictError();
      throw e;
    }
  }
}

// Exported only so an ops/admin tool could reference the expected key schema.
// NOT used at runtime and performs no I/O.
export const DYNAMO_KEY_SCHEMA = {
  table: { hashKey: "PK", rangeKey: "SK" },
  gsis: [
    { name: GSI1, hashKey: "GSI1PK", rangeKey: "GSI1SK" },
    { name: GSI2, hashKey: "GSI2PK", rangeKey: "GSI2SK" },
  ],
} as const;
