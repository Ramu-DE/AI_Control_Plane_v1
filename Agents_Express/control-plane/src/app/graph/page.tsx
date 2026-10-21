"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Field, Modal, PageHeader, Pill } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { GraphSourceConfig, GraphSourceRecord, RecordStatus } from "@/lib/types";

interface PersonaSummary {
  id: string;
  name: string;
  email: string;
  groups: string[];
}
interface GraphData {
  sources: GraphSourceRecord[];
  personas: PersonaSummary[];
}

const EMPTY_SOURCE: GraphSourceConfig = {
  graphSourceId: "",
  bu: "",
  displayName: "",
  description: "",
  ontology: {
    type: "neptune",
    sparqlUrl: "",
    graphUri: "",
    namespace: "",
    auth: "sigv4-assume-role",
  },
  backend: {
    type: "databricks-uc",
    catalog: "",
    schema: "",
    registryTable: "",
    universalJoinKey: "contract_key",
  },
  llmEndpoint: "",
  queryEngineUrl: "",
  tags: {},
  version: "1.0.0",
};

function endpointConfigured(url: string): boolean {
  return /^https:\/\//i.test(url) && !url.toUpperCase().includes("REPLACE-ME");
}

export default function GraphSourcesPage() {
  const [data, setData] = useState<GraphData>({ sources: [], personas: [] });
  const [selectedId, setSelectedId] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [question, setQuestion] = useState(
    "What is the total fees amount by supplier name?"
  );
  const [preview, setPreview] = useState(true);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showRegister, setShowRegister] = useState(false);

  async function load() {
    const next = await getJSON<GraphData>("/api/graph");
    setData(next);
    setSelectedId((current) => current || next.sources.find((s) => s.status === "Approved")?.graphSourceId || "");
    setPersonaId((current) => current || next.personas[0]?.id || "");
  }

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, []);

  const selected = useMemo(
    () => data.sources.find((source) => source.graphSourceId === selectedId),
    [data.sources, selectedId]
  );

  useEffect(() => {
    if (selected && !endpointConfigured(selected.queryEngineUrl)) setPreview(true);
  }, [selected]);

  async function query(event: FormEvent) {
    event.preventDefault();
    setError("");
    setResult(null);
    setBusy(true);
    try {
      const response = await sendJSON<unknown>("/api/graph", "POST", {
        op: "query",
        graphSourceId: selectedId,
        personaId,
        question,
        limit: 50,
        preview,
      });
      setResult(response);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(source: GraphSourceRecord, status: RecordStatus) {
    setError("");
    try {
      await sendJSON("/api/graph", "PATCH", {
        graphSourceId: source.graphSourceId,
        status,
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Graph Sources"
        subtitle="Register, govern, and route ontology-mediated data access by business unit."
        action={
          <button className="btn-primary" onClick={() => setShowRegister(true)}>
            + Register Graph Source
          </button>
        }
      />
      <div className="space-y-6 px-4 pb-10 sm:px-6 lg:px-8">
        {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.sources.map((source) => (
            <button
              type="button"
              key={source.graphSourceId}
              onClick={() => setSelectedId(source.graphSourceId)}
              className={`card p-5 text-left transition ${selectedId === source.graphSourceId ? "border-brand-500 ring-1 ring-brand-500" : "hover:border-slate-300"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">{source.displayName}</div>
                  <div className="mono mt-1 text-xs text-slate-400">{source.graphSourceId}</div>
                </div>
                <Pill status={source.status} />
              </div>
              <p className="mt-3 text-sm text-slate-500">{source.description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="badge bg-indigo-50 text-indigo-700">{source.bu}</span>
                <span className="badge bg-slate-100 text-slate-600">Neptune</span>
                <span className="badge bg-slate-100 text-slate-600">Unity Catalog</span>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
                <span className={endpointConfigured(source.queryEngineUrl) ? "text-green-700" : "text-amber-700"}>
                  {endpointConfigured(source.queryEngineUrl) ? "● Serving configured" : "○ Preview only"}
                </span>
                {source.status === "Draft" && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="font-medium text-brand-700"
                    onClick={(event) => { event.stopPropagation(); changeStatus(source, "Pending approval"); }}
                  >
                    Submit for approval
                  </span>
                )}
                {source.status === "Pending approval" && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="font-medium text-green-700"
                    onClick={(event) => { event.stopPropagation(); changeStatus(source, "Approved"); }}
                  >
                    Approve
                  </span>
                )}
              </div>
            </button>
          ))}
        </section>

        {selected && (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,.75fr)]">
            <section className="card p-6">
              <h2 className="text-base font-semibold">Ask this graph</h2>
              <p className="mt-1 text-sm text-slate-500">
                Policy is evaluated before the request is routed to the source&apos;s OMDA serving endpoint.
              </p>
              <form className="mt-5 space-y-4" onSubmit={query}>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Graph Source">
                    <select className="input" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                      {data.sources.filter((s) => s.status === "Approved").map((source) => (
                        <option key={source.graphSourceId} value={source.graphSourceId}>{source.displayName}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Caller persona">
                    <select className="input" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
                      {data.personas.map((persona) => (
                        <option key={persona.id} value={persona.id}>{persona.name} · {persona.groups.join(", ")}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Natural-language question">
                  <textarea className="input min-h-28" value={question} onChange={(e) => setQuestion(e.target.value)} />
                </Field>
                <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                  <input type="checkbox" className="mt-1" checked={preview} onChange={(e) => setPreview(e.target.checked)} disabled={!endpointConfigured(selected.queryEngineUrl)} />
                  <span>
                    <span className="font-medium">Routing preview</span>
                    <span className="block text-xs text-slate-500">Run Cedar policy and show the exact serving request without making an external call.</span>
                  </span>
                </label>
                <button className="btn-primary" disabled={busy || !question.trim() || !personaId || selected.status !== "Approved"}>
                  {busy ? "Evaluating…" : preview ? "Preview governed route" : "Query Graph Source"}
                </button>
              </form>
            </section>

            <section className="card overflow-hidden">
              <div className="border-b border-slate-100 px-5 py-4">
                <h2 className="font-semibold">Result</h2>
                <p className="text-xs text-slate-500">Decision, generated SQL/rows, or routing preview.</p>
              </div>
              <div className="max-h-[34rem] overflow-auto p-5">
                {result ? (
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100">{JSON.stringify(result, null, 2)}</pre>
                ) : (
                  <div className="py-12 text-center text-sm text-slate-400">Run a query to see the governed route.</div>
                )}
              </div>
            </section>
          </div>
        )}

        {selected && (
          <section className="card p-6">
            <h2 className="mb-4 text-base font-semibold">Selected source configuration</h2>
            <div className="grid gap-5 text-sm md:grid-cols-2 xl:grid-cols-4">
              <Detail label="Ontology" value={selected.ontology.graphUri} />
              <Detail label="UC schema" value={`${selected.backend.catalog}.${selected.backend.schema}`} />
              <Detail label="Registry table" value={selected.backend.registryTable} />
              <Detail label="Universal join key" value={selected.backend.universalJoinKey} />
            </div>
          </section>
        )}
      </div>

      {showRegister && (
        <RegisterModal
          onClose={() => setShowRegister(false)}
          onCreated={async () => { setShowRegister(false); await load(); }}
        />
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs font-medium text-slate-400">{label}</div><div className="mono mt-1 break-all text-slate-700">{value}</div></div>;
}

function RegisterModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [source, setSource] = useState(EMPTY_SOURCE);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (values: Partial<GraphSourceConfig>) => setSource((current) => ({ ...current, ...values }));
  const ontology = (values: Partial<GraphSourceConfig["ontology"]>) => patch({ ontology: { ...source.ontology, ...values } });
  const backend = (values: Partial<GraphSourceConfig["backend"]>) => patch({ backend: { ...source.backend, ...values } });

  async function register() {
    setBusy(true); setError("");
    try {
      await sendJSON("/api/graph", "POST", { op: "register", source });
      await onCreated();
    } catch (e) {
      setError((e as Error).message); setBusy(false);
    }
  }

  return (
    <Modal title="Register Graph Source" subtitle="The source starts as Draft and must pass approval before queries can route." onClose={onClose}
      footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={register}>{busy ? "Registering…" : "Create draft"}</button></>}>
      <div className="space-y-4">
        {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source ID" required><input className="input" value={source.graphSourceId} onChange={(e) => patch({ graphSourceId: e.target.value })} placeholder="contract-iq" /></Field>
          <Field label="Business unit" required><input className="input" value={source.bu} onChange={(e) => patch({ bu: e.target.value })} placeholder="market-access" /></Field>
        </div>
        <Field label="Display name" required><input className="input" value={source.displayName} onChange={(e) => patch({ displayName: e.target.value })} /></Field>
        <Field label="Description"><input className="input" value={source.description} onChange={(e) => patch({ description: e.target.value })} /></Field>
        <div className="border-t border-slate-100 pt-4 text-sm font-semibold">Neptune ontology</div>
        <Field label="SPARQL URL" required><input className="input" value={source.ontology.sparqlUrl} onChange={(e) => ontology({ sparqlUrl: e.target.value })} placeholder="https://…:8182/sparql" /></Field>
        <Field label="Graph URI" required><input className="input" value={source.ontology.graphUri} onChange={(e) => ontology({ graphUri: e.target.value })} /></Field>
        <Field label="Namespace" required><input className="input" value={source.ontology.namespace} onChange={(e) => ontology({ namespace: e.target.value })} /></Field>
        <div className="border-t border-slate-100 pt-4 text-sm font-semibold">Unity Catalog backend</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Catalog" required><input className="input" value={source.backend.catalog} onChange={(e) => backend({ catalog: e.target.value })} /></Field>
          <Field label="Schema" required><input className="input" value={source.backend.schema} onChange={(e) => backend({ schema: e.target.value })} /></Field>
        </div>
        <Field label="Registry table" required><input className="input" value={source.backend.registryTable} onChange={(e) => backend({ registryTable: e.target.value })} placeholder="catalog.schema.omda_ontology_mapping" /></Field>
        <Field label="Universal join key" required><input className="input" value={source.backend.universalJoinKey} onChange={(e) => backend({ universalJoinKey: e.target.value })} /></Field>
        <Field label="LLM endpoint" required><input className="input" value={source.llmEndpoint} onChange={(e) => patch({ llmEndpoint: e.target.value })} /></Field>
        <Field label="Query engine URL" hint="May be left empty for preview-only setup."><input className="input" value={source.queryEngineUrl} onChange={(e) => patch({ queryEngineUrl: e.target.value })} placeholder="https://…/serving-endpoints/…/invocations" /></Field>
      </div>
    </Modal>
  );
}
