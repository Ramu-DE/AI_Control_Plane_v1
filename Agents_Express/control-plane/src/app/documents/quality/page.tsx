"use client";

// Document Intelligence quality: straight-through rate, corrections,
// exceptions, time to finalize and cost, by Document Type and by method.
// Computed server-side from what the module records; nothing is sampled.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, EmptyState } from "@/components/ui";
import { getJSON } from "@/lib/api";
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
