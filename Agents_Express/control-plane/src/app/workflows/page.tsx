"use client";

import { useEffect, useState } from "react";
import { PageHeader, Pill, EmptyState, Field, Modal } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import {
  agentEligibleForWorkflow,
  explainNoEligibleAgents,
} from "@/lib/workflow/eligibility";
import type { Workflow, WorkflowRun, StepRun, WorkflowStep } from "@/lib/types";

// Shapes the API now returns alongside workflows/runs so this page can BUILD one.
interface AgentOption {
  id: string;
  name: string;
  tenantId: string;
  modelId: string;
  agentRuntimeId: string;
  modelRuntimeId: string;
  toolCount: number;
  knowledgeCount: number;
}
interface ModelOption { id: string; name: string; inferenceProvider: string }
interface TenantOption { id: string; tenantName: string; parentId?: string | null }
interface PersonaOption { id: string; name: string; groups: string[] }
interface WorkflowsData {
  workflows: Workflow[];
  runs: WorkflowRun[];
  agents: AgentOption[];
  models: ModelOption[];
  tenants: TenantOption[];
  personas: PersonaOption[];
}

const STEP_STATUS_COLOR: Record<string, string> = {
  pending: "bg-slate-100 text-slate-500",
  running: "bg-blue-50 text-blue-700",
  "awaiting-review": "bg-amber-100 text-amber-800",
  approved: "bg-green-50 text-green-700",
  revised: "bg-teal-50 text-teal-700",
  denied: "bg-red-50 text-red-700",
  done: "bg-green-50 text-green-700",
  error: "bg-red-50 text-red-700",
};

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedWf, setSelectedWf] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<WorkflowRun | null>(null);
  // Left empty on purpose. A prefilled example from an unrelated demo gets
  // submitted by accident and then the run's answer makes no sense.
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviseText, setReviseText] = useState("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [personaId, setPersonaId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const d = await getJSON<WorkflowsData>("/api/workflows");
    setWorkflows(d.workflows);
    setRuns(d.runs);
    setAgents(d.agents ?? []);
    setModels(d.models ?? []);
    setTenants(d.tenants ?? []);
    setPersonas(d.personas ?? []);
    setPersonaId((cur) => cur || d.personas?.[0]?.id || "");
    if (!selectedWf && d.workflows[0]) setSelectedWf(d.workflows[0].id);
    if (activeRun) {
      const fresh = d.runs.find((r) => r.id === activeRun.id);
      if (fresh) setActiveRun(fresh);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wf = workflows.find((w) => w.id === selectedWf);

  async function startRun() {
    if (!wf) return;
    setBusy(true);
    setError("");
    try {
      const run = await sendJSON<WorkflowRun>("/api/workflows", "POST", {
        op: "start",
        workflowId: wf.id,
        input,
        personaId: personaId || undefined,
      });
      // The server returns 202 with the run still "running": a multi-step
      // agentic workflow takes far longer than an HTTP request should be held
      // open for. Show it immediately, then poll until it settles.
      setActiveRun(run);
      await load();
      void pollRun(run.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Poll one run until it reaches a terminal state, or we give up waiting. */
  async function pollRun(runId: string) {
    const TERMINAL = ["completed", "error", "paused", "denied"];
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const data = await getJSON<WorkflowsData>("/api/workflows");
        setWorkflows(data.workflows);
        setRuns(data.runs);
        const fresh = data.runs.find((r) => r.id === runId);
        if (fresh) {
          setActiveRun(fresh);
          if (TERMINAL.includes(fresh.status)) return;
        }
      } catch {
        // A transient poll failure is not a run failure — keep waiting. The
        // run's own status is the authority, and it lives on the server.
      }
    }
    setError(
      "Stopped polling after 5 minutes. The run may still be progressing — " +
        "reopen it from the run list to see where it got to."
    );
  }

  async function decide(decision: "approve" | "revise" | "deny") {
    if (!activeRun) return;
    setBusy(true);
    try {
      const run = await sendJSON<WorkflowRun>("/api/workflows", "POST", {
        op: "decision",
        runId: activeRun.id,
        decision,
        revisedOutput: decision === "revise" ? reviseText : undefined,
      });
      setActiveRun(run);
      setReviseText("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function rerun(stepIndex: number) {
    if (!activeRun) return;
    setBusy(true);
    try {
      const run = await sendJSON<WorkflowRun>("/api/workflows", "POST", {
        op: "rerun",
        runId: activeRun.id,
        stepIndex,
      });
      setActiveRun(run);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const gateStep =
    activeRun && activeRun.status === "paused"
      ? activeRun.steps[activeRun.currentStep]
      : null;

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="Multi-agent workflows executed for real on Bedrock or Databricks. A step can run AS a registered agent — inheriting its model, system prompt and knowledge bases, and governed by Cedar as that agent. Approved tools the platform implements are really invoked (Databricks plane)."
        action={
          <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
            New workflow
          </button>
        }
      />
      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 sm:mx-6 lg:mx-8">
          {error}
        </div>
      )}
      <div className="grid gap-6 px-8 pb-10 lg:grid-cols-[320px_1fr]">
        {/* LEFT: workflow list + designer */}
        <div className="space-y-4">
          <div className="card p-3">
            <div className="mb-1 px-1 text-xs font-semibold uppercase text-slate-400">
              Workflows
            </div>
            {workflows.map((w) => (
              <button
                key={w.id}
                onClick={() => setSelectedWf(w.id)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                  w.id === selectedWf
                    ? "bg-slate-100 font-medium"
                    : "hover:bg-slate-50"
                }`}
              >
                {w.name}
                <div className="text-xs text-slate-400">
                  {w.steps.length} steps
                </div>
              </button>
            ))}
          </div>

          {wf && (
            <div className="card p-4">
              <div className="text-xs font-semibold uppercase text-slate-400">
                Designer
              </div>
              <h3 className="mt-1 font-semibold">{wf.name}</h3>
              <p className="text-xs text-slate-500">{wf.description}</p>
              <div className="mt-3 space-y-2">
                {wf.steps.map((s, i) => (
                  <div
                    key={s.id}
                    className="rounded-lg border border-slate-200 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        {i + 1}. {s.name}
                      </span>
                      {s.reviewGate && (
                        <span className="badge bg-amber-100 text-amber-800">
                          ⛉ gate
                        </span>
                      )}
                    </div>
                    {s.agentId && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <span className="badge bg-brand-50 text-brand-700">
                          agent: {agents.find((a) => a.id === s.agentId)?.name ?? s.agentId}
                        </span>
                        <span className="badge bg-slate-100 text-slate-600">
                          {agents.find((a) => a.id === s.agentId)?.modelRuntimeId ?? "?"}
                        </span>
                      </div>
                    )}
                    <p className="mt-1 text-xs text-slate-500">{s.prompt}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: execution */}
        <div className="space-y-4">
          <div className="card p-5">
            <h3 className="text-sm font-semibold">Run (Execution Plane)</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Each step is a real model call on the plane its agent declares —
              Bedrock or Databricks. Gated steps pause for
              your approval.
            </p>
            <div className="mt-3">
              <Field
                label="Run as persona"
                hint="Required when any step is bound to an agent — the Cedar runAgent check needs a principal."
              >
                <select
                  className="input"
                  value={personaId}
                  onChange={(e) => setPersonaId(e.target.value)}
                >
                  <option value="">(none — model-only steps)</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.groups.join(", ")})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <textarea
              className="input mt-3 h-20"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe the task / trigger input…"
            />
            <button
              className="btn-primary mt-3"
              onClick={startRun}
              disabled={busy || !wf}
            >
              {busy ? "Starting…" : "▶ Start run"}
            </button>
          </div>

          {activeRun && (
            <div className="card p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  Run {activeRun.id.slice(-6)}
                </h3>
                <div className="flex items-center gap-2">
                  <RunStatus status={activeRun.status} />
                  <span className="badge bg-slate-100 text-slate-600">
                    {activeRun.totalTokens} tok
                  </span>
                  <span className="badge bg-slate-100 text-slate-600">
                    ${activeRun.totalCostUsd.toFixed(4)}
                  </span>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {activeRun.steps.map((sr, i) => (
                  <StepCard
                    key={sr.stepId}
                    sr={sr}
                    index={i}
                    onRerun={() => rerun(i)}
                    busy={busy}
                  />
                ))}
              </div>

              {gateStep && (
                <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
                  <div className="text-sm font-semibold text-amber-900">
                    ⛉ Human review required — {gateStep.name}
                  </div>
                  <p className="mt-1 text-xs text-amber-800">
                    Approve to continue, revise the output, or deny to stop the
                    run.
                  </p>
                  <textarea
                    className="input mt-3 h-24"
                    placeholder="(optional) revised output — used if you click Revise"
                    value={reviseText}
                    onChange={(e) => setReviseText(e.target.value)}
                  />
                  <div className="mt-3 flex gap-2">
                    <button
                      className="btn-primary"
                      disabled={busy}
                      onClick={() => decide("approve")}
                    >
                      Approve
                    </button>
                    <button
                      className="btn-ghost"
                      disabled={busy || !reviseText}
                      onClick={() => decide("revise")}
                    >
                      Revise &amp; continue
                    </button>
                    <button
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() => decide("deny")}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* recent runs */}
          {runs.length > 0 && (
            <div className="card p-5">
              <h3 className="text-sm font-semibold">Recent runs</h3>
              <div className="mt-3 space-y-2">
                {runs.slice(0, 6).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setActiveRun(r)}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span>{r.workflowName}</span>
                    <span className="flex items-center gap-2">
                      <RunStatus status={r.status} />
                      <span className="text-xs text-slate-400">
                        ${r.totalCostUsd.toFixed(4)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateWorkflowModal
          agents={agents}
          models={models}
          tenants={tenants}
          onClose={() => setShowCreate(false)}
          onCreated={async (id) => {
            setShowCreate(false);
            await load();
            setSelectedWf(id);
          }}
        />
      )}
    </>
  );
}

function RunStatus({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: "bg-blue-50 text-blue-700",
    paused: "bg-amber-100 text-amber-800",
    completed: "bg-green-50 text-green-700",
    denied: "bg-red-50 text-red-700",
    error: "bg-red-50 text-red-700",
  };
  return <span className={`badge ${map[status] ?? "bg-slate-100"}`}>{status}</span>;
}

function StepCard({
  sr,
  index,
  onRerun,
  busy,
}: {
  sr: StepRun;
  index: number;
  onRerun: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {index + 1}. {sr.name}
          {sr.reviewGate && <span className="ml-2 text-amber-600">⛉</span>}
        </span>
        <div className="flex items-center gap-2">
          <span className={`badge ${STEP_STATUS_COLOR[sr.status]}`}>
            {sr.status}
          </span>
          {sr.usage && (
            <span className="text-xs text-slate-400">
              {sr.usage.totalTokens} tok · {sr.latencyMs}ms · $
              {sr.costUsd?.toFixed(4)}
            </span>
          )}
          {(sr.status === "done" ||
            sr.status === "approved" ||
            sr.status === "revised" ||
            sr.status === "error") && (
            <button
              className="text-xs text-slate-500 hover:text-slate-900"
              onClick={onRerun}
              disabled={busy}
            >
              ↻ re-run
            </button>
          )}
        </div>
      </div>
      {sr.modelId && (
        <div className="mono mt-1 text-[11px] text-slate-400">{sr.modelId}</div>
      )}
      {sr.provenance && (
        <div className="mt-1 flex flex-wrap gap-1">
          <span
            className={`badge ${
              sr.provenance.executor === "databricks"
                ? "bg-orange-50 text-orange-700"
                : "bg-sky-50 text-sky-700"
            }`}
          >
            ran on: {sr.provenance.executor}
          </span>
          {sr.provenance.agentName && (
            <span className="badge bg-brand-50 text-brand-700">
              as agent: {sr.provenance.agentName}
            </span>
          )}
          {sr.provenance.modelRuntimeId && (
            <span className="badge bg-slate-100 text-slate-600">
              {sr.provenance.modelRuntimeId}
            </span>
          )}
        </div>
      )}
      {sr.grounding && (
        <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          <div className="font-medium">
            Grounded on {sr.grounding.recordName} ({sr.grounding.provider}) —{" "}
            {sr.grounding.passageCount} passage(s)
          </div>
          <ul className="mt-1 space-y-0.5">
            {sr.grounding.citations.map((c, i) => (
              <li key={c.id + i} className="mono">
                [{i + 1}] {c.id} · score {c.score.toFixed(4)} · {c.source}
              </li>
            ))}
          </ul>
        </div>
      )}
      {sr.toolCalls && sr.toolCalls.length > 0 && (
        // Collapsed by default. Expanded, every call printed its full
        // arguments and a result blob, so a step with six calls buried its own
        // answer under a wall of JSON. The summary line carries what you scan
        // for — how many ran and how many failed — and the detail is one click
        // away for when you need it.
        <details className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50 text-xs text-indigo-900">
          <summary className="cursor-pointer select-none px-2 py-1.5 font-medium">
            {sr.toolCalls.length} tool call{sr.toolCalls.length === 1 ? "" : "s"}
            {(() => {
              const failed = sr.toolCalls!.filter((c) => !c.ok).length;
              return failed > 0 ? (
                <span className="ml-1 font-normal text-red-700">
                  · {failed} failed
                </span>
              ) : (
                <span className="ml-1 font-normal text-green-700">· all ok</span>
              );
            })()}
            <span className="ml-1 font-normal text-indigo-600">
              · {sr.toolCalls.map((c) => c.name).filter((n, i, a) => a.indexOf(n) === i).join(", ")}
            </span>
          </summary>
          <ul className="space-y-1.5 border-t border-indigo-200 px-2 py-2">
            {sr.toolCalls.map((c, i) => (
              <li key={i}>
                <span className="mono font-medium">{c.name}</span>
                <span className={c.ok ? "ml-1 text-green-700" : "ml-1 text-red-700"}>
                  {c.ok ? "ok" : "failed"}
                </span>
                <span className="ml-1 text-indigo-700">· {c.latencyMs}ms</span>
                <div className="mono mt-0.5 line-clamp-2 break-all text-[11px] text-indigo-800">
                  args {JSON.stringify(c.arguments)}
                </div>
                <div className="mono line-clamp-2 break-all text-[11px] text-indigo-600">
                  {c.resultPreview.slice(0, 180)}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {sr.notes && sr.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-700">
          {sr.notes.map((n, i) => (
            <li key={i}>· {n}</li>
          ))}
        </ul>
      )}
      {sr.output && (
        <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
          {sr.output}
        </pre>
      )}
      {sr.error && (
        <p className="mt-2 text-xs text-red-600">Error: {sr.error}</p>
      )}
      {sr.reviewer && (
        <p className="mt-1 text-xs text-slate-400">
          Reviewed by {sr.reviewer}
          {sr.reviewNote ? ` — ${sr.reviewNote}` : ""}
        </p>
      )}
    </div>
  );
}


/* ---------- Create workflow (agent-bound or model-only steps) ---------- */

interface DraftStep {
  name: string;
  mode: "agent" | "model";
  agentId: string;
  modelId: string;
  prompt: string;
  reviewGate: boolean;
}

function CreateWorkflowModal({
  agents,
  models,
  tenants,
  onClose,
  onCreated,
}: {
  agents: AgentOption[];
  models: ModelOption[];
  tenants: TenantOption[];
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? "");
  const [steps, setSteps] = useState<DraftStep[]>([
    { name: "Step 1", mode: "agent", agentId: "", modelId: "", prompt: "", reviewGate: false },
  ]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Eligibility uses the SAME rule as the resolver: the agent's tenant must be
  // the workflow's tenant or an ANCESTOR of it. Filtering on exact equality (as
  // this did) hid agents the server would have accepted, and when the default
  // tenant did not match where the agents lived it showed an empty list with no
  // explanation.
  const eligible = agents.filter((a) =>
    agentEligibleForWorkflow(a.tenantId, tenantId, tenants)
  );
  const noAgentsReason = explainNoEligibleAgents(agents, tenantId, tenants);

  function patch(i: number, next: Partial<DraftStep>) {
    setSteps((cur) => cur.map((s, idx) => (idx === i ? { ...s, ...next } : s)));
  }

  async function create() {
    setError("");
    if (!name.trim()) return setError("Give the workflow a name.");
    if (!tenantId) return setError("Select an owning tenant.");
    const payload: WorkflowStep[] = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.prompt.trim()) return setError(`Step ${i + 1} needs a prompt.`);
      if (s.mode === "agent" && !s.agentId) return setError(`Step ${i + 1}: pick an agent.`);
      if (s.mode === "model" && !s.modelId) return setError(`Step ${i + 1}: pick a model.`);
      payload.push({
        id: `s${i + 1}`,
        name: s.name.trim() || `Step ${i + 1}`,
        prompt: s.prompt.trim(),
        toolRefs: [],
        knowledgeRefs: [],
        reviewGate: s.reviewGate,
        ...(s.mode === "agent" ? { agentId: s.agentId } : { modelId: s.modelId }),
      });
    }
    setBusy(true);
    try {
      const wf = await sendJSON<Workflow>("/api/workflows", "POST", {
        op: "create",
        name: name.trim(),
        description: description.trim(),
        tenantId,
        steps: payload,
      });
      await onCreated(wf.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New workflow"
      subtitle="Bind each step to a registered agent (inherits its model, prompt, tools and knowledge bases) or to a catalog model directly."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create workflow"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Supplier_Contract_Review"
            />
          </Field>
          <Field label="Owning tenant" required>
            <select
              className="input"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.tenantName}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this workflow produces"
          />
        </Field>

        <div className="space-y-3">
          {steps.map((s, i) => (
            <div key={i} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <input
                  className="input w-48"
                  value={s.name}
                  onChange={(e) => patch(i, { name: e.target.value })}
                  placeholder={`Step ${i + 1}`}
                />
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={s.reviewGate}
                      onChange={(e) => patch(i, { reviewGate: e.target.checked })}
                    />
                    review gate
                  </label>
                  {steps.length > 1 && (
                    <button
                      type="button"
                      className="text-xs text-slate-400 hover:text-red-600"
                      onClick={() => setSteps((cur) => cur.filter((_, idx) => idx !== i))}
                    >
                      remove
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-2 flex gap-2">
                {(["agent", "model"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => patch(i, { mode: m })}
                    className={`badge border px-3 py-1 ${
                      s.mode === m
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-slate-300 bg-white text-slate-600"
                    }`}
                  >
                    {m === "agent" ? "run as agent" : "model only"}
                  </button>
                ))}
              </div>

              {s.mode === "agent" ? (
                <div className="mt-2">
                  <Field
                    label="Agent"
                    hint={
                      noAgentsReason ??
                      "Inherits the agent's model, system prompt, tools and knowledge bases."
                    }
                  >
                    <select
                      className="input"
                      value={s.agentId}
                      onChange={(e) => patch(i, { agentId: e.target.value })}
                    >
                      <option value="">
                        {eligible.length === 0
                          ? "(no eligible agent for this tenant)"
                          : "(select an agent)"}
                      </option>
                      {eligible.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} — {a.modelRuntimeId}
                          {a.knowledgeCount > 0 ? ` · ${a.knowledgeCount} KB` : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : (
                <div className="mt-2">
                  <Field label="Catalog model">
                    <select
                      className="input"
                      value={s.modelId}
                      onChange={(e) => patch(i, { modelId: e.target.value })}
                    >
                      <option value="">(select a model)</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} — {m.inferenceProvider}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              <div className="mt-2">
                <Field label="Step instruction" required>
                  <textarea
                    className="input h-16"
                    value={s.prompt}
                    onChange={(e) => patch(i, { prompt: e.target.value })}
                    placeholder="What this step should produce"
                  />
                </Field>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              setSteps((cur) => [
                ...cur,
                {
                  name: `Step ${cur.length + 1}`,
                  mode: "agent",
                  agentId: "",
                  modelId: "",
                  prompt: "",
                  reviewGate: false,
                },
              ])
            }
          >
            + Add step
          </button>
        </div>
      </div>
    </Modal>
  );
}
