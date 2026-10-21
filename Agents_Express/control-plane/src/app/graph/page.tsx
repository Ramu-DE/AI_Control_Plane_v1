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
    universalJoinKey: "",
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

        {selected && <MappingPanel graphSourceId={selected.graphSourceId} />}
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
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (values: Partial<GraphSourceConfig>) => setSource((current) => ({ ...current, ...values }));
  const ontology = (values: Partial<GraphSourceConfig["ontology"]>) => patch({ ontology: { ...source.ontology, ...values } });
  const backend = (values: Partial<GraphSourceConfig["backend"]>) => patch({ backend: { ...source.backend, ...values } });

  async function register() {
    setBusy(true); setError("");
    try {
      // Split the comma/space/newline-separated allowed-host list into an
      // allowlist. A configured (non-placeholder) queryEngineUrl requires a
      // non-empty allowlist that matches its hostname (enforced server-side).
      const allowedHosts = allowedHostsText
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean);
      await sendJSON("/api/graph", "POST", { op: "register", source: { ...source, allowedHosts } });
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
        <Field label="Allowed serving hosts" hint="Required when a live (non-placeholder) query engine URL is set. Comma- or space-separated hostnames, e.g. ws.databricks.com"><input className="input" value={allowedHostsText} onChange={(e) => setAllowedHostsText(e.target.value)} placeholder="ws.databricks.com" /></Field>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------- //
// Mapping / build governance panel
// --------------------------------------------------------------------------- //

interface BuildRunView {
  buildRunId: string;
  status: string;
  trigger: string;
  startedAt: string;
  message?: string;
  stats?: Record<string, number>;
}
interface ProposalView {
  proposalId: string;
  buildRunId: string;
  status: string;
  ontologyLabel: string;
  ontologyUri: string;
  entityType: string;
  ucTable?: string;
  ucColumn?: string | null;
  confidence: number;
  evidence: { kind: string; detail: string }[];
  issues: { severity: string; code: string; message: string }[];
  decision?: { reviewer: string; note: string; decidedAt: string };
}
interface VersionView {
  mappingVersionId: string;
  version: number;
  status: string;
  proposalIds: string[];
  publishedBy: string;
  publishedAt: string;
}
interface MappingData {
  graphSourceId: string;
  buildRuns: BuildRunView[];
  proposals: ProposalView[];
  versions: VersionView[];
}

function MappingPanel({ graphSourceId }: { graphSourceId: string }) {
  const [data, setData] = useState<MappingData | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [reviewer, setReviewer] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeBuild, setActiveBuild] = useState<string>("");

  async function load() {
    try {
      const next = await getJSON<MappingData>(
        `/api/graph/mappings?graphSourceId=${encodeURIComponent(graphSourceId)}`
      );
      setData(next);
      setActiveBuild((cur) => cur || next.buildRuns[0]?.buildRunId || "");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    setSelected({});
    setActiveBuild("");
    load().catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSourceId]);

  const proposals = useMemo(
    () => (data?.proposals ?? []).filter((p) => !activeBuild || p.buildRunId === activeBuild),
    [data, activeBuild]
  );
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  async function decide(decision: "approved" | "rejected") {
    setError("");
    if (!reviewer.trim() || !note.trim()) {
      setError("Reviewer and note are required to approve or reject.");
      return;
    }
    if (selectedIds.length === 0) {
      setError("Select at least one proposal.");
      return;
    }
    setBusy(true);
    try {
      await sendJSON("/api/graph/mappings", "POST", {
        op: "decide",
        proposalIds: selectedIds,
        decision,
        reviewer,
        note,
      });
      setSelected({});
      setNote("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setError("");
    if (!activeBuild) {
      setError("No build run selected to publish.");
      return;
    }
    setBusy(true);
    try {
      await sendJSON("/api/graph/mappings", "POST", {
        op: "publish",
        graphSourceId,
        buildRunId: activeBuild,
        publishedBy: reviewer || "console-user",
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hasBuilds = (data?.buildRuns.length ?? 0) > 0;
  // Mirror evaluatePublishGate: every proposal must be DECIDED (no 'proposed'),
  // no approved proposal may carry a blocking/error issue, and at least one
  // approved+valid proposal must exist. Rejected proposals are a completed
  // decision that is excluded from the published output (they do not block).
  const isBlocking = (sev: string) => sev === "blocking" || sev === "error";
  const undecidedCount = proposals.filter((p) => p.status === "proposed").length;
  const approvedValid = proposals.filter(
    (p) => p.status === "approved" && !p.issues.some((i) => isBlocking(i.severity))
  );
  const approvedInvalidCount = proposals.filter(
    (p) => p.status === "approved" && p.issues.some((i) => isBlocking(i.severity))
  ).length;
  const canPublish =
    proposals.length > 0 &&
    undecidedCount === 0 &&
    approvedInvalidCount === 0 &&
    approvedValid.length > 0;
  const publishHint = canPublish
    ? `Publish ${approvedValid.length} approved mapping(s); rejected proposals are excluded.`
    : undecidedCount > 0
      ? `${undecidedCount} proposal(s) still undecided — approve or reject every proposal first.`
      : approvedInvalidCount > 0
        ? `${approvedInvalidCount} approved proposal(s) have blocking issues.`
        : "At least one approved, valid proposal is required to publish.";

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Mapping build &amp; approval</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Review ontology→backend mappings derived by the build plane. Approve or reject with a
            mandatory note, then publish an immutable mapping version once all are approved.
          </p>
        </div>
      </div>

      {error && <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {!hasBuilds ? (
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
          No build runs recorded for this source yet. Live discovery is not performed here — a
          build run is created by the build plane (graph-utility) and its proposals appear here for
          governance.
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap gap-2">
            {data!.buildRuns.map((run) => (
              <button
                key={run.buildRunId}
                type="button"
                onClick={() => { setActiveBuild(run.buildRunId); setSelected({}); }}
                className={`rounded-lg border px-3 py-2 text-left text-xs ${activeBuild === run.buildRunId ? "border-brand-500 ring-1 ring-brand-500" : "border-slate-200 hover:border-slate-300"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="mono">{run.buildRunId}</span>
                  <Pill status={run.status} />
                </div>
                <div className="mt-1 text-slate-400">{run.trigger} · {new Date(run.startedAt).toLocaleString()}</div>
              </button>
            ))}
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <tr>
                  <th className="py-2 pr-2"></th>
                  <th className="py-2 pr-3">Mapping</th>
                  <th className="py-2 pr-3">Target</th>
                  <th className="py-2 pr-3">Confidence</th>
                  <th className="py-2 pr-3">Issues</th>
                  <th className="py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => {
                  const blocking = p.issues.some((i) => i.severity === "blocking" || i.severity === "error");
                  return (
                    <tr key={p.proposalId} className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={!!selected[p.proposalId]}
                          disabled={p.status !== "proposed"}
                          onChange={(e) => setSelected((cur) => ({ ...cur, [p.proposalId]: e.target.checked }))}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="font-medium text-slate-800">{p.ontologyLabel}</div>
                        <div className="mono text-xs text-slate-400">{p.ontologyUri}</div>
                        {p.evidence.length > 0 && (
                          <ul className="mt-1 list-disc pl-4 text-xs text-slate-500">
                            {p.evidence.slice(0, 3).map((ev, i) => (
                              <li key={i}><span className="font-medium">{ev.kind}:</span> {ev.detail}</li>
                            ))}
                          </ul>
                        )}
                        {p.decision && (
                          <div className="mt-1 text-xs text-slate-500">
                            Reviewed by {p.decision.reviewer}: “{p.decision.note}”
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-600">
                        <div className="mono">{p.ucTable ?? "—"}</div>
                        <div className="mono text-slate-400">{p.ucColumn ?? (p.entityType === "class" ? "(class)" : "—")}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`font-medium ${p.confidence >= 0.8 ? "text-green-700" : p.confidence >= 0.5 ? "text-amber-700" : "text-red-700"}`}>
                          {(p.confidence * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {p.issues.length === 0 ? (
                          <span className="text-slate-400">none</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {p.issues.map((iss, i) => (
                              <li key={i} className={iss.severity === "blocking" || iss.severity === "error" ? "text-red-700" : iss.severity === "warning" ? "text-amber-700" : "text-slate-500"}>
                                {iss.severity}: {iss.message}
                              </li>
                            ))}
                          </ul>
                        )}
                        {blocking && <div className="mt-0.5 text-[11px] font-medium text-red-700">blocks publish</div>}
                      </td>
                      <td className="py-2 pr-3"><Pill status={p.status} /></td>
                    </tr>
                  );
                })}
                {proposals.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-sm text-slate-400">No proposals in this build run.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
            <Field label="Reviewer" required>
              <input className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="jane.doe@corp" />
            </Field>
            <Field label="Decision note" required>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Rationale (mandatory)" />
            </Field>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              <button className="btn-primary" disabled={busy || selectedIds.length === 0} onClick={() => decide("approved")}>
                Approve selected ({selectedIds.length})
              </button>
              <button className="btn-ghost" disabled={busy || selectedIds.length === 0} onClick={() => decide("rejected")}>
                Reject selected
              </button>
              <div className="flex-1" />
              <button className="btn-primary" disabled={busy || !canPublish} onClick={publish} title={publishHint}>
                Publish mapping version
              </button>
            </div>
          </div>

          {(data!.versions.length > 0) && (
            <div className="mt-5">
              <h3 className="text-sm font-semibold">Published mapping versions</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {data!.versions.map((v) => (
                  <li key={v.mappingVersionId} className="flex items-center gap-3">
                    <span className="badge bg-green-50 text-green-700">v{v.version}</span>
                    <span className="text-slate-500">{v.proposalIds.length} mappings · by {v.publishedBy} · {new Date(v.publishedAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
