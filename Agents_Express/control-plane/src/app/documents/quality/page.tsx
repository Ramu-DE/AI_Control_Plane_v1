"use client";

// Document Intelligence quality: straight-through rate, corrections,
// exceptions, time to finalize and cost, by Document Type and by method.
// Computed server-side from what the module records; nothing is sampled.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { ActingAsSelect, useActingPersona } from "@/components/ActingAs";

interface TypeStats {
  documentType: string; documents: number; finalized: number; straightThrough: number; autoFinalized: number;
  exceptions: number; overrides: number; stpRate: number | null; fieldsFinalized: number; fieldsCorrected: number;
  correctionRate: number | null; medianMinutesToFinalize: number | null; avgCostUsd: number | null;
}
interface MethodStats {
  method: string; runs: number; completed: number; successRate: number; avgLatencyMs: number | null;
  avgCostUsd: number | null; avgConfidence: number | null; selected: number; correctionRate: number | null;
}
interface Analytics {
  totals: { documents: number; finalized: number; pending: number; exceptionsOpen: number; stpRate: number | null;
    correctionRate: number | null; medianMinutesToFinalize: number | null; totalCostUsd: number };
  byType: TypeStats[];
  byMethod: MethodStats[];
  topCorrectedFields: { documentType: string; field: string; corrections: number; finalized: number; example?: { from: unknown; to: unknown } }[];
  topIssues: { documentType: string; ruleId: string; count: number; example: string }[];
}

interface Calibrator {
  id: string; version: number; status: string; trainedAt: string; documents: number; labels: number; positives: number;
  target: number; ece: number; requiredSample: number; consensusAccuracy: number | null;
  bestSingleMethodAccuracy: { method: string; accuracy: number } | null;
  suggestedSynonyms?: { field: string; name: string; count: number }[];
  threshold: { threshold: number | null; accepted: number; precision: number | null; lowerBound: number | null; coverage: number; reason: string };
  methodStats: { method: string; field: string; correct: number; total: number; accuracy: number }[];
  reliabilityBins: { lo: number; hi: number; n: number; meanP: number; accuracy: number }[];
  activatedBy?: string; activatedAt?: string;
}
interface AccuracyType { id: string; name: string; tenantId: string; version: number; target: number; active: Calibrator | null; candidate: Calibrator | null }

