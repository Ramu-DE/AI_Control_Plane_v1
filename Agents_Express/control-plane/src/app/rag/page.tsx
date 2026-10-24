"use client";

// RAG Factory — build a retrieval corpus from finalized documents. The corpus
// is profiled, a pattern is recommended, a second person approves, and the
// build turns it into a tenant-scoped collection registered as a Knowledge
// Base that agents can attach.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { ActingAsSelect, useActingPersona } from "@/components/ActingAs";

interface Pattern { id: string; name: string; chunker: string; topK: number; bestFor: string; howItWorks: string }
interface Profile {
  docCount: number; docTypes: Record<string, number>; avgTextChars: number; maxTextChars: number;
  avgFields: number; docsWithTables: number; tableRows: number; gxp: boolean; regions: string[];
}
interface Member { documentId: string; finalizedDocumentId: string; version: number; docType: string; fileName: string }
interface BuildDoc { finalizedDocumentId: string; version: number; status: string; chunks?: number; pointsDeleted?: number; error?: string }
interface Build {
  buildId: string; trigger: string; by: string; startedAt: string; finishedAt?: string; status: string;
  collection: string; chunker: string; docs: BuildDoc[];
}
interface Corpus {
  corpusId: string; tenantId: string; name: string; description: string; createdBy: string; createdAt: string; updatedAt: string;
  members: Member[]; profile: Profile; recommendation: { patternId: string; reasons: string[] }; patternId: string;
  followNewVersions: boolean; status: string; submittedBy?: string; submittedAt?: string; decidedBy?: string; decidedAt?: string;
  decisionNote?: string; collection?: string; kbRecordId?: string;
  updatesAvailable: { documentId: string; finalizedDocumentId: string; version: number }[]; builds: Build[];
}
interface Eligible {
  documentId: string; finalizedDocumentId: string; version: number; docType: string; fileName: string;
  fields: number; tables: number; textChars: number; finalizedAt: string; finalizedBy: string;
}
interface Health { factory: { configured: boolean; ok: boolean; detail: string }; qdrant: { configured: boolean }; patterns: Pattern[] }
interface Answer {
  answer: string; faithfulness: number | null; elapsedMs: number; pattern: string;
  passages: { score: number | null; text: string; window?: string; documentId?: string; finalizedDocumentId?: string;
    version?: number; docType?: string; chunkKind?: string; pageNum?: number }[];
}

const STATUS_STYLE: Record<string, string> = {
  Draft: "bg-slate-100 text-slate-600",
  "Pending approval": "bg-indigo-50 text-indigo-700",
  Rejected: "bg-red-50 text-red-700",
  Building: "bg-blue-50 text-blue-700",
  Built: "bg-green-50 text-green-700",
  Failed: "bg-red-50 text-red-700",
};

function Status({ s }: { s: string }) {
  return <span className={`badge ${STATUS_STYLE[s] ?? "bg-slate-100 text-slate-600"}`}>{s}</span>;
}

function ProfileView({ p, rec, patterns }: { p: Profile; rec: { patternId: string; reasons: string[] }; patterns: Pattern[] }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
      <div>
        {p.docCount} document(s) · types {Object.entries(p.docTypes).map(([t, n]) => `${t}×${n}`).join(", ") || "—"} ·
        avg {p.avgTextChars} chars (max {p.maxTextChars}) · avg {p.avgFields} fields · {p.docsWithTables} with tables ({p.tableRows} rows)
        {p.gxp ? " · GxP" : ""}{p.regions.length ? ` · region ${p.regions.join(", ")}` : ""}
      </div>
      <div className="mt-1">
        Recommended: <b>{patterns.find((x) => x.id === rec.patternId)?.name ?? rec.patternId}</b>
        {rec.reasons.length ? ` because ${rec.reasons.join("; ")}` : ""}
      </div>
    </div>
  );
}

function PatternPicker({ patterns, value, onChange, recommended, disabled }: {
  patterns: Pattern[]; value: string; onChange: (id: string) => void; recommended: string; disabled?: boolean;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {patterns.map((p) => (
        <label key={p.id} className={`cursor-pointer rounded-lg border p-3 text-xs ${value === p.id ? "border-slate-900 bg-slate-50" : "border-slate-200"} ${disabled ? "opacity-70" : ""}`}>
          <div className="flex items-center gap-2">
            <input type="radio" checked={value === p.id} disabled={disabled} onChange={() => onChange(p.id)} />
            <span className="text-sm font-medium">{p.name}</span>
            {recommended === p.id && <span className="badge bg-teal-50 text-teal-700">recommended</span>}
          </div>
          <div className="mt-1 text-slate-500">{p.bestFor}</div>
          <div className="mt-1 text-slate-500">{p.howItWorks}</div>
          <div className="mt-1 font-mono text-[11px] text-slate-400">{p.chunker} · top {p.topK}</div>
        </label>
      ))}
    </div>
  );
}

