"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { Persona } from "@/lib/types";

interface PgAgent {
  id: string;
  name: string;
  tenantId: string;
  visibility: string;
  toolNames: string[];
}
interface PgTenant {
  id: string;
  tenantName: string;
  tier: string;
}
interface PgModel {
  id: string;
  name: string;
  modelId: string;
  targetName?: string;
}
interface PlaygroundData {
  personas: Persona[];
  tenants: PgTenant[];
  agents: PgAgent[];
  tools: string[];
  gatewayModels: PgModel[];
}

interface Decision {
  layer: "gateway" | "avp";
  decision: "permit" | "forbid" | "default-deny";
  reason: string;
  policyName?: string;
}
interface SimResult {
  allowed: boolean;
  throttled?: boolean;
  limitKey?: string;
  decisions: Decision[];
  persona: {
    name: string;
    email: string;
    sub: string;
    groups: string[];
    provider: string;
  } | null;
  denial: string | null;
  response: string | null;
  evaluatedAt: string;
}

export default function PlaygroundPage() {
  const [data, setData] = useState<PlaygroundData | null>(null);
  const [personaId, setPersonaId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [tool, setTool] = useState("approveExpense");
  const [amount, setAmount] = useState("3000");
  const [modelId, setModelId] = useState("");
  const [runAgent, setRunAgent] = useState(true);
  const [result, setResult] = useState<SimResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    getJSON<PlaygroundData>("/api/playground").then((d) => {
      setData(d);
      setPersonaId(d.personas[0]?.id ?? "");
      // Default tenant = the first tenant that owns an agent.
      const firstAgent = d.agents[0];
      setTenantId(firstAgent?.tenantId ?? d.tenants[0]?.id ?? "");
      setAgentId(firstAgent?.id ?? "");
      if (d.tools.length)
        setTool(d.tools.includes("approveExpense") ? "approveExpense" : d.tools[0]);
    });
  }, []);

  async function run(override?: { personaId?: string; tool?: string; amount?: string }) {
    const pid = override?.personaId ?? personaId;
    const t = override?.tool ?? tool;
    const amt = override?.amount ?? amount;
    if (override) {
      setPersonaId(pid);
      setTool(t);
      setAmount(amt);
    }
    setRunning(true);
    try {
      const res = await sendJSON<SimResult>("/api/playground", "POST", {
        personaId: pid,
        agentId,
        tool: t,
        amount: amt,
        action: "invokeTool",
        runAgent,
        modelId,
      });
      setResult(res);
    } finally {
      setRunning(false);
    }
  }

  if (!data) return <div className="p-8 text-sm text-slate-500">Loading…</div>;

  const persona = data.personas.find((p) => p.id === personaId);

  // Agents scoped to the selected tenant.
  const tenantAgents = data.agents.filter((a) => a.tenantId === tenantId);
  const selectedAgent =
    data.agents.find((a) => a.id === agentId) ?? tenantAgents[0];
  // Tools come from the selected agent's attached tools; fall back to all.
  const agentTools =
    selectedAgent && selectedAgent.toolNames.length > 0
      ? selectedAgent.toolNames
      : data.tools;

  // Preset scenarios from the workshop.
  const byGroup = (g: string) =>
    data.personas.find((p) => p.groups?.includes(g))?.id ?? "";
  const presets = [
    { label: "Jane (IC) → listMyExpenses", personaId: byGroup("seniority_ic"), tool: "listMyExpenses", amount: "0", expect: "ALLOW" },
    { label: "Jane (IC) → approveExpense", personaId: byGroup("seniority_ic"), tool: "approveExpense", amount: "500", expect: "DENY @ gateway" },
    { label: "John (Manager) → approve $3,000", personaId: byGroup("seniority_manager"), tool: "approveExpense", amount: "3000", expect: "ALLOW" },
    { label: "John (Manager) → approve $7,500", personaId: byGroup("seniority_manager"), tool: "approveExpense", amount: "7500", expect: "DENY @ AVP" },
    { label: "Mary (Director) → approve $50,000", personaId: byGroup("seniority_director"), tool: "approveExpense", amount: "50000", expect: "ALLOW" },
  ].filter((p) => p.personaId);

  return (
    <>
      <PageHeader
        title="Playground"
        subtitle="Part 4 · End-to-end persona simulation — a real JWT identity flows through the gateway (AgentCore Policy) and the tool (Verified Permissions)."
      />
      <div className="px-8 pb-10">
        {/* Preset scenarios */}
        <div className="card mb-6 p-5">
          <h2 className="text-sm font-semibold">Workshop scenarios</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            One click to reproduce the Part 4 outcomes: ICs blocked at the
            perimeter, Managers blocked at AVP over budget, Directors approve
            anything.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {presets.map((p) => (
              <button
                key={p.label}
                onClick={() => run({ personaId: p.personaId, tool: p.tool, amount: p.amount })}
                disabled={running}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-xs hover:border-slate-400"
              >
                <div className="font-medium text-slate-800">{p.label}</div>
                <div className="text-[11px] text-slate-400">expect {p.expect}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          {/* LEFT: persona identity + request */}
          <div className="space-y-4">
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold">Agent (scoped by tenant)</h2>
              <label className="block">
                <span className="label">Tenant / Business Unit</span>
                <select
                  className="input"
                  value={tenantId}
                  onChange={(e) => {
                    const tid = e.target.value;
                    setTenantId(tid);
                    const first = data.agents.find((a) => a.tenantId === tid);
                    setAgentId(first?.id ?? "");
                  }}
                >
                  {data.tenants.map((t) => {
                    const count = data.agents.filter((a) => a.tenantId === t.id).length;
                    return (
                      <option key={t.id} value={t.id}>
                        {t.tenantName} ({count} agent{count === 1 ? "" : "s"})
                      </option>
                    );
                  })}
                </select>
              </label>
              <label className="mt-3 block">
                <span className="label">Agent</span>
                <select
                  className="input"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  disabled={tenantAgents.length === 0}
                >
                  {tenantAgents.length === 0 ? (
                    <option value="">No agents in this tenant</option>
                  ) : (
                    tenantAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} {a.visibility === "public" ? "· public" : ""}
                      </option>
                    ))
                  )}
                </select>
              </label>
              {selectedAgent && selectedAgent.toolNames.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {selectedAgent.toolNames.map((t) => (
                    <span key={t} className="badge bg-slate-100 font-mono text-slate-600">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold">Persona (identity)</h2>
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
              {persona && (
                <div className="mt-3 rounded-lg bg-slate-900 p-3">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Simulated JWT claims
                  </div>
                  <pre className="mono overflow-x-auto text-[11px] leading-relaxed text-slate-100">
{`{
  "sub": "${persona.sub.slice(0, 20)}…",
  "email": "${persona.email}",
  "cognito:groups": ${JSON.stringify(persona.groups)},
  "provider": "${persona.provider}"
}`}
                  </pre>
                </div>
              )}
            </div>

            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold">Tool call</h2>
              <div className="space-y-3">
                <label className="block">
                  <span className="label">
                    Preferred Model (gateway-routed — Part 5)
                  </span>
                  <select
                    className="input"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                  >
                    <option value="">Direct to Bedrock (no gateway)</option>
                    {data.gatewayModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} → {m.targetName}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    Gateway models route through the LLM gateway and are subject
                    to rate limits (429 on block).
                  </span>
                </label>
                <label className="block">
                  <span className="label">Tool</span>
                  <select
                    className="input"
                    value={tool}
                    onChange={(e) => setTool(e.target.value)}
                  >
                    {agentTools.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">Expense amount (for AVP budget check)</span>
                  <input
                    className="input"
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-slate-900"
                    checked={runAgent}
                    onChange={(e) => setRunAgent(e.target.checked)}
                  />
                  Run the agent on allow (real Bedrock response)
                </label>
                <button
                  className="btn-primary w-full"
                  onClick={() => run()}
                  disabled={running}
                >
                  {running ? "Simulating…" : "▶ Simulate request"}
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT: end-to-end flow */}
          <div className="card p-6">
            <h2 className="mb-4 text-sm font-semibold">End-to-end flow</h2>
            {!result ? (
              <p className="text-sm text-slate-500">
                Pick a scenario or simulate a request to trace it through the two
                authorization layers.
              </p>
            ) : (
              <Flow result={result} tool={tool} amount={amount} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Stage({
  label,
  state,
  children,
}: {
  label: string;
  state: "pass" | "deny" | "skip" | "info";
  children: React.ReactNode;
}) {
  const color =
    state === "pass"
      ? "border-green-300 bg-green-50"
      : state === "deny"
      ? "border-red-300 bg-red-50"
      : state === "skip"
      ? "border-slate-200 bg-slate-50 opacity-60"
      : "border-slate-200 bg-white";
  const icon = state === "pass" ? "✓" : state === "deny" ? "✕" : state === "skip" ? "–" : "•";
  return (
    <div className={`rounded-xl border p-4 ${color}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold">{icon}</span>
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <div className="mt-1 pl-6 text-sm text-slate-700">{children}</div>
    </div>
  );
}

function Arrow() {
  return <div className="my-1 text-center text-slate-300">↓</div>;
}

function Flow({
  result,
  tool,
  amount,
}: {
  result: SimResult;
  tool: string;
  amount: string;
}) {
  const gw = result.decisions.find((d) => d.layer === "gateway");
  const avp = result.decisions.find((d) => d.layer === "avp");
  const gwPass = gw?.decision === "permit";

  // Part 5: rate-limit throttle happens at the LLM gateway, before Cedar.
  if (result.throttled) {
    return (
      <div>
        <Stage label="1. Identity (Cognito JWT)" state="info">
          {result.persona?.name} · groups{" "}
          <span className="mono">{result.persona?.groups.join(", ")}</span>
        </Stage>
        <Arrow />
        <Stage label="2. LLM Gateway — Rate limit" state="deny">
          <div>
            <b>429 throttled</b> · limit fired: <b>{result.limitKey}</b>
          </div>
          <div className="text-xs text-slate-500">
            Rate limits run before Cedar. The request never reached the model.
          </div>
        </Stage>
        <Arrow />
        <Stage label="3. Model / tool" state="skip">
          Not reached — blocked at the gateway rate limit.
        </Stage>
        <div className="mt-4 rounded-xl bg-amber-100 p-3 text-center text-base font-semibold text-amber-800">
          ⏱ Request throttled — HTTP 429
        </div>
      </div>
    );
  }

  return (
    <div>
      <Stage label="1. Identity (Cognito JWT)" state="info">
        {result.persona?.name} · groups{" "}
        <span className="mono">{result.persona?.groups.join(", ")}</span>
      </Stage>
      <Arrow />
      <Stage
        label="2. Gateway — AgentCore Policy (Cedar)"
        state={gwPass ? "pass" : "deny"}
      >
        {gw ? (
          <>
            <div>
              <b>{gw.decision}</b>
              {gw.policyName ? ` · ${gw.policyName}` : ""}
            </div>
            <div className="text-xs text-slate-500">{gw.reason}</div>
          </>
        ) : (
          "—"
        )}
      </Stage>
      <Arrow />
      <Stage
        label="3. Tool — Verified Permissions (AVP)"
        state={!gwPass ? "skip" : avp?.decision === "permit" ? "pass" : "deny"}
      >
        {!gwPass ? (
          "Not reached — blocked at the perimeter."
        ) : avp ? (
          <>
            <div>
              <b>{avp.decision}</b>
              {avp.policyName ? ` · ${avp.policyName}` : ""}
            </div>
            <div className="text-xs text-slate-500">
              {avp.reason} (amount ${amount})
            </div>
          </>
        ) : (
          "No in-tool policy governs this tool; gateway decision stands."
        )}
      </Stage>
      <Arrow />
      <Stage
        label={`4. Result — ${tool}`}
        state={result.allowed ? "pass" : "deny"}
      >
        {result.allowed ? (
          result.response ? (
            <div className="rounded-lg bg-white p-3 text-sm text-slate-700">
              {result.response}
            </div>
          ) : (
            "Allowed — the agent would execute the tool."
          )
        ) : (
          <div className="text-red-700">{result.denial}</div>
        )}
      </Stage>

      <div
        className={`mt-4 rounded-xl p-3 text-center text-base font-semibold ${
          result.allowed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
        }`}
      >
        {result.allowed ? "✓ ALLOWED end-to-end" : "✕ DENIED"}
      </div>
    </div>
  );
}
