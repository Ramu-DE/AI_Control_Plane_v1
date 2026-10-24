// Offline tests for the RAG Factory module (lib/ragfactory/*).
//
// These pin the pattern recommendation, the corpus rules (only the latest
// finalized version of a tenant's own documents), maker-checker approval,
// the build and its Knowledge Base registration, and the hand-off that makes
// a newly finalized version flow into corpora. The factory is stubbed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { contentSha256 } from "../src/lib/docintel/contract.ts";
import type { FinalizedDocument } from "../src/lib/docintel/contract.ts";
import { collectionFor, profileCorpus, recommendPattern } from "../src/lib/ragfactory/patterns.ts";
import {
  RagCorpusError, buildPromises, createCorpus, decideCorpus, eligibleDocuments, listCorpora,
  onDocumentFinalized, queryCorpus, rebuildCorpus, submitCorpus, updateCorpus,
} from "../src/lib/ragfactory/service.ts";
import type { IngestResult } from "../src/lib/ragfactory/client.ts";
import { store } from "../src/lib/store.ts";

process.env.QDRANT_URL ||= "https://test-cluster.eu-west-2-0.aws.cloud.qdrant.io";

let seq = 0;
function fd(over: { tenantId?: string; documentId?: string; version?: number; text?: string; fields?: number; tables?: boolean; docType?: string } = {}): FinalizedDocument {
  seq += 1;
  const content = {
    text: over.text ?? "Invoice 42. Total 100 USD.",
    fields: Array.from({ length: over.fields ?? 6 }, (_, i) => ({ name: `f${i}`, value: i, edited: false })),
    tables: over.tables === false ? [] : [{ columns: ["a"], rows: [["1"], ["2"]] }],
    summary: null,
  };
  const version = over.version ?? 1;
  return {
    schemaVersion: "finalized-document/v1",
    finalizedDocumentId: `fd-t${seq}x`,
    version,
    supersedes: null,
    tenantId: over.tenantId ?? "fn-rnd",
    documentId: over.documentId ?? `doc-t${seq}x`,
    source: { fileName: `f${seq}.pdf`, mimeType: "application/pdf", sizeBytes: 10, sha256: "b".repeat(64) },
    classification: { docType: over.docType ?? "invoice", gxp: true, region: null },
    content,
    pii: { redaction: "none-detected", detected: [] },
    provenance: {
      methodsRun: [{ method: "claude-haiku", status: "complete" }], selectedMethod: "claude-haiku", capabilities: [],
      submittedBy: { personaId: "persona-priya", name: "Priya" }, submittedAt: "2026-10-24T09:00:00Z",
      finalizedBy: { personaId: "persona-daniel", name: "Daniel" }, finalizedAt: `2026-10-24T09:${String(seq % 60).padStart(2, "0")}:00Z`,
    },
    contentSha256: contentSha256(content),
  };
}

function put(doc: FinalizedDocument) {
  store.finalizedDocuments.unshift({ doc, delta: { status: "skipped" } });
  return doc;
}

const calls: { fd: string; collection: string; chunker: string; tenant: string }[] = [];
const okIngest = async (doc: FinalizedDocument, collection: string, chunker: string, caller: { tenantId: string }): Promise<IngestResult> => {
  calls.push({ fd: doc.finalizedDocumentId, collection, chunker, tenant: caller.tenantId });
  return { collection_name: collection, finalized_document_id: doc.finalizedDocumentId, version: doc.version,
    chunk_count: 4, chunker, points_upserted: 4, points_deleted: 0, superseded_versions: [], elapsed_ms: 1 };
};
const settle = () => Promise.all([...buildPromises.values()]);

// ---------------------------------------------------------------- patterns