export default function RagFactoryPage() {
  const acting = useActingPersona();
  const personaId = acting.personaId;
  const persona = acting.personas.find((p) => p.id === personaId);
  const tenants = useMemo(() => (persona?.memberships ?? []).map((m) => m.tenantId), [persona]);
  const nameOf = (id?: string) => acting.personas.find((p) => p.id === id)?.name ?? id ?? "";

  const [tenantId, setTenantId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [corpora, setCorpora] = useState<Corpus[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [kbRecord, setKbRecord] = useState<{ id: string; name: string; status: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [eligible, setEligible] = useState<Eligible[]>([]);
  const [pick, setPick] = useState<string[]>([]);
  const [draftName, setDraftName] = useState("");
  const [draftDesc, setDraftDesc] = useState("");
  const [draftPattern, setDraftPattern] = useState("");
  const [follow, setFollow] = useState(true);
  const [preview, setPreview] = useState<{ profile: Profile; recommendation: { patternId: string; reasons: string[] } } | null>(null);
  const [note, setNote] = useState("");
  const [question, setQuestion] = useState("");
  const [filterKind, setFilterKind] = useState("");
  const [filterType, setFilterType] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const corpus = corpora.find((c) => c.corpusId === selectedId) ?? null;
  const patterns = health?.patterns ?? [];

  useEffect(() => {
    getJSON<Health>("/api/ragfactory?health=1").then(setHealth).catch(() => setHealth(null));
    const q = new URLSearchParams(window.location.search);
    if (q.get("tenant")) setTenantId(q.get("tenant")!);
    if (q.get("corpus")) setSelectedId(q.get("corpus")!);
  }, []);
  useEffect(() => {
    if (!tenants.includes(tenantId)) setTenantId(tenants[0] ?? "");
  }, [tenants]);

  async function refresh() {
    if (!personaId) { setCorpora([]); return; }
    const r = await getJSON<{ corpora: Corpus[] }>(`/api/ragfactory?personaId=${encodeURIComponent(personaId)}`);
    setCorpora(r.corpora);
  }
  useEffect(() => { refresh().catch((e: Error) => setError(e.message)); }, [personaId]);

  useEffect(() => {
    setAnswer(null);
    setKbRecord(null);
    if (!selectedId || !personaId) return;
    getJSON<{ kbRecord: typeof kbRecord }>(`/api/ragfactory?personaId=${encodeURIComponent(personaId)}&corpusId=${selectedId}`)
      .then((r) => setKbRecord(r.kbRecord)).catch(() => undefined);
  }, [selectedId, corpus?.kbRecordId]);

  // Poll while a build runs.
  useEffect(() => {
    if (!corpora.some((c) => c.status === "Building")) return;
    const t = setTimeout(() => refresh().catch(() => undefined), 3000);
    return () => clearTimeout(t);
  }, [corpora]);

  async function loadEligible() {
    if (!personaId || !tenantId) return;
    const r = await getJSON<{ documents: Eligible[] }>(
      `/api/ragfactory?personaId=${encodeURIComponent(personaId)}&eligible=${encodeURIComponent(tenantId)}`);
    setEligible(r.documents);
  }
  useEffect(() => {
    if (creating) loadEligible().catch((e: Error) => setError(e.message));
  }, [creating, tenantId, personaId]);

  // Live profile of the current selection.
  useEffect(() => {
    if (!creating || !pick.length) { setPreview(null); return; }
    sendJSON<typeof preview>("/api/ragfactory", "POST", { op: "preview", personaId, tenantId, finalizedDocumentIds: pick })
      .then((p) => { setPreview(p); if (p && !draftPattern) setDraftPattern(p.recommendation.patternId); })
      .catch(() => setPreview(null));
  }, [pick, creating]);

  async function act<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError("");
    try {
      const out = await fn();
      await refresh();
      return out;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy("");
    }
  }

  const post = <T,>(body: Record<string, unknown>) =>
    sendJSON<T>("/api/ragfactory", "POST", { personaId, corpusId: selectedId, ...body });

  async function create() {
    const r = await act("create", () => post<{ corpus: Corpus }>({
      op: "create", tenantId, name: draftName, description: draftDesc, finalizedDocumentIds: pick,
      patternId: draftPattern || undefined, followNewVersions: follow,
    }));
    if (r) {
      setCreating(false);
      setSelectedId(r.corpus.corpusId);
      setPick([]); setDraftName(""); setDraftDesc(""); setDraftPattern(""); setPreview(null);
    }
  }

  async function ask() {
    const filters: Record<string, string> = {};
    if (filterKind) filters.chunk_kind = filterKind;
    if (filterType) filters.doc_type = filterType;
    setAnswer(null);
    const r = await act("ask", () => post<Answer>({ op: "query", question, filters }));
    if (r) setAnswer(r);
  }

  const isSubmitter = corpus?.submittedBy === personaId;
  const editable = corpus && !["Building", "Pending approval"].includes(corpus.status);
  const lastGood = corpus?.builds.find((b) => b.status === "succeeded" || b.status === "partial");

  return (
    <>
      <PageHeader
        title="RAG Factory"
        subtitle="Turn finalized documents into an approved retrieval corpus. The pattern is chosen per corpus from its profile, approved by a second person, then built and registered as a Knowledge Base for agents."
        action={<Link className="btn-ghost" href="/documents">Document Intelligence →</Link>}
      />
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <section className="card mb-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ActingAsSelect {...acting}
              hint="Creating, editing and submitting a corpus needs analyst+; approving needs approver+ and must not be the submitter. Asking needs viewer+. GxP tenants require GxP-trained personas." />
            <Field label="Tenant">
              <select className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)} disabled={!tenants.length}>
                {tenants.map((t) => <option key={t} value={t}>{t}</option>)}
                {!tenants.length && <option value="">Select a persona first</option>}
              </select>
            </Field>
            <div className="flex items-end">
              <button className="btn-primary" disabled={!personaId || !tenantId}
                onClick={() => { setCreating(true); setSelectedId(""); }}>
                New corpus
              </button>
            </div>
          </div>
          {health && (
            <p className="mt-3 text-xs text-slate-500">
              RAG Factory engine: {health.factory.configured ? (health.factory.ok ? "healthy" : `unreachable (${health.factory.detail})`) : "not configured"}
              {" · "}Qdrant: {health.qdrant.configured ? "configured" : "not configured (no Knowledge Base will be registered)"}
            </p>
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <aside className="card h-fit p-0">
            <div className="border-b px-4 py-3 text-sm font-medium">Corpora</div>
            {!personaId && <EmptyState text="Choose who you are acting as." />}
            {personaId && !corpora.length && <EmptyState text="No corpora you can view yet." />}
            <ul>
              {corpora.map((c) => (
                <li key={c.corpusId}>
                  <button
                    className={`w-full border-b px-4 py-2 text-left text-sm hover:bg-slate-50 ${c.corpusId === selectedId ? "bg-slate-50" : ""}`}
                    onClick={() => { setSelectedId(c.corpusId); setCreating(false); }}>
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                      <Status s={c.status} /> {c.tenantId} · {c.members.length} doc(s)
                      {c.updatesAvailable.length > 0 && <span className="text-amber-700">· updates</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <main className="space-y-4">
            {creating && (
              <section className="card space-y-4 p-5">
                <h2 className="font-semibold">New corpus in {tenantId}</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Name" required>
                    <input className="input" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="e.g. R&D supplier invoices" />
                  </Field>
                  <Field label="Description">
                    <input className="input" value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} />
                  </Field>
                </div>
                <div>
                  <span className="label">Finalized documents (latest version only)</span>
                  {!eligible.length && (
                    <p className="text-xs text-slate-500">
                      No finalized documents in {tenantId} yet. <Link className="underline" href="/documents">Finalize one in Document Intelligence</Link>.
                    </p>
                  )}
                  <div className="max-h-64 overflow-auto rounded border">
                    <table className="w-full text-xs">
                      <tbody>
                        {eligible.map((d) => (
                          <tr key={d.finalizedDocumentId} className="border-b">
                            <td className="px-2 py-1">
                              <input type="checkbox" checked={pick.includes(d.finalizedDocumentId)}
                                onChange={() => setPick(pick.includes(d.finalizedDocumentId)
                                  ? pick.filter((x) => x !== d.finalizedDocumentId) : [...pick, d.finalizedDocumentId])} />
                            </td>
                            <td className="px-2 py-1 font-medium">{d.fileName}</td>
                            <td className="px-2 py-1">{d.docType}</td>
                            <td className="px-2 py-1 font-mono">{d.finalizedDocumentId} v{d.version}</td>
                            <td className="px-2 py-1 text-slate-500">{d.fields} fields · {d.tables} tables · {d.textChars} chars</td>
                            <td className="px-2 py-1 text-slate-500">finalized by {d.finalizedBy}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                {preview && <ProfileView p={preview.profile} rec={preview.recommendation} patterns={patterns} />}
                <div>
                  <span className="label">Retrieval pattern</span>
                  <PatternPicker patterns={patterns} value={draftPattern} onChange={setDraftPattern}
                    recommended={preview?.recommendation.patternId ?? ""} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                  Re-ingest automatically when a document in this corpus is finalized as a new version
                </label>
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={busy !== "" || !draftName.trim() || !pick.length} onClick={create}>
                    Create draft
                  </button>
                  <button className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
                </div>
              </section>
            )}

            {!creating && !corpus && <section className="card p-5"><EmptyState text="Select a corpus or create one." /></section>}

            {!creating && corpus && (
              <>
                <section className="card space-y-3 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="font-semibold">{corpus.name}</h2>
                      <p className="text-xs text-slate-500">
                        {corpus.corpusId} · {corpus.tenantId} · created by {nameOf(corpus.createdBy)}
                        {corpus.collection ? ` · collection ${corpus.collection}` : ""}
                      </p>
                      {corpus.description && <p className="mt-1 text-sm text-slate-600">{corpus.description}</p>}
                    </div>
                    <Status s={corpus.status} />
                  </div>
                  <ProfileView p={corpus.profile} rec={corpus.recommendation} patterns={patterns} />
                  <div>
                    <span className="label">Retrieval pattern {editable ? "(changing it returns the corpus to Draft)" : ""}</span>
                    <PatternPicker patterns={patterns} value={corpus.patternId} recommended={corpus.recommendation.patternId}
                      disabled={!editable || busy !== ""}
                      onChange={(id) => act("pattern", () => post({ op: "update", patternId: id }))} />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={corpus.followNewVersions} disabled={!editable || busy !== ""}
                      onChange={(e) => act("follow", () => post({ op: "update", followNewVersions: e.target.checked }))} />
                    Re-ingest automatically when a member document is finalized as a new version
                  </label>
                  <table className="w-full text-xs">
                    <thead className="text-left text-slate-500"><tr><th className="py-1">Document</th><th>Type</th><th>Finalized version</th></tr></thead>
                    <tbody>
                      {corpus.members.map((m) => (
                        <tr key={m.documentId} className="border-t">
                          <td className="py-1">{m.fileName} <span className="font-mono text-slate-400">{m.documentId}</span></td>
                          <td>{m.docType}</td>
                          <td className="font-mono">{m.finalizedDocumentId} v{m.version}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {corpus.updatesAvailable.length > 0 && (
                    <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                      Newer finalized versions: {corpus.updatesAvailable.map((u) => `${u.documentId} v${u.version}`).join(", ")}.
                      {editable && (
                        <button className="btn-ghost ml-2 text-xs" disabled={busy !== ""}
                          onClick={() => act("updates", () => post({ op: "update", finalizedDocumentIds: corpus.members.map((m) =>
                            corpus.updatesAvailable.find((u) => u.documentId === m.documentId)?.finalizedDocumentId ?? m.finalizedDocumentId) }))}>
                          Use the new versions (needs re-approval)
                        </button>
                      )}
                    </div>
                  )}
                </section>

                <section className="card space-y-3 p-5">
                  <h3 className="text-sm font-semibold">Approval</h3>
                  <p className="text-xs text-slate-500">
                    {corpus.submittedBy ? `Submitted by ${nameOf(corpus.submittedBy)} at ${corpus.submittedAt}. ` : "Not submitted. "}
                    {corpus.decidedBy ? `Last decided by ${nameOf(corpus.decidedBy)} at ${corpus.decidedAt}${corpus.decisionNote ? `: ${corpus.decisionNote}` : ""}.` : ""}
                  </p>
                  <div className="flex flex-wrap items-end gap-2">
                    {["Draft", "Rejected"].includes(corpus.status) && (
                      <button className="btn-primary" disabled={busy !== ""} onClick={() => act("submit", () => post({ op: "submit" }))}>
                        Submit for approval
                      </button>
                    )}
                    {corpus.status === "Pending approval" && (
                      <>
                        <Field label="Note">
                          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
                        </Field>
                        <button className="btn-primary" disabled={busy !== "" || isSubmitter}
                          onClick={() => act("approve", async () => { await post({ op: "approve", note }); setNote(""); })}>
                          Approve and build
                        </button>
                        <button className="btn-ghost" disabled={busy !== "" || isSubmitter}
                          onClick={() => act("reject", async () => { await post({ op: "reject", note }); setNote(""); })}>
                          Reject
                        </button>
                        {isSubmitter && <span className="text-xs text-slate-500">You submitted this corpus; a different approver must decide.</span>}
                      </>
                    )}
                    {["Built", "Failed"].includes(corpus.status) && (
                      <button className="btn-ghost" disabled={busy !== ""} onClick={() => act("rebuild", () => post({ op: "rebuild" }))}>
                        Rebuild
                      </button>
                    )}
                  </div>
                </section>

                {corpus.builds.length > 0 && (
                  <section className="card space-y-2 p-5">
                    <h3 className="text-sm font-semibold">Builds</h3>
                    {corpus.status === "Building" && <p className="text-sm text-blue-700">Building…</p>}
                    {kbRecord && (
                      <p className="text-xs text-slate-600">
                        Registered as Knowledge Base <Link className="font-mono underline" href="/registry">{kbRecord.name}</Link> ({kbRecord.status}).
                        Attach it to an agent (Agents → Knowledge Bases) to ground its answers on this corpus.
                      </p>
                    )}
                    {corpus.builds.map((b) => (
                      <details key={b.buildId} className="rounded border p-2 text-xs" open={b === corpus.builds[0]}>
                        <summary className="cursor-pointer">
                          <span className="font-mono">{b.buildId}</span> · {b.trigger} by {nameOf(b.by)} · <b>{b.status}</b> ·
                          {" "}{b.chunker} · {b.docs.reduce((s, d) => s + (d.chunks ?? 0), 0)} chunks · {b.startedAt}
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {b.docs.map((d) => (
                            <li key={d.finalizedDocumentId + d.version} className={d.status === "failed" ? "text-red-700" : ""}>
                              {d.finalizedDocumentId} v{d.version}: {d.status}
                              {d.chunks !== undefined ? ` (${d.chunks} chunks${d.pointsDeleted ? `, ${d.pointsDeleted} old points removed` : ""})` : ""}
                              {d.error ? ` — ${d.error}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ))}
                  </section>
                )}

                {lastGood && (
                  <section className="card space-y-3 p-5">
                    <h3 className="text-sm font-semibold">Ask this corpus</h3>
                    <div className="grid gap-2 md:grid-cols-[1fr_10rem_10rem_auto]">
                      <input className="input" value={question} placeholder="e.g. What is the total due and the payment terms?"
                        onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && question.trim()) ask(); }} />
                      <select className="input" value={filterKind} onChange={(e) => setFilterKind(e.target.value)}>
                        <option value="">all chunk kinds</option>
                        <option value="text">text</option>
                        <option value="fields">fields</option>
                        <option value="table">table</option>
                      </select>
                      <select className="input" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                        <option value="">all doc types</option>
                        {Object.keys(corpus.profile.docTypes).map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button className="btn-primary" disabled={busy !== "" || !question.trim()} onClick={ask}>
                        {busy === "ask" ? "Asking…" : "Ask"}
                      </button>
                    </div>
                    {answer && (
                      <div className="space-y-3">
                        <div className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{answer.answer}</div>
                        <p className="text-xs text-slate-500">
                          Pattern {answer.pattern} · faithfulness {answer.faithfulness ?? "n/a"} · {(answer.elapsedMs / 1000).toFixed(1)} s
                        </p>
                        <ol className="space-y-2">
                          {answer.passages.map((p, i) => (
                            <li key={i} className="rounded border p-2 text-xs">
                              <div className="mb-1 text-slate-500">
                                [{i + 1}] score {p.score?.toFixed(3) ?? "—"} · {p.chunkKind} · {p.docType} ·
                                <span className="font-mono"> {p.finalizedDocumentId} v{p.version}</span>
                                {p.pageNum ? ` · page ${p.pageNum}` : ""}
                              </div>
                              <div className="whitespace-pre-wrap">{p.text}</div>
                              {p.window && p.window !== p.text && (
                                <div className="mt-1 whitespace-pre-wrap text-slate-500">Window: {p.window}</div>
                              )}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </>
  );
}
