"use client";

// Document Intelligence — upload a document, run IDP methods side by side,
// review and correct the result, then submit it for finalization by a second
// person. Finalized documents are immutable FinalizedDocument v1 records that
// the RAG Factory and Delta consume.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, EmptyState } from "@/components/ui";
import { getJSON, sendJSON, withBase } from "@/lib/api";
import { ActingAsSelect, useActingPersona } from "@/components/ActingAs";

interface FdField {
  name: string;
  value: unknown;
  confidence?: number | null;
  method?: string | null;
  capability?: string | null;
  edited: boolean;
  originalValue?: unknown;
}
interface FdTable { name?: string | null; columns: string[]; rows: unknown[][] }
interface MethodRun {
  method: string;
  status: "complete" | "error";
  latencyMs: number | null;
  cost: number | null;
  confidence: number | null;
  error?: string;
  results: Record<string, { data: unknown; confidence: number | null; format: string }>;
}
interface Review {
  selectedMethod: string;
  docType: string;
  text: string;
  fields: FdField[];
  tables: FdTable[];
  summary: string | null;
  piiDetected: { type: string; count: number }[];
  piiRedacted: boolean;
  editedBy: string;
  editedAt: string;
}
interface Job {
  documentId: string;
  tenantId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount?: number;
  status: string;
  capabilities: string[];
  methodRuns: MethodRun[];
  runError?: string;
  review?: Review;
  submittedBy?: string;
  submittedAt?: string;
  sentBackNote?: string;
  finalizedDocumentIds: string[];
  documentTypeId?: string;
  documentTypeVersion?: number;
  typeSource?: "chosen" | "detected";
  validation?: Validation;
  route?: "straight-through" | "auto-finalized" | "exception" | "manual";
  override?: { by: string; justification: string; at: string };
}
interface Issue { ruleId: string; severity: "block" | "warn"; field?: string; message: string }
interface Validation {
  at: string; issues: Issue[]; clean: boolean; requiredPresent: number; requiredTotal: number; lowConfidence: string[]; skipped: string[];
}
interface TypeInfo {
  id: string; key: string; name: string; version: number; tenantId: string;
  spec: { fields: { name: string; label?: string; type: string; required: boolean }[]; methods: string[]; capabilities: string[];
    routing: { minConfidence: number; straightThrough: boolean; autoFinalize: boolean } };
}

const ROUTE_STYLE: Record<string, string> = {
  "straight-through": "bg-green-50 text-green-700",
  "auto-finalized": "bg-green-50 text-green-700",
  exception: "bg-amber-50 text-amber-800",
  manual: "bg-slate-100 text-slate-600",
};
interface Health {
  idp: { configured: boolean; ok: boolean; detail: string };
  delta: { configured: boolean; table?: string };
  limits: { maxUploadBytes: number; types: string[] };
  defaults: { methods: string[]; capabilities: string[] };
}
interface FinalizedRecord {
  doc: Record<string, unknown> & { finalizedDocumentId: string; version: number; contentSha256: string };
  delta: { status: string; detail?: string; at?: string };
}

const ALL_METHODS = [
  "claude-haiku", "claude-sonnet", "nova-lite", "nova-pro", "textract-claude-haiku", "textract-claude-sonnet",
];
/** Shown next to methods with input limits in this deployment. */
const METHOD_NOTES: Record<string, string> = {
  "textract-claude-haiku": "single-page PDF or image ≤ 5 MB",
  "textract-claude-sonnet": "single-page PDF or image ≤ 5 MB",
};
const ALL_CAPABILITIES = [
  "text_extraction", "kv_extraction", "table_extraction", "document_classification", "pii_detection",
  "pii_redaction", "entity_extraction", "document_summarization", "invoice_processing", "contract_analysis",
  "handwriting_extraction", "signature_detection", "barcode_qr", "language_detection",
];

const STATUS_STYLE: Record<string, string> = {
  uploaded: "bg-slate-100 text-slate-600",
  processing: "bg-blue-50 text-blue-700",
  extracted: "bg-teal-50 text-teal-700",
  failed: "bg-red-50 text-red-700",
  "in-review": "bg-amber-50 text-amber-800",
  "pending-finalization": "bg-indigo-50 text-indigo-700",
  finalized: "bg-green-50 text-green-700",
};

function Status({ s }: { s: string }) {
  return <span className={`badge ${STATUS_STYLE[s] ?? "bg-slate-100 text-slate-600"}`}>{s}</span>;
}