test("the recommendation follows the corpus profile, with reasons", () => {
  const forms = profileCorpus([fd({ fields: 8 }), fd({ fields: 6, tables: false })]);
  assert.equal(recommendPattern(forms).patternId, "structured-fields");
  assert.ok(recommendPattern(forms).reasons.some((r) => r.includes("fields")));
  const long = profileCorpus([fd({ text: "x. ".repeat(4000), fields: 1, tables: false })]);
  assert.equal(recommendPattern(long).patternId, "narrative-window");
  const medium = profileCorpus([fd({ text: "y. ".repeat(1000), fields: 0, tables: false })]);
  assert.equal(recommendPattern(medium).patternId, "semantic-sentences");
  const short = profileCorpus([fd({ text: "short", fields: 1, tables: false })]);
  assert.equal(recommendPattern(short).patternId, "fixed-baseline");
  assert.equal(collectionFor("fn-rnd", "corp-ab12"), "cp_fn-rnd_corp-ab12");
});

// ---------------------------------------------------------------- corpus rules

test("a corpus takes only the latest finalized version of its own tenant's documents", () => {
  const v1 = put(fd());
  const v2 = put(fd({ documentId: v1.documentId, version: 2 }));
  const other = put(fd({ tenantId: "fn-supply" }));
  assert.throws(() => createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "x", finalizedDocumentIds: [v1.finalizedDocumentId] }),
    (e: RagCorpusError) => e.code === "STALE_VERSION");
  assert.throws(() => createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "x", finalizedDocumentIds: [other.finalizedDocumentId] }),
    (e: RagCorpusError) => e.code === "FOREIGN_DOCUMENT");
  assert.throws(() => createCorpus({ tenantId: "fn-rnd", personaId: "persona-sofia", name: "x", finalizedDocumentIds: [v2.finalizedDocumentId] }),
    (e: RagCorpusError) => e.status === 403, "a non-member cannot create a corpus");
  const ids = eligibleDocuments("persona-priya", "fn-rnd").map((d) => d.finalizedDocumentId);
  assert.ok(ids.includes(v2.finalizedDocumentId) && !ids.includes(v1.finalizedDocumentId));
  const c = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Invoices", finalizedDocumentIds: [v2.finalizedDocumentId] });
  assert.equal(c.status, "Draft");
  assert.equal(c.patternId, "structured-fields", "defaults to the recommendation");
  assert.equal(listCorpora("persona-lena").some((x) => x.corpusId === c.corpusId), false, "invisible to another tenant");
});

// ---------------------------------------------------------------- approval + build

test("approval is four-eyes, builds with the pattern's chunker, and registers a KB", async () => {
  calls.length = 0;
  const a = put(fd());
  const b = put(fd({ docType: "receipt" }));
  const c = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Mixed",
    finalizedDocumentIds: [a.finalizedDocumentId, b.finalizedDocumentId], patternId: "narrative-window" });
  assert.throws(() => decideCorpus(c.corpusId, "persona-daniel", "approve", null, okIngest), /submit the corpus/);
  submitCorpus(c.corpusId, "persona-priya");
  assert.throws(() => decideCorpus(c.corpusId, "persona-priya", "approve", null, okIngest), (e: RagCorpusError) => e.code === "SELF_REVIEW");
  assert.throws(() => decideCorpus(c.corpusId, "persona-omar", "approve", null, okIngest), (e: RagCorpusError) => e.status === 403);

  decideCorpus(c.corpusId, "persona-daniel", "approve", "ok", okIngest);
  assert.equal(c.status, "Building");
  await settle();
  assert.equal(c.status, "Built");
  assert.deepEqual(calls.map((x) => [x.chunker, x.tenant]), [["sentence_window_chunking", "fn-rnd"], ["sentence_window_chunking", "fn-rnd"]]);
  assert.ok(calls.every((x) => x.collection === `cp_fn-rnd_${c.corpusId}`));

  const kb = store.records.find((r) => r.id === c.kbRecordId)!;
  assert.equal(kb.type, "Knowledge Base");
  assert.equal(kb.status, "Approved");
  assert.equal(kb.tenantId, "fn-rnd");
  assert.equal(kb.submittedByPersonaId, "persona-priya");
  assert.equal(kb.decidedByPersonaId, "persona-daniel");
  assert.equal(kb.knowledgeConfig?.connection.qdrantCollection, c.collection);
  assert.equal(kb.knowledgeConfig?.retrieval.topK, 8);

  // Editing the pattern of a built corpus sends it back for approval.
  updateCorpus({ corpusId: c.corpusId, personaId: "persona-priya", patternId: "fixed-baseline" });
  assert.equal(c.status, "Draft");
});

