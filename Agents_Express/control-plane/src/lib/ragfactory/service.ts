// RAG Factory lifecycle — corpus → profile → pattern → approve → build → KB.
//
// Every step is a governed action in the CORPUS'S tenant, on tool "ragfactory":
//   viewCorpus     viewer+    list / read corpora
//   queryCorpus    viewer+    ask a built corpus
//   manageCorpus   analyst+   create, edit, submit, rebuild
//   approveCorpus  approver+  approve (starts the build) or reject — never the submitter
// The GxP and residency forbids include all four, so a GxP corpus is only
// approved and queried by GxP-trained people.
//
// Only finalized documents can enter a corpus, and only their latest version.
// A successful build registers an Approved Knowledge Base record so agents can
// attach it through the existing knowledgeRefs path; the corpus approval IS
// that record's maker-checker decision, and the record says so.

import { evaluate } from "../evaluator";
import { logAudit, newId, store } from "../store";
import type { FinalizedDocumentRecord } from "../store";
import { RAG_FACTORY_TOOL } from "../regulatory";
import type { KnowledgeConfig, RegistryRecord } from "../types";
import type { Corpus, CorpusBuild, CorpusMember } from "./model";
import { PATTERNS, collectionFor, patternById, profileCorpus, recommendPattern } from "./patterns";
import { ragDecisionQuery, ragIngestFinalized } from "./client";
import type { DecisionResult } from "./client";
import { checkPlan, corpusVocabulary, executePlan, requestedUnitMissing } from "./fieldQuery";
import type { FieldPlan } from "./fieldQuery";
import { routeQuestion } from "./planner";
import type { FinalizedDocument } from "../docintel/contract";

export class RagCorpusError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const RAG_REGISTRY_ID = "registry-ragfactory";
const MAX_MEMBERS = 200;
const MAX_BUILDS = 20;

function persona(personaId: string) {
  const p = store.personas.find((x) => x.id === personaId && !x.disabled);
  if (!p) throw new RagCorpusError("PERSONA_REQUIRED", "a valid personaId is required", 400);
  return p;
}

function decide(personaId: string, tenantId: string, action: string, resource: string) {
  return evaluate({ personaId, agentId: "ragfactory", action, tool: RAG_FACTORY_TOOL, resource, tenantId });
}

export function authorizeCorpus(personaId: string, tenantId: string, action: string, resource: string) {
  const d = decide(personaId, tenantId, action, resource);
  if (!d.allowed) {
    const reason = d.decisions[d.decisions.length - 1]?.reason ?? "denied";
    logAudit({ category: "kb", action: `corpus-${action}-denied`, actor: persona(personaId).name, tenantId,
      detail: `DENY ${action} on ${resource}: ${reason}` });
    throw new RagCorpusError("NOT_PERMITTED", reason, 403);
  }
}

function corpus(corpusId: string): Corpus {
  const c = store.corpora.find((x) => x.corpusId === corpusId);
  if (!c) throw new RagCorpusError("NOT_FOUND", `corpus '${corpusId}' not found`, 404);
  return c;
}

function touch(c: Corpus) {
  c.updatedAt = new Date().toISOString();
}

function finalizedRecord(fdId: string): FinalizedDocumentRecord | undefined {
  return store.finalizedDocuments.find((r) => r.doc.finalizedDocumentId === fdId);
}

