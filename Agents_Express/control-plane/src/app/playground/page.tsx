"use client";

import { useEffect, useState } from "react";
import { PageHeader, Field } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import {
  AgentConfig,
  EvaluationResult,
  LayerDecision,
  Persona,
} from "@/lib/types";

interface PlaygroundData {
  personas: Persona[];
  agents: AgentConfig[];
  tools: string[];
}

function DecisionRow({ d }: { d: LayerDecision }) {
  const color =
    d.decision === "permit"
      ? "text-green-700 bg-green-50 border-green-200"
      : "text-red-700 bg-red-50 border-red-200";
  return (
    <div className={`rounded-lg border p-3 ${color}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">
          {d.layer === "gateway" ? "Gateway (AgentCore Policy)" : "AVP (in tool)"}
        </span>
        <span className="badge bg-white/60 font-semibold">{d.decision}</span>
      </div>
      <p className="mt-1 text-sm">{d.reason}</p>
    </div>
  );
}

export default function PlaygroundPage() {
  const [data, setData] = useState<PlaygroundData | null>(null);
  const [personaId, setPersonaId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [tool, setTool] = useState("");
  const [amount, setAmount] = useState("1000");
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    getJSON<PlaygroundData>("/api/playground").then((d) => {
      setData(d);
      setPersonaId(d.personas[0]?.id ?? "");
      setAgentId(d.agents[0]?.id ?? "");
      setTool(d.tools[0] ?? "");
    });
  }, []);

  async function run() {
    setRunning(true);
    try {
      const res = await sendJSON<EvaluationResult>("/api/playground", "POST", {
        personaId,
        agentId,
        tool,
        action: "invokeTool",
        amount,
      });
      setResult(res);
    } finally {
      setRunning(false);
    }
  }

  if (!data) return <div className="p-8 text-sm text-slate-500">Loading…</div>;

  const persona = data.personas.find((p) => p.id === personaId);

  return (
    <>
      <PageHeader
        title="Playground"
        subtitle="Part 4 · Simulate a persona invoking a tool and watch both authorization layers decide."
      />
      <div className="grid gap-6 p-8 lg:grid-cols-2">
        <div className="card p-6">
          <h2 className="mb-4 text-sm font-semibold">Simulation request</h2>
          <div className="space-y-4">
            <Field label="Persona">
              <select
                className="input"
                value={personaId}
                onChange={(e) => setPersonaId(e.target.value)}
              >
                {data.personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            {persona && (
              <div className="flex flex-wrap gap-2">
                {Object.entries(persona.attributes).map(([k, v]) => (
                  <span key={k} className="badge bg-slate-100 text-slate-600">
                    {k}: {v}
                  </span>
                ))}
              </div>
            )}
            <Field label="Agent">
              <select
                className="input"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {data.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tool">
              <select
                className="input"
                value={tool}
                onChange={(e) => setTool(e.target.value)}
              >
                {data.tools.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Resource amount (for budget policies)">
              <input
                className="input"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <button className="btn-primary w-full" onClick={run} disabled={running}>
              {running ? "Evaluating…" : "Evaluate authorization"}
            </button>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="mb-4 text-sm font-semibold">Decision</h2>
          {!result ? (
            <p className="text-sm text-slate-500">
              Run a simulation to see the layered decision.
            </p>
          ) : (
            <div className="space-y-4">
              <div
                className={`rounded-xl p-4 text-center text-lg font-semibold ${
                  result.allowed
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                {result.allowed ? "✓ ALLOWED" : "✕ DENIED"}
              </div>
              {result.decisions.map((d, i) => (
                <DecisionRow key={i} d={d} />
              ))}
              <p className="text-xs text-slate-400">
                Evaluated {new Date(result.evaluatedAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