test("a failed build is recorded; rebuild retries; reject sends it back", async () => {
  const a = put(fd());
  const c = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Flaky", finalizedDocumentIds: [a.finalizedDocumentId] });
  submitCorpus(c.corpusId, "persona-priya");
  decideCorpus(c.corpusId, "persona-daniel", "approve", null, async () => { throw new Error("factory down"); });
  await settle();
  assert.equal(c.status, "Failed");
  assert.match(c.builds[0].docs[0].error ?? "", /factory down/);
  assert.equal(c.kbRecordId, undefined, "no KB for a corpus that never built");
  await assert.rejects(queryCorpus({ corpusId: c.corpusId, personaId: "persona-priya", question: "q" }), /no successful build/);
  rebuildCorpus(c.corpusId, "persona-priya", okIngest);
  await settle();
  assert.equal(c.status, "Built");
  assert.ok(c.kbRecordId);

  const r = put(fd());
  const d = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Nope", finalizedDocumentIds: [r.finalizedDocumentId] });
  submitCorpus(d.corpusId, "persona-priya");
  decideCorpus(d.corpusId, "persona-daniel", "reject", "wrong pattern");
  assert.equal(d.status, "Rejected");
  assert.equal(d.decisionNote, "wrong pattern");
});

// ---------------------------------------------------------------- finalize → corpus

test("a new finalized version flows into following corpora, and is listed for the others", async () => {
  calls.length = 0;
  const v1 = put(fd());
  const follow = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Follow", finalizedDocumentIds: [v1.finalizedDocumentId] });
  const pinned = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Pinned", finalizedDocumentIds: [v1.finalizedDocumentId], followNewVersions: false });
  for (const c of [follow, pinned]) {
    submitCorpus(c.corpusId, "persona-priya");
    decideCorpus(c.corpusId, "persona-daniel", "approve", null, okIngest);
  }
  await settle();
  calls.length = 0;

  const v2 = put(fd({ documentId: v1.documentId, version: 2 }));
  const touched = onDocumentFinalized(store.finalizedDocuments[0], okIngest);
  assert.deepEqual(new Set(touched), new Set([follow.corpusId, pinned.corpusId]));
  await settle();
  assert.deepEqual(calls.map((x) => x.fd), [v2.finalizedDocumentId], "only the following corpus re-ingests");
  assert.equal(follow.members[0].version, 2);
  assert.equal(follow.builds[0].trigger, "new-version");
  assert.equal(follow.status, "Built");
  assert.equal(pinned.members[0].version, 1);
  assert.deepEqual(pinned.updatesAvailable.map((u) => u.version), [2]);
});