/** Latest finalized version of each document in a tenant. */
function latestByDocument(tenantId: string): Map<string, FinalizedDocumentRecord> {
  const out = new Map<string, FinalizedDocumentRecord>();
  for (const r of store.finalizedDocuments) {
    if (r.doc.tenantId !== tenantId) continue;
    const cur = out.get(r.doc.documentId);
    if (!cur || r.doc.version > cur.doc.version) out.set(r.doc.documentId, r);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Reads
// --------------------------------------------------------------------------- //

export function listCorpora(personaId: string, tenantId?: string): Corpus[] {
  persona(personaId);
  return store.corpora
    .filter((c) => !tenantId || c.tenantId === tenantId)
    .filter((c) => decide(personaId, c.tenantId, "viewCorpus", c.corpusId).allowed)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getCorpus(corpusId: string, personaId: string): Corpus {
  const c = corpus(corpusId);
  authorizeCorpus(personaId, c.tenantId, "viewCorpus", c.corpusId);
  return c;
}

/** Finalized documents (latest version) a persona could put into a corpus in this tenant. */
export function eligibleDocuments(personaId: string, tenantId: string) {
  authorizeCorpus(personaId, tenantId, "viewCorpus", "eligible-documents");
  return [...latestByDocument(tenantId).values()]
    .map((r) => ({
      documentId: r.doc.documentId,
      finalizedDocumentId: r.doc.finalizedDocumentId,
      version: r.doc.version,
      docType: r.doc.classification.docType,
      fileName: r.doc.source.fileName,
      fields: r.doc.content.fields.length,
      tables: r.doc.content.tables.length,
      textChars: r.doc.content.text.length,
      finalizedAt: r.doc.provenance.finalizedAt,
      finalizedBy: r.doc.provenance.finalizedBy.name,
    }))
    .sort((a, b) => b.finalizedAt.localeCompare(a.finalizedAt));
}

// --------------------------------------------------------------------------- //
// Create / edit / submit / decide
// --------------------------------------------------------------------------- //

function membersFor(tenantId: string, fdIds: string[]): CorpusMember[] {
  const ids = [...new Set(fdIds)];
  if (!ids.length) throw new RagCorpusError("NO_DOCUMENTS", "choose at least one finalized document");
  if (ids.length > MAX_MEMBERS) throw new RagCorpusError("TOO_MANY", `a corpus holds at most ${MAX_MEMBERS} documents`);
  const latest = latestByDocument(tenantId);
  const seenDocs = new Set<string>();
  return ids.map((id) => {
    const r = finalizedRecord(id);
    if (!r) throw new RagCorpusError("UNKNOWN_DOCUMENT", `finalized document '${id}' not found`);
    if (r.doc.tenantId !== tenantId) {
      throw new RagCorpusError("FOREIGN_DOCUMENT", `'${id}' belongs to tenant '${r.doc.tenantId}', not '${tenantId}'`, 403);
    }
    const newest = latest.get(r.doc.documentId)!;
    if (newest.doc.version !== r.doc.version) {
      throw new RagCorpusError("STALE_VERSION",
        `'${id}' is v${r.doc.version}; ${r.doc.documentId} has a newer finalized version (${newest.doc.finalizedDocumentId} v${newest.doc.version})`);
    }
    if (seenDocs.has(r.doc.documentId)) throw new RagCorpusError("DUPLICATE", `${r.doc.documentId} is listed twice`);
    seenDocs.add(r.doc.documentId);
    return {
      documentId: r.doc.documentId, finalizedDocumentId: id, version: r.doc.version,
      docType: r.doc.classification.docType, fileName: r.doc.source.fileName,
    };
  });
}

function reprofile(c: Corpus) {
  const docs = c.members.map((m) => finalizedRecord(m.finalizedDocumentId)!.doc);
  c.profile = profileCorpus(docs);
  c.recommendation = recommendPattern(c.profile);
}

export function createCorpus(input: {
  tenantId: string;
  personaId: string;
  name: string;
  description?: string;
  finalizedDocumentIds: string[];
  patternId?: string;
  followNewVersions?: boolean;
}): Corpus {
  const p = persona(input.personaId);
  if (!store.tenants.some((t) => t.id === input.tenantId)) {
    throw new RagCorpusError("UNKNOWN_TENANT", `unknown tenant '${input.tenantId}'`);
  }
  authorizeCorpus(p.id, input.tenantId, "manageCorpus", "new-corpus");
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new RagCorpusError("NAME_REQUIRED", "a corpus needs a name");
  if (input.patternId && !patternById(input.patternId)) {
    throw new RagCorpusError("BAD_PATTERN", `unknown pattern '${input.patternId}'`);
  }
  const now = new Date().toISOString();
  const c: Corpus = {
    corpusId: newId("corp"),
    tenantId: input.tenantId,
    name,
    description: (input.description ?? "").slice(0, 500),
    createdBy: p.id,
    createdAt: now,
    updatedAt: now,
    members: membersFor(input.tenantId, input.finalizedDocumentIds),
    profile: profileCorpus([]),
    recommendation: { patternId: "fixed-baseline", reasons: [] },
    patternId: "",
    followNewVersions: input.followNewVersions ?? true,
    status: "Draft",
    updatesAvailable: [],
    builds: [],
  };
  reprofile(c);
  c.patternId = input.patternId ?? c.recommendation.patternId;
  store.corpora.unshift(c);
  logAudit({ category: "kb", action: "corpus-create", actor: p.name, tenantId: c.tenantId,
    detail: `Corpus '${c.name}' (${c.corpusId}) created with ${c.members.length} document(s); ` +
      `pattern ${c.patternId} (recommended ${c.recommendation.patternId})` });
  return c;
}

/** Edit a corpus. Any change to a built or pending corpus returns it to Draft for re-approval. */
export function updateCorpus(input: {
  corpusId: string;
  personaId: string;
  name?: string;
  description?: string;
  finalizedDocumentIds?: string[];
  patternId?: string;
  followNewVersions?: boolean;
}): Corpus {
  const c = corpus(input.corpusId);
  const p = persona(input.personaId);
  authorizeCorpus(p.id, c.tenantId, "manageCorpus", c.corpusId);
  if (c.status === "Building") throw new RagCorpusError("BUSY", "a build is running", 409);
  if (input.patternId !== undefined && !patternById(input.patternId)) {
    throw new RagCorpusError("BAD_PATTERN", `unknown pattern '${input.patternId}'`);
  }
  if (input.name !== undefined) c.name = input.name.trim().slice(0, 80) || c.name;
  if (input.description !== undefined) c.description = input.description.slice(0, 500);
  if (input.followNewVersions !== undefined) c.followNewVersions = input.followNewVersions;
  const changesContent = input.finalizedDocumentIds !== undefined || (input.patternId !== undefined && input.patternId !== c.patternId);
  if (input.finalizedDocumentIds !== undefined) {
    c.members = membersFor(c.tenantId, input.finalizedDocumentIds);
    const inCorpus = new Set(c.members.map((m) => m.finalizedDocumentId));
    c.updatesAvailable = c.updatesAvailable.filter((u) => !inCorpus.has(u.finalizedDocumentId));
    reprofile(c);
  }
  if (input.patternId !== undefined) c.patternId = input.patternId;
  if (changesContent) {
    c.status = "Draft";
    c.submittedBy = undefined;
    c.submittedAt = undefined;
  }
  touch(c);
  logAudit({ category: "kb", action: "corpus-update", actor: p.name, tenantId: c.tenantId,
    detail: `Corpus '${c.name}' edited${changesContent ? "; back to Draft for re-approval" : ""}` });
  return c;
}

export function submitCorpus(corpusId: string, personaId: string): Corpus {
  const c = corpus(corpusId);
  const p = persona(personaId);
  authorizeCorpus(p.id, c.tenantId, "manageCorpus", c.corpusId);
  if (!["Draft", "Rejected"].includes(c.status)) {
    throw new RagCorpusError("NOT_SUBMITTABLE", `a ${c.status} corpus cannot be submitted`, 409);
  }
  c.status = "Pending approval";
  c.submittedBy = p.id;
  c.submittedAt = new Date().toISOString();
  c.decisionNote = undefined;
  touch(c);
  logAudit({ category: "kb", action: "corpus-submit", actor: p.name, tenantId: c.tenantId,
    detail: `Corpus '${c.name}' submitted for approval (pattern ${c.patternId}, ${c.members.length} document(s))` });
  return c;
}

export function decideCorpus(
  corpusId: string, personaId: string, decision: "approve" | "reject", note: string | null,
  ingest = ragIngestFinalized
): Corpus {
  const c = corpus(corpusId);
  const p = persona(personaId);
  if (c.status !== "Pending approval" || !c.submittedBy) {
    throw new RagCorpusError("NOT_PENDING", "submit the corpus for approval first", 409);
  }
  if (c.submittedBy === p.id) {
    logAudit({ category: "kb", action: "corpus-approve-denied", actor: p.name, tenantId: c.tenantId,
      detail: `DENY self-approval of corpus '${c.name}'` });
    throw new RagCorpusError("SELF_REVIEW", `${p.name} submitted this corpus and cannot also decide it (four-eyes rule)`, 403);
  }
  authorizeCorpus(p.id, c.tenantId, "approveCorpus", c.corpusId);
  c.decidedBy = p.id;
  c.decidedAt = new Date().toISOString();
  c.decisionNote = note?.slice(0, 1000) || undefined;
  touch(c);
  if (decision === "reject") {
    c.status = "Rejected";
    logAudit({ category: "kb", action: "corpus-reject", actor: p.name, tenantId: c.tenantId,
      detail: `Corpus '${c.name}' rejected${c.decisionNote ? `: ${c.decisionNote}` : ""}` });
    return c;
  }
  logAudit({ category: "kb", action: "corpus-approve", actor: p.name, tenantId: c.tenantId,
    detail: `Corpus '${c.name}' approved by ${p.name} (submitted by ${persona(c.submittedBy).name}); pattern ${c.patternId}` });
  startBuild(c, p.id, "approval", c.members, ingest);
  return c;
}

/** Re-run ingestion of an approved corpus (e.g. after a factory outage). */
export function rebuildCorpus(corpusId: string, personaId: string, ingest = ragIngestFinalized): Corpus {
  const c = corpus(corpusId);
  const p = persona(personaId);
  authorizeCorpus(p.id, c.tenantId, "manageCorpus", c.corpusId);
  if (!["Built", "Failed"].includes(c.status) || !c.decidedBy) {
    throw new RagCorpusError("NOT_APPROVED", "only an approved corpus (Built or Failed) can be rebuilt", 409);
  }
  startBuild(c, p.id, "rebuild", c.members, ingest);
  return c;
}

// --------------------------------------------------------------------------- //
// Build
// --------------------------------------------------------------------------- //

/** Ingest `members` into the corpus collection in the background. */
function startBuild(
  c: Corpus, by: string, trigger: CorpusBuild["trigger"], members: CorpusMember[], ingest = ragIngestFinalized
): CorpusBuild {
  const pattern = patternById(c.patternId) ?? PATTERNS[PATTERNS.length - 1];
  c.collection ??= collectionFor(c.tenantId, c.corpusId);
  const b: CorpusBuild = {
    buildId: newId("rb"), trigger, by, startedAt: new Date().toISOString(), status: "running",
    collection: c.collection, chunker: pattern.chunker, docs: [],
  };
  c.builds.unshift(b);
  c.builds.splice(MAX_BUILDS);
  const before = c.status;
  c.status = "Building";
  touch(c);
  const done = (async () => {
    for (const m of members) {
      const rec = finalizedRecord(m.finalizedDocumentId);
      if (!rec) {
        b.docs.push({ finalizedDocumentId: m.finalizedDocumentId, version: m.version, status: "failed", error: "finalized document missing" });
        continue;
      }
      try {
        const out = await ingest(rec.doc, b.collection, b.chunker, { tenantId: c.tenantId, personaId: by });
        b.docs.push({ finalizedDocumentId: m.finalizedDocumentId, version: m.version, status: "ingested",
          chunks: out.chunk_count, pointsDeleted: out.points_deleted });
      } catch (e) {
        b.docs.push({ finalizedDocumentId: m.finalizedDocumentId, version: m.version, status: "failed",
          error: (e as Error).message.slice(0, 400) });
      }
    }
    const ok = b.docs.filter((d) => d.status === "ingested").length;
    b.status = ok === b.docs.length ? "succeeded" : ok === 0 ? "failed" : "partial";
    b.finishedAt = new Date().toISOString();
    // A failed incremental update leaves the previous build serving.
    c.status = b.status === "failed" && (trigger !== "new-version" || before !== "Built") ? "Failed" : "Built";
    if (b.status !== "failed") ensureKbRecord(c, pattern.topK);
    touch(c);
    logAudit({ category: "kb", action: `corpus-build-${b.status}`, actor: persona(by).name, tenantId: c.tenantId,
      detail: `Corpus '${c.name}' ${trigger} build ${b.buildId}: ${ok}/${b.docs.length} document(s) into ${b.collection} ` +
        `(${b.chunker}, ${b.docs.reduce((s, d) => s + (d.chunks ?? 0), 0)} chunks)` });
  })();
  buildPromises.set(b.buildId, done);
  void done.finally(() => buildPromises.delete(b.buildId));
  return b;
}

/** In-flight builds; tests await them. */
export const buildPromises = new Map<string, Promise<void>>();

function ensureRegistry() {
  if (store.registries.some((r) => r.id === RAG_REGISTRY_ID)) return;
  store.registries.push({
    id: RAG_REGISTRY_ID,
    name: "RAG_Factory_Registry",
    description: "Knowledge Bases built by the RAG Factory from approved corpora of finalized documents.",
    autoApproval: false,
    createdAt: new Date().toISOString(),
  });
}

/** Register (or refresh) the corpus as an Approved Qdrant Knowledge Base record. */
function ensureKbRecord(c: Corpus, topK: number) {
  const url = (process.env.QDRANT_URL || "").replace(/\/+$/, "");
  if (!url || !c.collection) return;
  ensureRegistry();
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const region = store.tenants.find((t) => t.id === c.tenantId)?.dataRegion;
  const knowledgeConfig: KnowledgeConfig = {
    provider: "Qdrant",
    connection: { qdrantUrl: url, qdrantCollection: c.collection },
    retrieval: { topK, scoreThreshold: 0.1, mode: "semantic", citations: true },
    ...(region ? { residencyRegion: region } : {}),
    auth: { apiKeyEnvVar: "QDRANT_API_KEY" },
    allowedHosts: host.endsWith("cloud.qdrant.io") ? ["cloud.qdrant.io"] : [host],
    fieldMapping: {
      textField: "text",
      metadataFields: ["doc_id", "finalized_document_id", "version", "doc_type", "chunk_kind", "page_num", "chunk_index", "tenant_id"],
    },
    embedding: { modelId: "amazon.titan-embed-text-v2:0", dimension: 1024 },
  };
  const description = `RAG Factory corpus '${c.name}' (${c.corpusId}): ${c.members.length} finalized document(s), ` +
    `pattern ${c.patternId}. Approved through corpus maker-checker.`;
  const existing = c.kbRecordId ? store.records.find((r) => r.id === c.kbRecordId) : undefined;
  if (existing) {
    existing.knowledgeConfig = knowledgeConfig;
    existing.description = description;
    return;
  }
  const submitter = c.submittedBy ? store.personas.find((p) => p.id === c.submittedBy) : undefined;
  const approver = c.decidedBy ? store.personas.find((p) => p.id === c.decidedBy) : undefined;
  const rec: RegistryRecord = {
    id: newId("rec"),
    registryId: RAG_REGISTRY_ID,
    name: `RAG_${c.name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)}_${c.corpusId.slice(5)}`,
    description,
    recordSource: "define-manually",
    type: "Knowledge Base",
    credentialType: "API key",
    status: "Approved",
    knowledgeConfig,
    tools: [],
    owner: submitter?.name ?? "ragfactory",
    tenantId: c.tenantId,
    createdAt: new Date().toISOString(),
    submittedByPersonaId: c.submittedBy,
    decidedBy: approver?.name,
    decidedByPersonaId: c.decidedBy,
    decidedAt: c.decidedAt,
  };
  store.records.unshift(rec);
  c.kbRecordId = rec.id;
  logAudit({ category: "registry", action: "record-approved", actor: approver?.name ?? "ragfactory", tenantId: c.tenantId,
    detail: `Knowledge Base '${rec.name}' registered from corpus '${c.name}' (approved by ${approver?.name}, submitted by ${submitter?.name})` });
}

// --------------------------------------------------------------------------- //
// New finalized versions → the corpus consumes them
// --------------------------------------------------------------------------- //

/**
 * Called when a document is finalized. A corpus that holds an older version
 * of it either re-ingests the new version at once (followNewVersions — the
 * document set is unchanged and the new version is itself four-eyes
 * approved) or lists it under updatesAvailable for an analyst to add.
 */
export function onDocumentFinalized(rec: FinalizedDocumentRecord, ingest = ragIngestFinalized): string[] {
  const touched: string[] = [];
  for (const c of store.corpora) {
    if (c.tenantId !== rec.doc.tenantId) continue;
    const m = c.members.find((x) => x.documentId === rec.doc.documentId);
    if (!m || m.version >= rec.doc.version) continue;
    const by = rec.doc.provenance.finalizedBy.personaId;
    if (c.followNewVersions && c.status === "Built") {
      m.finalizedDocumentId = rec.doc.finalizedDocumentId;
      m.version = rec.doc.version;
      m.docType = rec.doc.classification.docType;
      reprofile(c);
      startBuild(c, by, "new-version", [m], ingest);
      logAudit({ category: "kb", action: "corpus-follow-version", actor: rec.doc.provenance.finalizedBy.name, tenantId: c.tenantId,
        detail: `Corpus '${c.name}' re-ingests ${rec.doc.documentId} v${rec.doc.version} (${rec.doc.finalizedDocumentId})` });
    } else {
      c.updatesAvailable = c.updatesAvailable.filter((u) => u.documentId !== rec.doc.documentId);
      c.updatesAvailable.push({ documentId: rec.doc.documentId, finalizedDocumentId: rec.doc.finalizedDocumentId, version: rec.doc.version });
      touch(c);
    }
    touched.push(c.corpusId);
  }
  return touched;
}

// --------------------------------------------------------------------------- //
// Query
// --------------------------------------------------------------------------- //

export interface CorpusAnswer {
  /** exact = executed over finalized fields; verified-retrieval = cited, claim-checked passages. */
  mode: "exact" | "verified-retrieval";
  answer: string | null;
  abstained: boolean;
  reason?: string;
  route: { route: "structured" | "narrative"; reason: string; plan?: FieldPlan; model?: string; planErrors?: string[] };
  rows?: Record<string, unknown>[];
  citations: {
    n: number; finalizedDocumentId: string; documentId: string; version: number; docType?: string;
    ref: string; text?: string; score?: number | null; lexical?: boolean;
  }[];
  claims?: DecisionResult["claims"];
  pattern: string;
  elapsedMs: number;
}

/**
 * Answer a question over a built corpus.
 *
 *   structured  (values, lists, counts, out-of-spec rows): a model PLANS over
 *               the corpus vocabulary; the plan is validated and EXECUTED over
 *               the four-eyes-finalized fields. No model produces a value.
 *   narrative   the factory's decision path: current versions only, hybrid
 *               retrieval, every sentence cited and verified, else abstain.
 */
export async function queryCorpus(input: {
  corpusId: string;
  personaId: string;
  question: string;
  filters?: Record<string, string | number | boolean>;
}, deps: { route?: typeof routeQuestion; decision?: typeof ragDecisionQuery } = {}): Promise<CorpusAnswer> {
  const route = deps.route ?? routeQuestion;
  const decision = deps.decision ?? ragDecisionQuery;
  const t0 = Date.now();
  const c = corpus(input.corpusId);
  const p = persona(input.personaId);
  authorizeCorpus(p.id, c.tenantId, "queryCorpus", c.corpusId);
  const lastGood = c.builds.find((b) => b.status === "succeeded" || b.status === "partial");
  if (!c.collection || !lastGood) throw new RagCorpusError("NOT_BUILT", "the corpus has no successful build yet", 409);
  const question = input.question.trim().slice(0, 2000);
  if (question.length < 3) throw new RagCorpusError("QUESTION_REQUIRED", "ask a question");
  const pattern = patternById(c.patternId) ?? PATTERNS[PATTERNS.length - 1];
  const docs = c.members.map((m) => finalizedRecord(m.finalizedDocumentId)?.doc).filter((d): d is FinalizedDocument => Boolean(d));

  let routed: CorpusAnswer["route"];
  try {
    routed = await route(question, corpusVocabulary(docs));
  } catch (e) {
    routed = { route: "narrative", reason: `planner unavailable (${(e as Error).message.slice(0, 120)}); using verified retrieval` };
  }

  let out: CorpusAnswer | null = null;
  if (routed.route === "structured" && routed.plan) {
    const planErrors = checkPlan(routed.plan, docs);
    if (planErrors.length) {
      routed = { ...routed, route: "narrative", planErrors, reason: `plan rejected (${planErrors.join("; ")}); using verified retrieval` };
    } else {
      let r = executePlan(routed.plan, docs);
      // An exact text filter that matched nothing is retried as a partial match
      // ("ACME" -> "ACME Lab Supplies"), and the answer says so. Identifiers
      // with digits are never relaxed: a lot number either matches or it doesn't.
      const relaxable = (routed.plan.documentFilters ?? []).filter((f) => f.op === "eq" && !/\d/.test(f.value));
      if (r.empty && relaxable.length) {
        const relaxed = { ...routed.plan, documentFilters: routed.plan.documentFilters.map((f) =>
          relaxable.includes(f) ? { ...f, op: "contains" as const } : f) };
        const r2 = executePlan(relaxed, docs);
        if (!r2.empty) {
          r = { ...r2, answer: `No exact match for ${relaxable.map((f) => `${f.field} = "${f.value}"`).join(", ")}; ` +
            `matched by partial name:\n${r2.answer}` };
          routed = { ...routed, plan: relaxed, reason: `${routed.reason} (exact name match relaxed to partial match)` };
        }
      }
      const unitProblem = r.empty ? null : requestedUnitMissing(question, r.answer + " " + JSON.stringify(r.rows));
      if (unitProblem) {
        r.answer = "";
        r.rows = [];
      }
      out = unitProblem ? {
        mode: "exact", answer: null, abstained: true, reason: unitProblem, route: routed, pattern: pattern.id, elapsedMs: Date.now() - t0,
        citations: r.citations.map((x, i) => ({ n: i + 1, finalizedDocumentId: x.finalizedDocumentId, documentId: x.documentId,
          version: x.version, docType: x.docType, ref: x.ref })),
      } : {
        mode: "exact", answer: r.answer, abstained: false, ...(r.empty ? { reason: "no finalized value matches" } : {}),
        route: routed, rows: r.rows, pattern: pattern.id, elapsedMs: Date.now() - t0,
        citations: r.citations.map((x, i) => ({ n: i + 1, finalizedDocumentId: x.finalizedDocumentId, documentId: x.documentId,
          version: x.version, docType: x.docType, ref: x.ref })),
      };
    }
  }
  if (!out) {
    const d = await decision({
      collection: c.collection, query: question, topK: Math.max(pattern.topK, 6),
      allowedFinalizedIds: c.members.map((m) => m.finalizedDocumentId), filters: input.filters,
    }, { tenantId: c.tenantId, personaId: p.id });
    out = {
      mode: "verified-retrieval", answer: d.answer, abstained: d.abstained, ...(d.reason ? { reason: d.reason } : {}),
      route: routed, claims: d.claims, pattern: pattern.id, elapsedMs: Date.now() - t0,
      citations: d.citations.map((x) => ({
        n: x.n, finalizedDocumentId: x.finalized_document_id, documentId: x.doc_id, version: x.version, docType: x.doc_type,
        ref: [x.chunk_kind ?? "text", x.page_num ? `page ${x.page_num}` : null].filter(Boolean).join(", "),
        text: x.text, score: x.score ?? null, lexical: x.lexical,
      })),
    };
  }
  logAudit({ category: "kb", action: "corpus-query", actor: p.name, tenantId: c.tenantId,
    detail: `Asked corpus '${c.name}' [${out.mode}${out.abstained ? ", abstained" : ""}]: ` +
      `${out.citations.length} citation(s)${out.reason ? ` — ${out.reason}` : ""}` });
  return out;
}
