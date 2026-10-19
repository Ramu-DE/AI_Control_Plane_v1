"use client";

import { useEffect, useState } from "react";
import { PageHeader, Pill, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { Workflow, WorkflowRun, StepRun } from "@/lib/types";

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
  const [input, setInput] = useState(
    "Employee submitted a $4,200 business-class flight to a conference in Tokyo. Category: travel."
  );
  const [busy, setBusy] = useState(false);
  const [reviseText, setReviseText] = useState("");

  async function load() {
    const d = await getJSON<{ workflows: Workflow[]; runs: WorkflowRun[] }>(
      "/api/workflows"
    );
    setWorkflows(d.workflows);
    setRuns(d.runs);
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
    try {
      const run = await sendJSON<WorkflowRun>("/api/workflows", "POST", {
        op: "start",
        workflowId: wf.id,
        input,
      });
      setActiveRun(run);
      await load();
    } finally {
      setBusy(false);
    }
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
        subtitle="Multi-agent workflows executed for real on Amazon Bedrock, with human-in-the-loop review gates."
      />
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
              Each step is a real Bedrock Converse call. Gated steps pause for
              your approval.
            </p>
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
              {busy ? "Running on Bedrock…" : "▶ Start run"}
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