test("narrative questions go to the verified path with the corpus's current versions and tenant", async () => {
  const a = put(fd());
  const c = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Ask", finalizedDocumentIds: [a.finalizedDocumentId] });
  submitCorpus(c.corpusId, "persona-priya");
  decideCorpus(c.corpusId, "persona-daniel", "approve", null, okIngest);
  await settle();
  let seen: Record<string, unknown> = {};
  const out = await queryCorpus({ corpusId: c.corpusId, personaId: "persona-priya", question: " why was it released? ", filters: { chunk_kind: "text" } }, {
    route: async () => ({ route: "narrative", reason: "explanation", model: "stub" }),
    decision: async (input, caller) => {
      seen = { ...input, ...caller };
      return { question: input.query, abstained: false, answer: "Released after QA review [1].",
        claims: [{ text: "Released after QA review [1].", citations: [1], supported: true, problems: [] }],
        citations: [{ n: 1, doc_id: a.documentId, finalized_document_id: a.finalizedDocumentId, version: 1, chunk_kind: "text", text: "released" }],
        retrieval: { tokens: [], lexical_hits: 0, top_dense_score: 0.5 }, elapsed_ms: 5 };
    },
  });
  assert.deepEqual(seen, { collection: c.collection, query: "why was it released?", topK: 6, allowedFinalizedIds: [a.finalizedDocumentId],
    filters: { chunk_kind: "text" }, tenantId: "fn-rnd", personaId: "persona-priya" });
  assert.equal(out.mode, "verified-retrieval");
  assert.equal(out.citations[0].finalizedDocumentId, a.finalizedDocumentId);
  await assert.rejects(queryCorpus({ corpusId: c.corpusId, personaId: "persona-lena", question: "q?" }), (e: RagCorpusError) => e.status === 403);
});

test("structured questions are executed exactly over finalized fields; bad plans fall back", async () => {
  const a = put(fd());
  const c = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Exact", finalizedDocumentIds: [a.finalizedDocumentId] });
  submitCorpus(c.corpusId, "persona-priya");
  decideCorpus(c.corpusId, "persona-daniel", "approve", null, okIngest);
  await settle();
  let decisionCalls = 0;
  const decision = async () => { decisionCalls += 1; return { question: "", abstained: true, reason: "x", answer: null, claims: [], citations: [],
    retrieval: { tokens: [], lexical_hits: 0, top_dense_score: null }, elapsed_ms: 1 }; };
  const exact = await queryCorpus({ corpusId: c.corpusId, personaId: "persona-priya", question: "what is f3?" }, {
    route: async () => ({ route: "structured", reason: "value", model: "stub",
      plan: { documentFilters: [{ field: "f0", op: "eq", value: "0" }], select: { type: "fields", fields: ["f3"] } } }),
    decision,
  });
  assert.equal(exact.mode, "exact");
  assert.match(exact.answer ?? "", /f3 = 3/);
  assert.equal(exact.citations[0].ref, "field f3");
  assert.equal(decisionCalls, 0, "no retrieval for an exact answer");
  const fallback = await queryCorpus({ corpusId: c.corpusId, personaId: "persona-priya", question: "what is the colour?" }, {
    route: async () => ({ route: "structured", reason: "value", model: "stub",
      plan: { documentFilters: [], select: { type: "fields", fields: ["colour"] } } }),
    decision,
  });
  assert.equal(fallback.mode, "verified-retrieval");
  assert.deepEqual(fallback.route.planErrors, ["unknown field 'colour'"]);
  assert.equal(decisionCalls, 1);
});

test("a corpus Knowledge Base is retrievable only inside its tenant, under GxP rules", async () => {
  const { authorizeRetrieval } = await import("../src/lib/kb/service.ts");
  const a = put(fd());
  const c = createCorpus({ tenantId: "fn-rnd", personaId: "persona-priya", name: "Scoped", finalizedDocumentIds: [a.finalizedDocumentId] });
  submitCorpus(c.corpusId, "persona-priya");
  decideCorpus(c.corpusId, "persona-daniel", "approve", null, okIngest);
  await settle();
  assert.equal(authorizeRetrieval(c.kbRecordId!, "persona-priya").allowed, true);
  assert.equal(authorizeRetrieval(c.kbRecordId!, "persona-lena").allowed, false, "another tenant");
  assert.equal(authorizeRetrieval(c.kbRecordId!, "persona-kenji").allowed, false, "not a member, not GxP-trained");
  assert.equal(authorizeRetrieval("rec-kb-bedrock-policies", "persona-lena").allowed, true, "platform-provided KB unchanged");
});
