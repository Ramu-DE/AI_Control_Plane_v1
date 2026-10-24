"use client";

// Document Types: what a kind of document must contain, how it is checked,
// and how it is routed. Drafts are edited here and published by a second
// person; documents always use the published version.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { ActingAsSelect, useActingPersona } from "@/components/ActingAs";

type FieldType = "text" | "number" | "money" | "percent" | "date" | "enum";
interface FieldSpec { name: string; label?: string; type: FieldType; required: boolean; pattern?: string; allowed?: string[]; synonyms?: string[]; critical?: boolean }
type Severity = "block" | "warn";
type Rule =
  | { id: string; kind: "date_order"; earlier: string; later: string; severity: Severity }
  | { id: string; kind: "range"; field: string; min?: number; max?: number; severity: Severity }
  | { id: string; kind: "sum_equals"; column: string; total: string; tolerance?: number; severity: Severity }
  | { id: string; kind: "spec_within"; specColumn: string; resultColumn: string; labelColumn?: string; severity: Severity }
  | { id: string; kind: "master_data"; field: string; table: string; column: string; statusColumn?: string; statusValue?: string; severity: Severity };
interface Spec {
  name: string; description: string; classifierHints: string[]; fields: FieldSpec[]; rules: Rule[];
  methods: string[]; capabilities: string[];
  routing: { minConfidence: number; straightThrough: boolean; autoFinalize: boolean; precisionTarget?: number; auditRate?: number }; ragPattern?: string;
}
interface DocType {
  id: string; key: string; tenantId: string; createdBy: string; createdAt: string; updatedAt: string; draft: Spec;
  status: string; submittedBy?: string; submittedAt?: string; decisionNote?: string; deprecated?: boolean;
  published?: { version: number; spec: Spec; submittedBy: string; approvedBy: string; approvedAt: string };
  history: { version: number; approvedBy: string; approvedAt: string }[];
}

const FIELD_TYPES: FieldType[] = ["text", "number", "money", "percent", "date", "enum"];
const RULE_KINDS: { kind: Rule["kind"]; label: string; help: string }[] = [
  { kind: "date_order", label: "Date order", help: "One date field must be before another (e.g. manufacturing before expiry)." },
  { kind: "range", label: "Number range", help: "A numeric field must lie between min and max." },
  { kind: "sum_equals", label: "Line items add up", help: "The numbers in a table column must add up to a total field." },
  { kind: "spec_within", label: "Results within specification", help: "Each table row's result must meet its specification (ranges, NLT / NMT, Complies)." },
  { kind: "master_data", label: "Master-data check", help: "A field's value must exist in a Unity Catalog table (read-only lookup), optionally with a status." },
];
const METHODS = ["claude-haiku", "claude-sonnet", "nova-lite", "nova-pro", "textract-claude-haiku"];
const CAPABILITIES = ["text_extraction", "kv_extraction", "table_extraction", "document_classification", "pii_detection",
  "pii_redaction", "entity_extraction", "document_summarization", "invoice_processing", "contract_analysis", "handwriting_extraction",
  "signature_detection", "barcode_qr", "language_detection", "layout_analysis", "ocr_enhancement"];
const STATUS_STYLE: Record<string, string> = {
  Draft: "bg-slate-100 text-slate-600", "Pending approval": "bg-indigo-50 text-indigo-700",
  Published: "bg-green-50 text-green-700", Rejected: "bg-red-50 text-red-700",
};

function blankSpec(): Spec {
  return {
    name: "", description: "", classifierHints: [], fields: [{ name: "", type: "text", required: true }], rules: [],
    methods: ["claude-sonnet"], capabilities: ["text_extraction", "kv_extraction", "table_extraction", "document_classification"],
    routing: { minConfidence: 0.85, straightThrough: false, autoFinalize: false }, ragPattern: "structured-fields",
  };
}

function newRule(kind: Rule["kind"], i: number): Rule {
  const id = `rule-${i + 1}`;
  switch (kind) {
    case "date_order": return { id, kind, earlier: "", later: "", severity: "block" };
    case "range": return { id, kind, field: "", severity: "block" };
    case "sum_equals": return { id, kind, column: "amount", total: "", tolerance: 0.01, severity: "block" };
    case "spec_within": return { id, kind, specColumn: "spec", resultColumn: "result", labelColumn: "test", severity: "block" };
    case "master_data": return { id, kind, field: "", table: "catalog.schema.table", column: "name", severity: "block" };
  }
}

