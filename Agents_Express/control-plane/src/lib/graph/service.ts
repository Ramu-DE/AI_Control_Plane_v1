// Graph control-plane service layer.
//
// Orchestrates the store with domain logic (validation, SSRF checks, publish
// gate, id generation) and seeds the default source so the existing /graph UI
// and /api/graph behavior are preserved after the refactor to the async store.
//
// This module is server-only. It performs NO AWS calls at import — seeding is
// lazy and idempotent, and in dynamodb mode seeding is skipped entirely (the
// table is the source of truth and we never write at import).

import { createHash } from "node:crypto";
import {
  InvalidTransitionError,
  NotFoundError,
  PublishGateError,
  VersionConflictError,
} from "./entities";
import type {
  ApprovalDecision,
  BuildRun,
  GraphSource,
  MappingProposal,
  MappingVersion,
} from "./entities";
import { getGraphControlStore, resolveStoreKind } from "./factory";
import {
  evaluatePublishGate,
  isProposalValid,
  normalizeProposal,
  validateOutboundUrl,
} from "./logic";
import type { GraphControlStore } from "./store";
import type { RecordStatus } from "../types";

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// --------------------------------------------------------------------------- //
// Seed — mirrors the legacy graphStore.ts contract-iq source so existing
// behavior (preview, query, approve) is unchanged. Only runs for local mode.
// --------------------------------------------------------------------------- //
function seedSource(): GraphSource {
  const now = new Date().toISOString();
  return {
    graphSourceId: "contract-iq",
    bu: "market-access",
    tenantId: "market-access",
    displayName: "Contract IQ (Market Access)",
    description:
      "Ontology-mediated access to governed contract data in Unity Catalog.",
    ontology: {
      type: "neptune",
      sparqlUrl: "https://REPLACE-ME-neptune-endpoint:8182/sparql",
      graphUri: "http://example.com/graph/market-access",
      namespace: "http://example.com/ontology/market-access#",
      auth: "sigv4-assume-role",
      region: process.env.AWS_REGION || undefined,
    },
    backend: {
      type: "databricks-uc",
      catalog: "usdev_corp",
      schema: "corp_us_mart",
      registryTable: "usdev_corp.corp_us_mart.omda_ontology_mapping",
      universalJoinKey: "contract_key",
      vectorIndex: "usdev_corp.corp_us_mart.contract_chunk_index",
      vectorEndpoint: "vector_demo",
    },
    llmEndpoint: "databricks-meta-llama-3-3-70b-instruct",
    queryEngineUrl:
      "https://REPLACE-ME-databricks-host/serving-endpoints/contract_iq_omda/invocations",
    tags: { region: "US", sensitivity: "confidential", tier: "pro" },
    version: "1.0.0",
    status: "Approved",
    owner: "market-access",
    allowedHosts: [],
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
}

const globalForSeed = globalThis as unknown as { __graphControlSeeded?: boolean };

/**
 * Idempotently seed the default source in LOCAL mode only. In dynamodb mode we
 * never write at read time — the table is authoritative.
 */
export async function ensureSeeded(store: GraphControlStore): Promise<void> {
  if (resolveStoreKind() !== "local") return;
  if (globalForSeed.__graphControlSeeded) return;
  globalForSeed.__graphControlSeeded = true;
  const existing = await store.getGraphSource("contract-iq");
  if (!existing) {
    try {
      await store.createGraphSource(seedSource());
    } catch (e) {
      // Another concurrent caller seeded first — fine.
      if (!(e instanceof VersionConflictError)) throw e;
    }
  }
}

export async function controlStore(): Promise<GraphControlStore> {
  const store = getGraphControlStore();
  await ensureSeeded(store);
  return store;
}

// --------------------------------------------------------------------------- //
// GraphSource registration (additive connection refs + asset scope + SSRF)
// --------------------------------------------------------------------------- //

export interface RegisterInput {
  graphSourceId: string;
  bu: string;
  displayName: string;
  description?: string;
  ontology: GraphSource["ontology"];
  backend: GraphSource["backend"];
  llmEndpoint: string;
  queryEngineUrl?: string;
  tags?: Record<string, string>;
  version?: string;
  tenantId?: string;
  connections?: GraphSource["connections"];
  assetScope?: GraphSource["assetScope"];
  allowedHosts?: string[];
}

export function validateRegistration(input: RegisterInput): string | null {
  if (!input.graphSourceId?.trim() || !input.bu?.trim() || !input.displayName?.trim()) {
    return "graphSourceId, bu and displayName are required";
  }
  // Ontology is required only for the Neptune (external SPARQL) type. A native
  // graph backend (neo4j) IS its own ontology and uses ontology.type "none".
  if (input.ontology?.type === "neptune") {
    if (
      !input.ontology?.sparqlUrl?.trim() ||
      !input.ontology.graphUri?.trim() ||
      !input.ontology.namespace?.trim()
    ) {
      return "ontology sparqlUrl, graphUri and namespace are required for a neptune ontology";
    }
  }

  // Backend validation is per-type (discriminated union).
  if (input.backend?.type === "neo4j") {
    if (!input.backend.uri?.trim()) return "backend uri is required for type 'neo4j'";
    if (!input.backend.database?.trim()) return "backend database is required for type 'neo4j'";
    if (!input.backend.username?.trim()) return "backend username is required for type 'neo4j'";
  } else if (input.backend?.type === "databricks-uc") {
    if (
      !input.backend.catalog?.trim() ||
      !input.backend.schema?.trim() ||
      !input.backend.registryTable?.trim()
    ) {
      return "backend catalog, schema and registryTable are required";
    }
    // The legacy databricks-uc engine joins on a single key, so it must be
    // supplied explicitly for that backend. There is NO default — a source must
    // never inherit another tenant's join key. The precision build/plan path
    // derives joins per-relationship and does not require this field.
    if (!input.backend.universalJoinKey?.trim()) {
      return "backend universalJoinKey is required for type 'databricks-uc'";
    }
  } else {
    return "backend.type must be 'databricks-uc' or 'neo4j'";
  }

  if (!input.llmEndpoint?.trim()) {
    return "llmEndpoint is required";
  }

  // SSRF: any provided outbound URL must pass HTTPS + allowlist/private checks.
  // Placeholder URLs are permitted at registration (preview-only setup) and
  // remain previewable. A CONFIGURED (non-placeholder) queryEngineUrl is a live
  // egress target: it MUST be pinned by a non-empty allowedHosts allowlist that
  // matches its hostname — an empty allowlist is NOT acceptable for a real URL.
  const allowed = input.allowedHosts;
  const qeu = input.queryEngineUrl?.trim();
  if (qeu) {
    const probe = validateOutboundUrl(qeu); // no allowlist: detect placeholder/scheme/private
    if (!probe.placeholder) {
      if (!probe.ok) return `queryEngineUrl rejected: ${probe.reason}`;
      if (!allowed || allowed.length === 0) {
        return "queryEngineUrl is configured but allowedHosts is empty; a live serving URL must be pinned to an allowlist";
      }
      const r = validateOutboundUrl(qeu, allowed);
      if (!r.ok) return `queryEngineUrl rejected: ${r.reason}`;
    }
  }
  if (input.ontology?.type === "neptune" && input.ontology.sparqlUrl?.trim()) {
    const r = validateOutboundUrl(input.ontology.sparqlUrl.trim(), allowed);
    if (!r.ok && !r.placeholder) return `ontology.sparqlUrl rejected: ${r.reason}`;
  }
  return null;
}

export async function registerGraphSource(
  input: RegisterInput,
  owner: string
): Promise<GraphSource> {
  const store = await controlStore();
  const now = new Date().toISOString();
  const record: GraphSource = {
    graphSourceId: input.graphSourceId.trim(),
    bu: input.bu.trim(),
    tenantId: input.tenantId?.trim() || input.bu.trim(),
    displayName: input.displayName.trim(),
    description: input.description?.trim() ?? "",
    ontology: input.ontology,
    backend: input.backend,
    llmEndpoint: input.llmEndpoint.trim(),
    queryEngineUrl: input.queryEngineUrl?.trim() ?? "",
    tags: input.tags ?? {},
    version: input.version?.trim() || "1.0.0",
    status: "Draft",
    owner,
    connections: input.connections,
    assetScope: input.assetScope,
    allowedHosts: input.allowedHosts ?? [],
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  return store.createGraphSource(record);
}

export async function transitionSource(
  graphSourceId: string,
  next: RecordStatus
): Promise<GraphSource> {
  const store = await controlStore();
  const current = await store.getGraphSource(graphSourceId);
  if (!current) throw new NotFoundError(`graph source '${graphSourceId}' not found`);
  return store.transitionGraphSource(graphSourceId, next, current.rev ?? 1);
}

// --------------------------------------------------------------------------- //
// BuildRun + proposals
// --------------------------------------------------------------------------- //

export async function startBuildRun(
  graphSourceId: string,
  trigger: string
): Promise<BuildRun> {
  const store = await controlStore();
  const source = await store.getGraphSource(graphSourceId);
  if (!source) throw new NotFoundError(`graph source '${graphSourceId}' not found`);
  const now = new Date().toISOString();
  const run: BuildRun = {
    buildRunId: newId("br"),
    graphSourceId,
    tenantId: source.tenantId ?? source.bu,
    status: "pending",
    trigger,
    startedAt: now,
    rev: 1,
  };
  return store.createBuildRun(run);
}

export interface ProposalInput {
  ontologyUri: string;
  ontologyLabel: string;
  entityType: "class" | "property";
  ucCatalog?: string;
  ucSchema?: string;
  ucTable?: string;
  ucColumn?: string | null;
  joinKey?: string;
  dataType?: string | null;
  confidence: number;
  evidence?: MappingProposal["evidence"];
  issues?: MappingProposal["issues"];
  // --- cross-language precision fields (mirror graph-utility MappingProposal) ---
  proposalKind?: MappingProposal["proposalKind"];
  ontologyType?: string;
  logicalType?: string;
  subjectColumns?: string[];
  join?: MappingProposal["join"];
  mappingFingerprint?: string;
  sourceFingerprint?: string;
  proposalFingerprint?: string;
  profileSummary?: MappingProposal["profileSummary"];
}

export async function addProposals(
  graphSourceId: string,
  buildRunId: string,
  inputs: Array<ProposalInput | Record<string, unknown>>
): Promise<MappingProposal[]> {
  const store = await controlStore();
  const source = await store.getGraphSource(graphSourceId);
  if (!source) throw new NotFoundError(`graph source '${graphSourceId}' not found`);
  const run = await store.getBuildRun(buildRunId);
  if (!run) throw new NotFoundError(`build run '${buildRunId}' not found`);
  const tenantId = source.tenantId ?? source.bu;
  const now = new Date().toISOString();
  const created: MappingProposal[] = [];
  for (const raw of inputs) {
    // Accept either a native camelCase ProposalInput or a build-plane (Python)
    // snake_case dict — normalizeProposal preserves kind, logical type, subject
    // columns, the composite join, fingerprints, evidence and issues verbatim.
    const input = normalizeProposal(raw as Record<string, unknown>);
    const proposal: MappingProposal = {
      proposalId: newId("pr"),
      graphSourceId,
      tenantId,
      buildRunId,
      status: "proposed",
      ontologyUri: input.ontologyUri,
      ontologyLabel: input.ontologyLabel,
      entityType: input.entityType,
      ucCatalog: input.ucCatalog,
      ucSchema: input.ucSchema,
      ucTable: input.ucTable,
      ucColumn: input.ucColumn ?? null,
      joinKey: input.joinKey,
      dataType: input.dataType ?? null,
      confidence: Math.min(Math.max(input.confidence, 0), 1),
      evidence: input.evidence ?? [],
      issues: input.issues ?? [],
      proposalKind: input.proposalKind,
      ontologyType: input.ontologyType,
      logicalType: input.logicalType,
      subjectColumns: input.subjectColumns,
      join: input.join,
      mappingFingerprint: input.mappingFingerprint,
      sourceFingerprint: input.sourceFingerprint,
      proposalFingerprint: input.proposalFingerprint,
      profileSummary: input.profileSummary,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    created.push(await store.createProposal(proposal));
  }
  return created;
}

// --------------------------------------------------------------------------- //
// Approve / reject — mandatory reviewer + note, one or many
// --------------------------------------------------------------------------- //

export interface DecisionResult {
  proposalId: string;
  ok: boolean;
  status?: string;
  error?: string;
}

export async function decideProposals(
  proposalIds: string[],
  decision: "approved" | "rejected",
  reviewer: string,
  note: string
): Promise<DecisionResult[]> {
  const store = await controlStore();
  const decidedAt = new Date().toISOString();
  const results: DecisionResult[] = [];
  for (const proposalId of proposalIds) {
    try {
      const current = await store.getProposal(proposalId);
      if (!current) {
        results.push({ proposalId, ok: false, error: "not found" });
        continue;
      }
      // Fail closed: a proposal with a blocking/error issue can NEVER be
      // approved. Rejection of an invalid proposal is always allowed (it is a
      // completed decision that excludes the proposal from any publish).
      if (decision === "approved" && !isProposalValid(current)) {
        const codes = current.issues
          .filter((i) => i.severity === "blocking" || i.severity === "error")
          .map((i) => i.code)
          .join(", ");
        results.push({
          proposalId,
          ok: false,
          error: `cannot approve: blocking issue(s) [${codes}]`,
        });
        continue;
      }
      const record: ApprovalDecision = { decision, reviewer, note, decidedAt };
      const updated = await store.decideProposal(proposalId, record, current.rev ?? 1);
      results.push({ proposalId, ok: true, status: updated.status });
    } catch (e) {
      results.push({
        proposalId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

// --------------------------------------------------------------------------- //
// Publish — only when every included proposal is approved AND valid
// --------------------------------------------------------------------------- //

export async function publishMappingVersion(
  graphSourceId: string,
  buildRunId: string,
  publishedBy: string
): Promise<MappingVersion> {
  const store = await controlStore();
  const source = await store.getGraphSource(graphSourceId);
  if (!source) throw new NotFoundError(`graph source '${graphSourceId}' not found`);
  const proposals = await store.listProposals({ graphSourceId, buildRunId });
  const gate = evaluatePublishGate(proposals);
  if (!gate.eligible) {
    throw new PublishGateError(gate.reasons.join("; "));
  }
  const existing = await store.listMappingVersions(graphSourceId);
  const nextVersion = existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  const now = new Date().toISOString();
  const includedIds = proposals
    .filter((p) => p.status === "approved" && isProposalValid(p))
    .map((p) => p.proposalId);
  // Content-addressed reference to the published set — the control-plane
  // analogue of graph-utility's PublishedMappingSet.set_fingerprint. It is a
  // reproducible reference to WHICH mappings were published (ids + version),
  // never the data itself. Deterministic: sort inputs before hashing.
  const checksum =
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify({ graphSourceId, version: nextVersion, proposalIds: [...includedIds].sort() }))
      .digest("hex")
      .slice(0, 32);
  const version: MappingVersion = {
    mappingVersionId: newId("mv"),
    graphSourceId,
    tenantId: source.tenantId ?? source.bu,
    version: nextVersion,
    status: "published",
    buildRunId,
    proposalIds: includedIds,
    artifactRef: {
      registryTable:
        source.backend.type === "databricks-uc" ? source.backend.registryTable : undefined,
      checksum,
    },
    publishedBy,
    publishedAt: now,
    rev: 1,
  };
  return store.createMappingVersion(version);
}

export { InvalidTransitionError, NotFoundError, PublishGateError, VersionConflictError };