function CalibratorCard({ c, title, onSynonyms }: { c: Calibrator; title: string; onSynonyms?: (s: { field: string; name: string }[]) => void }) {
  const fields = [...new Set(c.methodStats.map((m) => m.field))];
  const methods = [...new Set(c.methodStats.map((m) => m.method))];
  return (
    <div className="rounded border p-3 text-xs">
      <div className="mb-2 font-medium">{title} v{c.version} · trained {c.trainedAt.slice(0, 16).replace("T", " ")} · {c.documents} document(s), {c.labels} labelled field(s)</div>
      <div className="mb-2 grid gap-2 sm:grid-cols-4">
        <div>Consensus accuracy <b className="tabular-nums">{pct(c.consensusAccuracy)}</b></div>
        <div>Best single method <b className="tabular-nums">{c.bestSingleMethodAccuracy ? `${pct(c.bestSingleMethodAccuracy.accuracy)} (${c.bestSingleMethodAccuracy.method})` : "—"}</b></div>
        <div>Calibration error (ECE) <b className="tabular-nums">{c.labels ? c.ece.toFixed(3) : "—"}</b></div>
        <div>Auto-accept {c.threshold.threshold === null
          ? <b className="text-amber-800">off</b>
          : <b className="text-green-700">P ≥ {c.threshold.threshold.toFixed(3)} · {pct(c.threshold.coverage)} of fields</b>}</div>
      </div>
      <p className="mb-2 text-slate-600">
        {c.threshold.threshold === null ? `Why off: ${c.threshold.reason}.` : `Proven: ${c.threshold.reason} (lower bound ${((c.threshold.lowerBound ?? 0) * 100).toFixed(2)}%).`}
        {" "}Target {(c.target * 100).toFixed(1)}% needs ≥ {c.requiredSample} verified error-free fields.
      </p>
      {(c.suggestedSynonyms ?? []).length > 0 && (
        <div className="mb-2 rounded bg-amber-50 p-2 text-amber-900">
          Learned from finalized documents: these extracted labels carried the approved value but are not synonyms yet, so the field was missed:{" "}
          {c.suggestedSynonyms!.map((s) => `"${s.name}" → ${s.field} (${s.count}×)`).join(", ")}.
          {onSynonyms && (
            <button className="btn-ghost ml-2 text-xs" onClick={() => onSynonyms(c.suggestedSynonyms!.map(({ field, name }) => ({ field, name })))}>
              Add to the type's draft (needs approval)
            </button>
          )}
        </div>
      )}
      {fields.length > 0 && (
        <table className="w-full">
          <thead className="text-left text-slate-500"><tr><th className="py-1">Field (measured accuracy)</th>{methods.map((m) => <th key={m} className="font-mono">{m}</th>)}</tr></thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f} className="border-t">
                <td className="py-1 font-mono">{f}</td>
                {methods.map((m) => {
                  const st = c.methodStats.find((x) => x.field === f && x.method === m);
                  return <td key={m} className="tabular-nums">{st ? `${pct(st.accuracy)} (${st.correct}/${st.total})` : "—"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const money = (v: number | null) => (v === null ? "—" : `$${v.toFixed(v < 0.1 ? 4 : 2)}`);
function duration(min: number | null): string {
  if (min === null) return "—";
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)} h`;
  return `${(min / 1440).toFixed(1)} d`;
}
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** A single ratio on a same-hue track; the value is always printed as text too. */
function Meter({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="flex items-center gap-2" title={`${label}: ${pct(value)}`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-teal-100" role="meter" aria-label={label}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}>
        {value !== null && <div className="h-full rounded-full bg-teal-600" style={{ width: `${Math.round(value * 100)}%` }} />}
      </div>
      <span className="tabular-nums text-slate-700">{pct(value)}</span>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4" title={hint}>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export default function QualityPage() {
  const acting = useActingPersona();
  const personaId = acting.personaId;
  const persona = acting.personas.find((p) => p.id === personaId);
  const tenants = useMemo(() => (persona?.memberships ?? []).map((m) => m.tenantId), [persona]);
  const [tenantId, setTenantId] = useState("");
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState("");
  const [acc, setAcc] = useState<AccuracyType[]>([]);
  const [busy, setBusy] = useState("");
  async function loadAccuracy() {
    if (!personaId) { setAcc([]); return; }
    const r = await getJSON<{ types: AccuracyType[] }>(`/api/docintel?personaId=${encodeURIComponent(personaId)}&accuracy=1`);
    setAcc(r.types);
  }
  useEffect(() => { loadAccuracy().catch(() => undefined); }, [personaId]);
  async function calAct(label: string, body: Record<string, unknown>) {
    setBusy(label); setError("");
    try { await sendJSON("/api/docintel", "POST", { personaId, ...body }); await loadAccuracy(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }

  useEffect(() => {
    if (!personaId) { setData(null); return; }
    setError("");
    getJSON<Analytics>(`/api/docintel?personaId=${encodeURIComponent(personaId)}&analytics=1${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ""}`)
      .then(setData).catch((e: Error) => setError(e.message));
  }, [personaId, tenantId]);

  const t = data?.totals;
  return (
    <>
      <PageHeader
        title="Document Intelligence quality"
        subtitle="How much flows straight through, what people still correct, and what each method costs. Computed from the documents you are allowed to see."
        action={<div className="flex gap-2"><Link className="btn-ghost" href="/documents">Documents</Link><Link className="btn-ghost" href="/documents/types">Document types</Link></div>}
      />
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <section className="card mb-4 flex flex-wrap items-end gap-3 p-5">
          <ActingAsSelect {...acting} hint="Viewer+ in a tenant sees its documents' statistics." />
          <Field label="Tenant">
            <select className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">All I can see</option>
              {tenants.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
        </section>

        {!personaId && <EmptyState text="Choose who you are acting as." />}
        {t && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
              <Tile label="Documents" value={String(t.documents)} />
              <Tile label="Finalized" value={String(t.finalized)} hint={`${t.pending} awaiting a finalizer`} />
              <Tile label="Straight-through" value={pct(t.stpRate)} hint="finalized with no analyst edits" />
              <Tile label="Fields corrected" value={pct(t.correctionRate)} hint="of fields finalized" />
              <Tile label="Open exceptions" value={String(t.exceptionsOpen)} hint="failed validation, awaiting review" />
              <Tile label="Median time to finalize" value={duration(t.medianMinutesToFinalize)} hint="upload → finalized" />
              <Tile label="Extraction cost" value={money(t.totalCostUsd)} hint="all method runs" />
            </div>

            <section className="card mb-4 overflow-x-auto p-5">
              <h3 className="mb-2 text-sm font-semibold">By document type</h3>
              {!data!.byType.length ? <EmptyState text="No documents yet." /> : (
                <table className="w-full min-w-[60rem] text-sm">
                  <thead className="text-left text-xs text-slate-500">
                    <tr><th className="py-1">Type</th><th>Docs</th><th>Finalized</th><th>Straight-through</th><th>Auto</th>
                      <th>Exceptions</th><th>Overrides</th><th>Fields corrected</th><th>Median to finalize</th><th>Cost / doc</th></tr>
                  </thead>
                  <tbody>
                    {data!.byType.map((r) => (
                      <tr key={r.documentType} className="border-t">
                        <td className="py-1.5 font-medium">{r.documentType}</td>
                        <td className="tabular-nums">{r.documents}</td>
                        <td className="tabular-nums">{r.finalized}</td>
                        <td><Meter value={r.stpRate} label={`${r.documentType} straight-through rate`} /></td>
                        <td className="tabular-nums">{r.autoFinalized}</td>
                        <td className="tabular-nums">{r.exceptions}</td>
                        <td className="tabular-nums">{r.overrides}</td>
                        <td><Meter value={r.correctionRate} label={`${r.documentType} field correction rate`} />
                          <span className="text-xs text-slate-400">{r.fieldsCorrected}/{r.fieldsFinalized}</span></td>
                        <td className="tabular-nums">{duration(r.medianMinutesToFinalize)}</td>
                        <td className="tabular-nums">{money(r.avgCostUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card mb-4 overflow-x-auto p-5">
              <h3 className="mb-2 text-sm font-semibold">By extraction method</h3>
              <table className="w-full min-w-[50rem] text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr><th className="py-1">Method</th><th>Runs</th><th>Success</th><th>Avg latency</th><th>Avg cost</th>
                    <th>Avg confidence</th><th>Chosen for review</th><th>Fields corrected when chosen</th></tr>
                </thead>
                <tbody>
                  {data!.byMethod.map((m) => (
                    <tr key={m.method} className="border-t">
                      <td className="py-1.5 font-mono text-xs">{m.method}</td>
                      <td className="tabular-nums">{m.runs}</td>
                      <td><Meter value={m.successRate} label={`${m.method} success rate`} /></td>
                      <td className="tabular-nums">{m.avgLatencyMs === null ? "—" : `${(m.avgLatencyMs / 1000).toFixed(1)} s`}</td>
                      <td className="tabular-nums">{money(m.avgCostUsd)}</td>
                      <td className="tabular-nums">{m.avgConfidence === null ? "—" : m.avgConfidence.toFixed(2)}</td>
                      <td className="tabular-nums">{m.selected}</td>
                      <td><Meter value={m.correctionRate} label={`${m.method} correction rate when chosen`} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card mb-4 space-y-3 overflow-x-auto p-5">
              <div>
                <h3 className="text-sm font-semibold">Accuracy and calibration</h3>
                <p className="text-xs text-slate-500">
                  Measured against four-eyes-finalized values. Every method's output is compared with what was approved; the methods are
                  combined by weighted vote; a calibrator turns agreement, grounding and format into P(correct). Auto-accept is enabled only at a
                  threshold whose precision is proven with 95% confidence, and only once an approver activates the calibrator.
                </p>
              </div>
              {acc.map((t) => (
                <div key={t.id} className="space-y-2 rounded-lg bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{t.name} <span className="text-xs text-slate-500">v{t.version} · {t.tenantId} · target {(t.target * 100).toFixed(1)}%</span></span>
                    <div className="flex gap-2">
                      <button className="btn-ghost text-xs" disabled={busy !== ""} onClick={() => calAct(`train-${t.id}`, { op: "calibrationTrain", typeId: t.id })}>
                        {busy === `train-${t.id}` ? "Training…" : "Retrain candidate"}
                      </button>
                      {t.candidate && (
                        <button className="btn-primary text-xs" disabled={busy !== ""} onClick={() => calAct(`act-${t.id}`, { op: "calibrationActivate", calibratorId: t.candidate!.id })}>
                          Activate candidate v{t.candidate.version}
                        </button>
                      )}
                    </div>
                  </div>
                  {t.active ? <CalibratorCard c={t.active} title="Active" /> : <p className="text-xs text-amber-800">No active calibrator: every document of this type is reviewed by a person.</p>}
                  {t.candidate && <CalibratorCard c={t.candidate} title="Candidate"
                    onSynonyms={(syn) => calAct(`syn-${t.id}`, { op: "typeAddSynonyms", typeId: t.id, synonyms: syn })} />}
                </div>
              ))}
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="card overflow-x-auto p-5">
                <h3 className="mb-2 text-sm font-semibold">Most corrected fields</h3>
                {!data!.topCorrectedFields.length ? <EmptyState text="No corrections yet." /> : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-slate-500"><tr><th className="py-1">Type</th><th>Field</th><th>Corrected</th><th>Example</th></tr></thead>
                    <tbody>
                      {data!.topCorrectedFields.map((f) => (
                        <tr key={f.documentType + f.field} className="border-t">
                          <td className="py-1.5 text-xs">{f.documentType}</td>
                          <td className="font-mono text-xs">{f.field}</td>
                          <td className="tabular-nums">{f.corrections}/{f.finalized}</td>
                          <td className="text-xs text-slate-600">{f.example ? `${show(f.example.from)} → ${show(f.example.to)}` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <section className="card overflow-x-auto p-5">
                <h3 className="mb-2 text-sm font-semibold">Most frequent validation issues</h3>
                {!data!.topIssues.length ? <EmptyState text="No validation issues recorded." /> : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-slate-500"><tr><th className="py-1">Type</th><th>Rule</th><th>Count</th><th>Example</th></tr></thead>
                    <tbody>
                      {data!.topIssues.map((i) => (
                        <tr key={i.documentType + i.ruleId} className="border-t">
                          <td className="py-1.5 text-xs">{i.documentType}</td>
                          <td className="font-mono text-xs">{i.ruleId}</td>
                          <td className="tabular-nums">{i.count}</td>
                          <td className="text-xs text-slate-600">{i.example}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