const csv = (v?: string[]) => (v ?? []).join(", ");
const uncsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export default function DocumentTypesPage() {
  const acting = useActingPersona();
  const personaId = acting.personaId;
  const persona = acting.personas.find((p) => p.id === personaId);
  const tenants = useMemo(() => (persona?.memberships ?? []).map((m) => m.tenantId), [persona]);
  const nameOf = (id?: string) => acting.personas.find((p) => p.id === id)?.name ?? id ?? "";
  const [types, setTypes] = useState<DocType[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTenant, setNewTenant] = useState("");
  const [newKey, setNewKey] = useState("");
  const [spec, setSpec] = useState<Spec>(blankSpec());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const selected = types.find((t) => t.id === selectedId) ?? null;

  async function refresh() {
    if (!personaId) { setTypes([]); return; }
    const r = await getJSON<{ types: DocType[] }>(`/api/docintel?personaId=${encodeURIComponent(personaId)}&types=1`);
    setTypes(r.types);
  }
  useEffect(() => { refresh().catch((e: Error) => setError(e.message)); }, [personaId]);
  useEffect(() => { if (!tenants.includes(newTenant)) setNewTenant(tenants[0] ?? ""); }, [tenants]);
  useEffect(() => {
    if (selected) setSpec(JSON.parse(JSON.stringify(selected.draft)));
  }, [selectedId, selected?.updatedAt]);

  async function act<T>(label: string, fn: () => Promise<T>, ok?: string) {
    setBusy(label); setError(""); setInfo("");
    try {
      const out = await fn();
      await refresh();
      if (ok) setInfo(ok);
      return out;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const post = <T,>(body: Record<string, unknown>) => sendJSON<T>("/api/docintel", "POST", { personaId, ...body });

  const setField = (i: number, f: Partial<FieldSpec>) =>
    setSpec({ ...spec, fields: spec.fields.map((x, k) => (k === i ? { ...x, ...f } : x)) });
  const setRule = (i: number, r: Partial<Rule>) =>
    setSpec({ ...spec, rules: spec.rules.map((x, k) => (k === i ? ({ ...x, ...r } as Rule) : x)) });
  const fieldNames = spec.fields.map((f) => f.name).filter(Boolean);
  const editable = creating || (selected && selected.status !== "Pending approval");
  const isSubmitter = selected?.submittedBy === personaId;

  const fieldSelect = (value: string, onChange: (v: string) => void) => (
    <select className="input !w-44 py-1" value={value} onChange={(e) => onChange(e.target.value)} disabled={!editable}>
      <option value="">field…</option>
      {fieldNames.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );

  return (
    <>
      <PageHeader
        title="Document Types"
        subtitle="Expected fields, validation rules and routing per kind of document. A type owned by a tenant is inherited by everything beneath it; drafts are published by a second person."
        action={<div className="flex gap-2"><Link className="btn-ghost" href="/documents">Documents</Link><Link className="btn-ghost" href="/documents/quality">Quality</Link></div>}
      />
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {info && <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">{info}</div>}
        <section className="card mb-4 flex flex-wrap items-end gap-3 p-5">
          <ActingAsSelect {...acting} hint="Drafting needs analyst+ in the owning tenant; publishing needs approver+ and must not be the submitter." />
          <button className="btn-primary" disabled={!personaId}
            onClick={() => { setCreating(true); setSelectedId(""); setSpec(blankSpec()); setNewKey(""); setInfo(""); setError(""); }}>
            New document type
          </button>
        </section>

        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <aside className="card h-fit p-0">
            <div className="border-b px-4 py-3 text-sm font-medium">Types</div>
            {!personaId && <EmptyState text="Choose who you are acting as." />}
            <ul>
              {types.map((t) => (
                <li key={t.id}>
                  <button className={`w-full border-b px-4 py-2 text-left text-sm hover:bg-slate-50 ${t.id === selectedId ? "bg-slate-50" : ""}`}
                    onClick={() => { setSelectedId(t.id); setCreating(false); setInfo(""); setError(""); }}>
                    <div className="truncate font-medium">{t.draft.name}{t.deprecated ? " (deprecated)" : ""}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                      <span className={`badge ${STATUS_STYLE[t.status] ?? ""}`}>{t.status}</span>
                      {t.published ? `v${t.published.version}` : "unpublished"} · {t.tenantId}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <main className="space-y-4">
            {!creating && !selected && <section className="card p-5"><EmptyState text="Select a document type or create one." /></section>}
            {(creating || selected) && (
              <>
                <section className="card space-y-3 p-5">
                  {creating ? (
                    <div className="grid gap-3 md:grid-cols-3">
                      <Field label="Owning tenant" hint="Inherited by every tenant beneath it">
                        <select className="input" value={newTenant} onChange={(e) => setNewTenant(e.target.value)}>
                          {tenants.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </Field>
                      <Field label="Key" hint="lowercase slug, e.g. deviation-report">
                        <input className="input" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
                      </Field>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h2 className="font-semibold">{selected!.draft.name}</h2>
                        <p className="text-xs text-slate-500">
                          {selected!.key} · owned by {selected!.tenantId} ·{" "}
                          {selected!.published
                            ? `published v${selected!.published.version}, approved by ${nameOf(selected!.published.approvedBy)} ${selected!.published.approvedAt.slice(0, 10)}`
                            : "not yet published"}
                          {selected!.status !== "Published" && selected!.published ? " · the published version stays in use until this draft is approved" : ""}
                        </p>
                        {selected!.decisionNote && <p className="mt-1 text-xs text-slate-600">Last decision note: {selected!.decisionNote}</p>}
                      </div>
                      <span className={`badge ${STATUS_STYLE[selected!.status] ?? ""}`}>{selected!.status}</span>
                    </div>
                  )}
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Name" required>
                      <input className="input" value={spec.name} disabled={!editable} onChange={(e) => setSpec({ ...spec, name: e.target.value })} />
                    </Field>
                    <Field label="Classifier hints" hint="Comma-separated labels that identify this type when it is auto-detected">
                      <input className="input" value={csv(spec.classifierHints)} disabled={!editable}
                        onChange={(e) => setSpec({ ...spec, classifierHints: uncsv(e.target.value) })} />
                    </Field>
                  </div>
                  <Field label="Description">
                    <input className="input" value={spec.description} disabled={!editable} onChange={(e) => setSpec({ ...spec, description: e.target.value })} />
                  </Field>
                </section>

                <section className="card space-y-2 overflow-x-auto p-5">
                  <h3 className="text-sm font-semibold">Fields</h3>
                  <table className="w-full min-w-[56rem] text-xs">
                    <thead className="text-left text-slate-500">
                      <tr><th className="py-1">Name (snake_case)</th><th>Label</th><th>Type</th><th>Required</th><th title="Always reviewed by a person; never auto-accepted">Critical</th><th>Format (regex)</th><th>Synonyms / allowed values</th><th /></tr>
                    </thead>
                    <tbody>
                      {spec.fields.map((f, i) => (
                        <tr key={i} className="border-t">
                          <td className="py-1 pr-1"><input className="input py-1 font-mono" value={f.name} disabled={!editable} onChange={(e) => setField(i, { name: e.target.value })} /></td>
                          <td className="pr-1"><input className="input py-1" value={f.label ?? ""} disabled={!editable} onChange={(e) => setField(i, { label: e.target.value || undefined })} /></td>
                          <td className="pr-1">
                            <select className="input py-1" value={f.type} disabled={!editable} onChange={(e) => setField(i, { type: e.target.value as FieldType })}>
                              {FIELD_TYPES.map((t) => <option key={t}>{t}</option>)}
                            </select>
                          </td>
                          <td className="pr-1 text-center"><input type="checkbox" checked={f.required} disabled={!editable} onChange={(e) => setField(i, { required: e.target.checked })} /></td>
                          <td className="pr-1 text-center"><input type="checkbox" checked={Boolean(f.critical)} disabled={!editable} onChange={(e) => setField(i, { critical: e.target.checked || undefined })} /></td>
                          <td className="pr-1"><input className="input py-1 font-mono" value={f.pattern ?? ""} disabled={!editable} onChange={(e) => setField(i, { pattern: e.target.value || undefined })} /></td>
                          <td className="pr-1">
                            <input className="input py-1" value={f.type === "enum" ? csv(f.allowed) : csv(f.synonyms)} disabled={!editable}
                              placeholder={f.type === "enum" ? "allowed values" : "e.g. lot, lot number"}
                              onChange={(e) => setField(i, f.type === "enum" ? { allowed: uncsv(e.target.value) } : { synonyms: uncsv(e.target.value) })} />
                          </td>
                          <td>{editable && <button className="btn-ghost text-xs" onClick={() => setSpec({ ...spec, fields: spec.fields.filter((_, k) => k !== i) })}>Remove</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {editable && <button className="btn-ghost text-xs" onClick={() => setSpec({ ...spec, fields: [...spec.fields, { name: "", type: "text", required: false }] })}>Add field</button>}
                </section>

                <section className="card space-y-2 p-5">
                  <h3 className="text-sm font-semibold">Validation rules</h3>
                  {!spec.rules.length && <p className="text-xs text-slate-500">No rules: only the field checks (required, type, format, confidence) apply.</p>}
                  {spec.rules.map((r, i) => (
                    <div key={i} className="rounded border p-3 text-xs">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="font-medium">{RULE_KINDS.find((k) => k.kind === r.kind)?.label}</span>
                        <input className="input !w-32 py-1 font-mono" value={r.id} disabled={!editable} onChange={(e) => setRule(i, { id: e.target.value })} />
                        <select className="input !w-28 py-1" value={r.severity} disabled={!editable} onChange={(e) => setRule(i, { severity: e.target.value as Severity })}>
                          <option value="block">blocks</option><option value="warn">warns</option>
                        </select>
                        <span className="text-slate-500">{RULE_KINDS.find((k) => k.kind === r.kind)?.help}</span>
                        {editable && <button className="btn-ghost ml-auto text-xs" onClick={() => setSpec({ ...spec, rules: spec.rules.filter((_, k) => k !== i) })}>Remove</button>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {r.kind === "date_order" && <>{fieldSelect(r.earlier, (v) => setRule(i, { earlier: v }))} must be before {fieldSelect(r.later, (v) => setRule(i, { later: v }))}</>}
                        {r.kind === "range" && <>{fieldSelect(r.field, (v) => setRule(i, { field: v }))} between
                          <input className="input !w-24 py-1" type="number" value={r.min ?? ""} disabled={!editable} onChange={(e) => setRule(i, { min: e.target.value === "" ? undefined : +e.target.value })} /> and
                          <input className="input !w-24 py-1" type="number" value={r.max ?? ""} disabled={!editable} onChange={(e) => setRule(i, { max: e.target.value === "" ? undefined : +e.target.value })} /></>}
                        {r.kind === "sum_equals" && <>table column containing
                          <input className="input !w-28 py-1" value={r.column} disabled={!editable} onChange={(e) => setRule(i, { column: e.target.value })} /> adds up to
                          {fieldSelect(r.total, (v) => setRule(i, { total: v }))} ± <input className="input !w-20 py-1" type="number" step="0.01" value={r.tolerance ?? 0.01} disabled={!editable} onChange={(e) => setRule(i, { tolerance: +e.target.value })} /></>}
                        {r.kind === "spec_within" && <>specification column <input className="input !w-28 py-1" value={r.specColumn} disabled={!editable} onChange={(e) => setRule(i, { specColumn: e.target.value })} />
                          result column <input className="input !w-28 py-1" value={r.resultColumn} disabled={!editable} onChange={(e) => setRule(i, { resultColumn: e.target.value })} />
                          label column <input className="input !w-28 py-1" value={r.labelColumn ?? ""} disabled={!editable} onChange={(e) => setRule(i, { labelColumn: e.target.value || undefined })} /></>}
                        {r.kind === "master_data" && <>{fieldSelect(r.field, (v) => setRule(i, { field: v }))} exists in
                          <input className="input !w-64 py-1 font-mono" value={r.table} disabled={!editable} onChange={(e) => setRule(i, { table: e.target.value })} /> column
                          <input className="input !w-24 py-1 font-mono" value={r.column} disabled={!editable} onChange={(e) => setRule(i, { column: e.target.value })} /> where
                          <input className="input !w-24 py-1 font-mono" value={r.statusColumn ?? ""} placeholder="status col" disabled={!editable} onChange={(e) => setRule(i, { statusColumn: e.target.value || undefined })} /> =
                          <input className="input !w-24 py-1" value={r.statusValue ?? ""} placeholder="value" disabled={!editable} onChange={(e) => setRule(i, { statusValue: e.target.value || undefined })} /></>}
                      </div>
                    </div>
                  ))}
                  {editable && (
                    <div className="flex flex-wrap gap-2">
                      {RULE_KINDS.map((k) => (
                        <button key={k.kind} className="btn-ghost text-xs" onClick={() => setSpec({ ...spec, rules: [...spec.rules, newRule(k.kind, spec.rules.length)] })}>
                          + {k.label}
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <section className="card grid gap-4 p-5 md:grid-cols-2">
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">Extraction</h3>
                    <Field label="Methods">
                      <div className="flex flex-wrap gap-2">
                        {METHODS.map((m) => (
                          <label key={m} className="flex items-center gap-1 text-xs">
                            <input type="checkbox" checked={spec.methods.includes(m)} disabled={!editable}
                              onChange={() => setSpec({ ...spec, methods: spec.methods.includes(m) ? spec.methods.filter((x) => x !== m) : [...spec.methods, m] })} /> {m}
                          </label>
                        ))}
                      </div>
                    </Field>
                    <Field label="Capabilities">
                      <div className="flex flex-wrap gap-2">
                        {CAPABILITIES.map((c) => (
                          <label key={c} className="flex items-center gap-1 text-xs">
                            <input type="checkbox" checked={spec.capabilities.includes(c)} disabled={!editable}
                              onChange={() => setSpec({ ...spec, capabilities: spec.capabilities.includes(c) ? spec.capabilities.filter((x) => x !== c) : [...spec.capabilities, c] })} /> {c}
                          </label>
                        ))}
                      </div>
                    </Field>
                  </div>
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">Routing</h3>
                    <Field label="Minimum field confidence" hint="Unconfirmed values below this need a person">
                      <input className="input w-28" type="number" min={0} max={1} step={0.05} value={spec.routing.minConfidence} disabled={!editable}
                        onChange={(e) => setSpec({ ...spec, routing: { ...spec.routing, minConfidence: +e.target.value } })} />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Precision target" hint="Auto-accept needs this proven with 95% confidence">
                        <input className="input" type="number" min={0.9} max={0.9999} step={0.001} value={spec.routing.precisionTarget ?? 0.995} disabled={!editable}
                          onChange={(e) => setSpec({ ...spec, routing: { ...spec.routing, precisionTarget: +e.target.value } })} />
                      </Field>
                      <Field label="Audit sample rate" hint="Share of would-be straight-through documents a person still reviews">
                        <input className="input" type="number" min={0} max={1} step={0.01} value={spec.routing.auditRate ?? 0.05} disabled={!editable}
                          onChange={(e) => setSpec({ ...spec, routing: { ...spec.routing, auditRate: +e.target.value } })} />
                      </Field>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={spec.routing.straightThrough} disabled={!editable}
                        onChange={(e) => setSpec({ ...spec, routing: { ...spec.routing, straightThrough: e.target.checked } })} />
                      Straight-through: a clean document skips editing and goes to finalization
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={spec.routing.autoFinalize} disabled={!editable}
                        onChange={(e) => setSpec({ ...spec, routing: { ...spec.routing, autoFinalize: e.target.checked } })} />
                      Auto-finalize clean documents (never in GxP-regulated tenants)
                    </label>
                  </div>
                </section>

                <section className="card flex flex-wrap items-end gap-2 p-5">
                  {creating && (
                    <button className="btn-primary" disabled={busy !== ""}
                      onClick={async () => {
                        const r = await act("create", () => post<{ type: DocType }>({ op: "typeCreate", tenantId: newTenant, key: newKey, spec }), "Draft created.");
                        if (r) { setCreating(false); setSelectedId(r.type.id); }
                      }}>Create draft</button>
                  )}
                  {selected && editable && (
                    <button className="btn-ghost" disabled={busy !== ""}
                      onClick={() => act("save", () => post({ op: "typeUpdate", typeId: selected.id, spec }), "Draft saved. The published version stays in use until this draft is approved.")}>
                      Save draft
                    </button>
                  )}
                  {selected && ["Draft", "Rejected"].includes(selected.status) && (
                    <button className="btn-primary" disabled={busy !== ""}
                      onClick={() => act("submit", () => post({ op: "typeSubmit", typeId: selected.id }), "Submitted for approval.")}>
                      Submit for approval
                    </button>
                  )}
                  {selected?.status === "Pending approval" && (
                    <>
                      <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                      <button className="btn-primary" disabled={busy !== "" || isSubmitter}
                        onClick={() => act("approve", () => post({ op: "typeApprove", typeId: selected.id, note }), "Published.")}>
                        Approve and publish
                      </button>
                      <button className="btn-ghost" disabled={busy !== "" || isSubmitter}
                        onClick={() => act("reject", () => post({ op: "typeReject", typeId: selected.id, note }), "Draft rejected.")}>
                        Reject
                      </button>
                      {isSubmitter && <span className="text-xs text-slate-500">You submitted this draft; a different approver must decide.</span>}
                    </>
                  )}
                  {selected?.published && (
                    <button className="btn-ghost ml-auto" disabled={busy !== ""}
                      onClick={() => act("deprecate", () => post({ op: "typeDeprecate", typeId: selected.id, deprecated: !selected.deprecated }))}>
                      {selected.deprecated ? "Restore" : "Deprecate"}
                    </button>
                  )}
                </section>
                {selected && selected.history.length > 0 && (
                  <p className="text-xs text-slate-500">
                    Versions: {selected.history.map((h) => `v${h.version} by ${nameOf(h.approvedBy)} (${h.approvedAt.slice(0, 10)})`).join(" · ")}
                  </p>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </>
  );
}