function show(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export default function DocumentsPage() {
  const acting = useActingPersona();
  const personaId = acting.personaId;
  const persona = acting.personas.find((p) => p.id === personaId);
  const tenants = useMemo(() => (persona?.memberships ?? []).map((m) => m.tenantId), [persona]);
  const [tenantId, setTenantId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [methods, setMethods] = useState<string[]>([]);
  const [caps, setCaps] = useState<string[]>([]);
  const [draft, setDraft] = useState<Review | null>(null);
  const [note, setNote] = useState("");
  const [finalized, setFinalized] = useState<FinalizedRecord | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [typesByTenant, setTypesByTenant] = useState<Record<string, TypeInfo[]>>({});
  const [uploadTypeId, setUploadTypeId] = useState("");
  const [justification, setJustification] = useState("");

  const job = jobs.find((j) => j.documentId === selectedId) ?? null;
  const jobTypeInfo = job?.documentTypeId ? (typesByTenant[job.tenantId] ?? []).find((t) => t.id === job.documentTypeId) : undefined;
  const blocking = (job?.validation?.issues ?? []).filter((i) => i.severity === "block");

  // Published Document Types per tenant (upload choice, expected fields in review).
  async function loadTypes(t: string) {
    if (!t || !personaId || typesByTenant[t]) return;
    const r = await getJSON<{ available: TypeInfo[] }>(`/api/docintel?personaId=${encodeURIComponent(personaId)}&types=1&tenantId=${encodeURIComponent(t)}`);
    setTypesByTenant((m) => ({ ...m, [t]: r.available }));
  }
  useEffect(() => { loadTypes(tenantId).catch(() => undefined); }, [tenantId, personaId]);
  useEffect(() => { if (job) loadTypes(job.tenantId).catch(() => undefined); }, [job?.tenantId, personaId]);
  // A chosen type preselects its methods and capabilities for the first run.
  useEffect(() => {
    if (jobTypeInfo && job?.typeSource === "chosen" && !job.methodRuns.length) {
      setMethods(jobTypeInfo.spec.methods);
      setCaps(jobTypeInfo.spec.capabilities);
    }
    setJustification("");
  }, [selectedId, jobTypeInfo?.id]);

  // Deep link from the Approval Inbox: /documents?doc=<documentId>
  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get("doc");
    if (d) setSelectedId(d);
  }, []);

  useEffect(() => {
    getJSON<Health>("/api/docintel?health=1").then((h) => {
      setHealth(h);
      setMethods(h.defaults.methods.slice(0, 2));
      setCaps(h.defaults.capabilities);
    }).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (!tenants.includes(tenantId)) setTenantId(tenants[0] ?? "");
  }, [tenants]);

  async function refresh() {
    if (!personaId) { setJobs([]); return; }
    const r = await getJSON<{ jobs: Job[] }>(`/api/docintel?personaId=${encodeURIComponent(personaId)}`);
    setJobs(r.jobs);
  }
  useEffect(() => { refresh().catch((e: Error) => setError(e.message)); }, [personaId]);

  // Keep the review editor in step with the selected job.
  // Required / expected fields the extraction did not find get an empty
  // placeholder, so the reviewer can type into them in place.
  useEffect(() => {
    if (!job?.review) { setDraft(null); return; }
    const d = structuredClone(job.review);
    for (const sf of jobTypeInfo?.spec.fields ?? []) {
      if (!d.fields.some((f) => f.name === sf.name)) d.fields.push({ name: sf.name, value: "", edited: false, confidence: null });
    }
    setDraft(d);
  }, [selectedId, job?.updatedAt, jobTypeInfo?.id]);
  /** Fields to save: everything extracted, plus placeholders the reviewer filled in. */
  const fieldsToSave = (d: Review) =>
    d.fields.filter((f) => job?.review?.fields.some((o) => o.name === f.name) || (typeof f.value === "string" ? f.value.trim() !== "" : f.value != null));
  // The finalized view belongs to the document, not to its last refresh: a
  // refresh right after Finalize must not hide what was just produced.
  useEffect(() => {
    setFinalized(null);
  }, [selectedId]);

  // Poll while extraction runs.
  useEffect(() => {
    if (!jobs.some((j) => j.status === "processing")) return;
    const t = setTimeout(() => refresh().catch(() => undefined), 3000);
    return () => clearTimeout(t);
  }, [jobs]);

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

  async function upload() {
    if (!file) return;
    await act("upload", async () => {
      const max = health?.limits.maxUploadBytes ?? 25 * 1024 * 1024;
      if (file.size > max) {
        throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${max / 1024 / 1024} MB`);
      }
      const form = new FormData();
      form.append("file", file);
      form.append("tenantId", tenantId);
      form.append("personaId", personaId);
      if (uploadTypeId) form.append("documentTypeId", uploadTypeId);
      const res = await fetch(withBase("/api/docintel"), { method: "POST", body: form });
      // A proxy in front of the app (e.g. nginx's 413) answers with HTML, not JSON.
      const raw = await res.text();
      let body: { job?: Job; error?: string } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        const title = /<title>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim();
        throw new Error(`upload failed: HTTP ${res.status}${title ? ` (${title})` : ""}`);
      }
      if (!res.ok || !body.job) throw new Error(body.error ?? `upload failed: ${res.status}`);
      setSelectedId(body.job.documentId);
      setFile(null);
    });
  }

  const post = (body: Record<string, unknown>) =>
    sendJSON<{ job: Job; finalized?: FinalizedRecord }>("/api/docintel", "POST", { personaId, documentId: selectedId, ...body });

  async function openFinalized(id: string) {
    await act("open", async () => {
      setFinalized(await getJSON<FinalizedRecord>(
        `/api/docintel?personaId=${encodeURIComponent(personaId)}&finalizedDocumentId=${encodeURIComponent(id)}`));
    });
  }

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const editable = job && ["extracted", "in-review", "finalized"].includes(job.status);
  const isSubmitter = job?.submittedBy === personaId;

  return (
    <>
      <PageHeader
        title="Document Intelligence"
        subtitle="Extract with IDP, check against the Document Type, review the exceptions, then finalize with a second person. Finalized documents feed the RAG Factory and Delta."
        action={<div className="flex gap-2"><Link className="btn-ghost" href="/documents/types">Document types</Link><Link className="btn-ghost" href="/documents/quality">Quality</Link></div>}
      />
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <section className="card mb-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <ActingAsSelect {...acting}
              hint="Upload and review need analyst+ in the tenant; finalizing needs approver+ and must be a different person from the submitter. GxP tenants require GxP-trained personas." />
            <Field label="Tenant">
              <select className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)} disabled={!tenants.length}>
                {tenants.map((t) => <option key={t} value={t}>{t}</option>)}
                {!tenants.length && <option value="">Select a persona first</option>}
              </select>
            </Field>
            <Field label="Document type" hint="Auto-detect picks a published type from the classification">
              <select className="input" value={uploadTypeId} onChange={(e) => setUploadTypeId(e.target.value)}>
                <option value="">Auto-detect</option>
                {(typesByTenant[tenantId] ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>)}
              </select>
            </Field>
            <Field label="Document" hint={health ? `${health.limits.types.join(", ")} · up to ${health.limits.maxUploadBytes / 1024 / 1024} MB` : undefined}>
              <input type="file" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <div className="flex items-end">
              <button className="btn-primary" onClick={upload} disabled={!file || !personaId || !tenantId || busy !== ""}>
                {busy === "upload" ? "Uploading…" : "Upload"}
              </button>
            </div>
          </div>
          {health && (
            <p className="mt-3 text-xs text-slate-500">
              IDP engine: {health.idp.configured ? (health.idp.ok ? "healthy" : `unreachable (${health.idp.detail})`) : "not configured"}
              {" · "}Delta: {health.delta.configured ? health.delta.table : "not configured (finalized documents stay in the control plane)"}
            </p>
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <aside className="card h-fit p-0">
            <div className="border-b px-4 py-3 text-sm font-medium">Documents</div>
            {!personaId && <EmptyState text="Choose who you are acting as." />}
            {personaId && !jobs.length && <EmptyState text="No documents you can view yet." />}
            <ul>
              {jobs.map((j) => (
                <li key={j.documentId}>
                  <button
                    className={`w-full border-b px-4 py-2 text-left text-sm hover:bg-slate-50 ${j.documentId === selectedId ? "bg-slate-50" : ""}`}
                    onClick={() => setSelectedId(j.documentId)}>
                    <div className="truncate font-medium">{j.fileName}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <Status s={j.status} /> {j.tenantId}
                      {j.route && j.route !== "manual" && <span className={`badge ${ROUTE_STYLE[j.route]}`}>{j.route}</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <main className="space-y-4">
            {!job && <section className="card p-5"><EmptyState text="Select or upload a document." /></section>}
            {job && (
              <>
                <section className="card p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="font-semibold">{job.fileName}</h2>
                      <p className="text-xs text-slate-500">
                        {job.documentId} · {job.tenantId} · {(job.sizeBytes / 1024).toFixed(1)} KB
                        {job.pageCount ? ` · ${job.pageCount} page(s)` : ""} · sha256 {job.sha256.slice(0, 12)}…
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        Document type: {jobTypeInfo ? <b>{jobTypeInfo.name} v{job.documentTypeVersion ?? jobTypeInfo.version}</b> : job.documentTypeId ?? "none"}
                        {job.typeSource ? ` (${job.typeSource})` : job.methodRuns.length ? " (no published type matched; manual review)" : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {job.route && <span className={`badge ${ROUTE_STYLE[job.route]}`}>{job.route}</span>}
                      <Status s={job.status} />
                    </div>
                  </div>
                  {job.runError && <p className="mt-2 text-sm text-red-700">{job.runError}</p>}
                  {job.sentBackNote && <p className="mt-2 text-sm text-amber-800">Sent back: {job.sentBackNote}</p>}

                  {!["processing", "pending-finalization"].includes(job.status) && (
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <Field label="Methods">
                        <div className="flex flex-wrap gap-2">
                          {ALL_METHODS.map((m) => (
                            <label key={m} className="flex items-center gap-1 text-xs">
                              <input type="checkbox" checked={methods.includes(m)} onChange={() => toggle(methods, setMethods, m)} /> {m}
                              {METHOD_NOTES[m] && <span className="text-slate-400">({METHOD_NOTES[m]})</span>}
                            </label>
                          ))}
                        </div>
                      </Field>
                      <Field label="Capabilities">
                        <div className="flex flex-wrap gap-2">
                          {ALL_CAPABILITIES.map((c) => (
                            <label key={c} className="flex items-center gap-1 text-xs">
                              <input type="checkbox" checked={caps.includes(c)} onChange={() => toggle(caps, setCaps, c)} /> {c}
                            </label>
                          ))}
                        </div>
                      </Field>
                      <div>
                        <button className="btn-primary" disabled={busy !== "" || !methods.length || !caps.length}
                          onClick={() => act("run", () => post({ op: "run", methods, capabilities: caps }))}>
                          {job.methodRuns.length ? "Re-run extraction" : "Run extraction"}
                        </button>
                      </div>
                    </div>
                  )}
                  {job.status === "processing" && <p className="mt-3 text-sm text-blue-700">Extraction running…</p>}
                </section>

                {job.methodRuns.length > 0 && (
                  <section className="card overflow-x-auto p-5">
                    <h3 className="mb-2 text-sm font-semibold">Method comparison</h3>
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-slate-500">
                        <tr><th className="py-1">Method</th><th>Status</th><th>Latency</th><th>Cost</th><th>Confidence</th><th>Capabilities</th><th /></tr>
                      </thead>
                      <tbody>
                        {job.methodRuns.map((r) => (
                          <tr key={r.method} className="border-t">
                            <td className="py-1 font-mono text-xs">{r.method}</td>
                            <td>{r.status === "complete" ? "complete" : <span className="text-red-700">error{r.error ? `: ${r.error.slice(0, 120)}` : ""}</span>}</td>
                            <td>{r.latencyMs !== null ? `${(r.latencyMs / 1000).toFixed(1)} s` : "—"}</td>
                            <td>{r.cost !== null ? `$${r.cost.toFixed(4)}` : "—"}</td>
                            <td>{r.confidence !== null ? r.confidence.toFixed(2) : "—"}</td>
                            <td className="text-xs">{Object.keys(r.results).length}</td>
                            <td>
                              {editable && r.status === "complete" && draft?.selectedMethod !== r.method && (
                                <button className="btn-ghost text-xs" disabled={busy !== ""}
                                  onClick={() => act("select", () => post({ op: "review", selectedMethod: r.method }))}>
                                  Use for review
                                </button>
                              )}
                              {draft?.selectedMethod === r.method && <span className="text-xs text-teal-700">in review</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )}

                {job.validation && (
                  <section className="card space-y-2 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        Validation {job.validation.clean
                          ? <span className="badge ml-2 bg-green-50 text-green-700">✓ clean</span>
                          : <span className="badge ml-2 bg-amber-50 text-amber-800">⚠ {blocking.length} blocking · {job.validation.issues.length - blocking.length} warning(s)</span>}
                      </h3>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        required fields {job.validation.requiredPresent}/{job.validation.requiredTotal} · checked {job.validation.at.slice(11, 19)} UTC
                        {editable && (
                          <button className="btn-ghost text-xs" disabled={busy !== ""} onClick={() => act("validate", () => post({ op: "validate" }))}>
                            Re-validate
                          </button>
                        )}
                      </div>
                    </div>
                    {job.validation.issues.length > 0 && (
                      <ul className="space-y-1 text-sm">
                        {job.validation.issues.map((i, k) => (
                          <li key={k} className={i.severity === "block" ? "text-red-700" : "text-amber-800"}>
                            {i.severity === "block" ? "✕ Blocking" : "⚠ Warning"}: {i.message}
                            <span className="ml-2 font-mono text-xs text-slate-400">{i.ruleId}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {job.validation.skipped.length > 0 && (
                      <p className="text-xs text-slate-500">Not evaluated (data missing or source unavailable): {job.validation.skipped.join(", ")}</p>
                    )}
                    {job.override && (
                      <p className="text-xs text-slate-600">Override by {acting.personas.find((p) => p.id === job.override!.by)?.name ?? job.override.by}: {job.override.justification}</p>
                    )}
                  </section>
                )}

                {draft && (
                  <section className="card space-y-4 p-5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold">Review — {draft.selectedMethod}</h3>
                      <span className="text-xs text-slate-500">
                        PII: {draft.piiRedacted ? "redacted" : draft.piiDetected.length
                          ? draft.piiDetected.map((p) => `${p.type}×${p.count}`).join(", ") : "none detected"}
                      </span>
                    </div>
                    <Field label="Document type">
                      <input className="input" value={draft.docType} disabled={!editable}
                        onChange={(e) => setDraft({ ...draft, docType: e.target.value })} />
                    </Field>
                    <div>
                      <span className="label">Fields</span>
                      {!draft.fields.length && !jobTypeInfo && <p className="text-xs text-slate-500">No fields extracted.</p>}
                      <div className="space-y-1">
                        {draft.fields.map((f, i) => {
                          const specField = jobTypeInfo?.spec.fields.find((x) => x.name === f.name);
                          const fieldIssues = (job.validation?.issues ?? []).filter((x) => x.field === f.name);
                          return (
                            <div key={f.name}>
                              <div className="grid grid-cols-[14rem_1fr_4rem] items-center gap-2 text-sm">
                                <span className={`truncate text-xs ${specField ? "font-medium" : "font-mono text-slate-500"}`} title={f.name}>
                                  {specField?.label ?? f.name}{specField?.required ? " *" : ""}
                                </span>
                                <input className={`input py-1 ${fieldIssues.some((x) => x.severity === "block") ? "border-red-400" : f.edited ? "border-amber-400" : ""}`}
                                  value={show(f.value)} disabled={!editable}
                                  title={f.edited ? `was: ${show(f.originalValue)}` : undefined}
                                  onChange={(e) => {
                                    const fields = [...draft.fields];
                                    fields[i] = { ...f, value: e.target.value };
                                    setDraft({ ...draft, fields });
                                  }} />
                                <span className="text-xs text-slate-500">
                                  {typeof f.confidence === "number" ? f.confidence.toFixed(2)
                                    : specField?.required && !job.review?.fields.some((o) => o.name === f.name) ? <span className="text-red-700">missing</span> : ""}
                                </span>
                              </div>
                              {fieldIssues.map((x, k) => (
                                <p key={k} className={`ml-[14.5rem] text-xs ${x.severity === "block" ? "text-red-700" : "text-amber-800"}`}>{x.message}</p>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {draft.tables.map((t, ti) => (
                      <div key={ti} className="overflow-x-auto">
                        <span className="label">Table {t.name ?? ti + 1}</span>
                        <table className="text-xs">
                          <thead><tr>{t.columns.map((c, ci) => <th key={ci} className="border px-2 py-1 text-left">{c}</th>)}</tr></thead>
                          <tbody>{t.rows.slice(0, 50).map((row, ri) => (
                            <tr key={ri}>{row.map((c, ci) => <td key={ci} className="border px-2 py-1">{show(c)}</td>)}</tr>
                          ))}</tbody>
                        </table>
                      </div>
                    ))}
                    <Field label="Text">
                      <textarea className="input h-48 font-mono text-xs" value={draft.text} disabled={!editable}
                        onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                    </Field>

                    <div className="flex flex-wrap gap-2">
                      {editable && (
                        <button className="btn-ghost" disabled={busy !== ""}
                          onClick={() => act("save", () => post({ op: "review", edits: {
                            docType: draft.docType, text: draft.text, fields: fieldsToSave(draft), tables: draft.tables, summary: draft.summary,
                          } }))}>
                          Save review
                        </button>
                      )}
                      {editable && (
                        <button className="btn-primary" disabled={busy !== "" || (blocking.length > 0 && justification.trim().length < 10)}
                          title={blocking.length ? "Blocking issues: fix them, or give a justification (10+ characters)" : undefined}
                          onClick={() => act("submit", async () => {
                            await post({ op: "review", edits: { docType: draft.docType, text: draft.text, fields: fieldsToSave(draft), tables: draft.tables } });
                            return post({ op: "submit", ...(justification.trim() ? { justification } : {}) });
                          })}>
                          {job.status === "finalized" ? "Submit new version" : blocking.length ? "Submit with justification" : "Submit for finalization"}
                        </button>
                      )}
                    </div>
                    {editable && blocking.length > 0 && (
                      <Field label="Justification for submitting with blocking issues" hint="Recorded in the audit trail and in the finalized record. Saving a corrected value and re-validating clears the issue instead.">
                        <textarea className="input h-16 text-sm" value={justification} onChange={(e) => setJustification(e.target.value)}
                          placeholder="e.g. OOS investigation QA-2026-114 closed; retest result attached" />
                      </Field>
                    )}
                  </section>
                )}

                {job.status === "pending-finalization" && (
                  <section className="card space-y-3 p-5">
                    <h3 className="text-sm font-semibold">Finalization</h3>
                    <p className="text-xs text-slate-500">
                      Submitted by {acting.personas.find((p) => p.id === job.submittedBy)?.name ?? job.submittedBy} at {job.submittedAt}.
                      {isSubmitter && " You submitted this document, so a different approver must finalize it."}
                    </p>
                    {job.validation && (
                      <p className={`text-sm ${job.validation.clean ? "text-green-700" : "text-amber-800"}`}>
                        {job.validation.clean
                          ? `✓ Clean against ${jobTypeInfo?.name ?? "its document type"}${job.route === "straight-through" ? ": submitted straight through" : ""}.`
                          : `⚠ ${job.validation.issues.length} validation issue(s)${job.override ? `, overridden: "${job.override.justification}"` : ""}; see Validation above.`}
                      </p>
                    )}
                    <Field label="Note (optional for finalize, required to send back)">
                      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
                    </Field>
                    <div className="flex gap-2">
                      <button className="btn-primary" disabled={busy !== "" || isSubmitter}
                        onClick={() => act("finalize", async () => {
                          const r = await post({ op: "finalize", note });
                          setNote("");
                          if (r.finalized) setFinalized(r.finalized);
                        })}>
                        Finalize
                      </button>
                      <button className="btn-ghost" disabled={busy !== "" || !note.trim()}
                        onClick={() => act("sendBack", async () => { await post({ op: "sendBack", note }); setNote(""); })}>
                        Send back
                      </button>
                    </div>
                  </section>
                )}

                {job.finalizedDocumentIds.length > 0 && (
                  <section className="card space-y-3 p-5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold">Finalized versions</h3>
                      <Link className="btn-ghost text-xs" href={`/rag?tenant=${encodeURIComponent(job.tenantId)}`}>
                        Build a RAG corpus →
                      </Link>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {job.finalizedDocumentIds.map((id, i) => (
                        <button key={id} className="btn-ghost text-xs" onClick={() => openFinalized(id)}>
                          v{i + 1} · {id}
                        </button>
                      ))}
                    </div>
                    {finalized && (
                      <>
                        <p className="text-xs text-slate-500">
                          Delta: {finalized.delta.status}{finalized.delta.detail ? ` — ${finalized.delta.detail}` : ""}
                          {" · "}content sha256 {finalized.doc.contentSha256}
                        </p>
                        <pre className="max-h-96 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                          {JSON.stringify(finalized.doc, null, 2)}
                        </pre>
                      </>
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
