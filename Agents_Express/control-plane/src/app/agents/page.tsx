"use client";

import { useEffect, useState } from "react";
import {
  PageHeader,
  DetailHeader,
  Field,
  Pill,
  Toggle,
  EmptyState,
  Modal,
} from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import {
  AgentConfig,
  AgentVisibility,
  CatalogModel,
  RegistryRecord,
  Tenant,
} from "@/lib/types";

type SubTab = "general" | "model" | "prompt" | "tools" | "compute";

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [approved, setApproved] = useState<RegistryRecord[]>([]);
  const [tenants, setTenants] = useState<(Tenant & { config: { maxAgents: number } })[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    const [a, m, r, t] = await Promise.all([
      getJSON<AgentConfig[]>("/api/agents"),
      getJSON<CatalogModel[]>("/api/catalog"),
      getJSON<{ records: RegistryRecord[] }>("/api/registry"),
      getJSON<{ tenants: (Tenant & { config: { maxAgents: number } })[] }>("/api/tenants"),
    ]);
    setAgents(a);
    setModels(m);
    setApproved(r.records.filter((x) => x.status === "Approved"));
    setTenants(t.tenants);
  }
  useEffect(() => {
    load();
  }, []);

  const agent = agents.find((a) => a.id === selected);

  if (agent) {
    return (
      <AgentDetail
        agent={agent}
        models={models}
        approved={approved}
        tenants={tenants}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Declarative agents — model, prompt, tools, compute. AgentCore Runtime builds them at invocation."
        action={
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            + Create Agent
          </button>
        }
      />
      <div className="px-8 pb-10">
        {agents.length === 0 ? (
          <EmptyState text="No agents found." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelected(a.id)}
                className="card p-5 text-left transition hover:border-slate-300"
              >
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-md bg-gradient-to-br from-indigo-400 via-purple-400 to-orange-300" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{a.name}</div>
                    <div className="truncate text-xs text-slate-500">
                      {models.find((m) => m.id === a.modelId)?.name ?? a.modelId}
                    </div>
                  </div>
                  <Pill status={a.visibility} />
                </div>
                <p className="mt-3 line-clamp-2 text-sm text-slate-500">
                  {a.description}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateAgentModal
          models={models}
          approved={approved}
          tenants={tenants}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await load();
          }}
        />
      )}
    </>
  );
}

/* ---------- Create Agent (modal) ---------- */
function CreateAgentModal({
  models,
  approved,
  tenants,
  onClose,
  onCreated,
}: {
  models: CatalogModel[];
  approved: RegistryRecord[];
  tenants: (Tenant & { config: { maxAgents: number } })[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    tenantId: tenants[0]?.id ?? "",
    modelId: models[0]?.id ?? "",
    systemPrompt: "",
    toolRefs: [] as string[],
    visibility: "private" as AgentVisibility,
  });
  const [error, setError] = useState<string | null>(null);

  function toggleTool(id: string) {
    setForm((f) => ({
      ...f,
      toolRefs: f.toolRefs.includes(id)
        ? f.toolRefs.filter((t) => t !== id)
        : [...f.toolRefs, id],
    }));
  }

  async function create() {
    setError(null);
    try {
      await sendJSON("/api/agents", "POST", {
        ...form,
        compute: { runtime: "Bedrock AgentCore" },
        status: "ready",
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title="Create Agent"
      subtitle="Define a declarative agent: model, prompt, tools."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!form.name || !form.modelId}
            onClick={create}
          >
            Create Agent
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Field label="Agent name" required>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Expense Assistant"
          />
        </Field>
        <Field label="Tenant / Business Unit" required>
          <select
            className="input"
            value={form.tenantId}
            onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.tenantName} ({t.tier} · max {t.config.maxAgents} agents)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description">
          <input
            className="input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="AnyCompany internal expense assistant"
          />
        </Field>
        <Field label="Model">
          <select
            className="input"
            value={form.modelId}
            onChange={(e) => setForm({ ...form, modelId: e.target.value })}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="System prompt">
          <textarea
            className="input h-24"
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            placeholder="You are the AnyCompany Expense Assistant…"
          />
        </Field>
        <div>
          <span className="label">Tools (approved records only)</span>
          <div className="flex flex-wrap gap-2">
            {approved.length === 0 ? (
              <span className="text-xs text-slate-400">
                No approved records available.
              </span>
            ) : (
              approved.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggleTool(r.id)}
                  className={`badge border px-3 py-1 ${
                    form.toolRefs.includes(r.id)
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-600"
                  }`}
                >
                  {r.name}
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
          <div>
            <div className="text-sm font-medium">Public</div>
            <div className="text-xs text-slate-500">
              Anyone in your organization can see and use this agent.
            </div>
          </div>
          <Toggle
            on={form.visibility === "public"}
            onChange={(v) =>
              setForm({ ...form, visibility: v ? "public" : "private" })
            }
          />
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Agent Detail (sub-nav) ---------- */
function AgentDetail({
  agent,
  models,
  approved,
  tenants,
  onBack,
}: {
  agent: AgentConfig;
  models: CatalogModel[];
  approved: RegistryRecord[];
  tenants: (Tenant & { config: { maxAgents: number } })[];
  onBack: () => void;
}) {
  const [tab, setTab] = useState<SubTab>("general");
  const model = models.find((m) => m.id === agent.modelId);
  const tenant = tenants.find((t) => t.id === agent.tenantId);
  const tools = agent.toolRefs
    .map((id) => approved.find((r) => r.id === id))
    .filter(Boolean) as RegistryRecord[];

  const navItems: { key: SubTab; label: string; icon: string }[] = [
    { key: "general", label: "General", icon: "⚙" },
    { key: "model", label: "Model", icon: "◉" },
    { key: "prompt", label: "Prompt", icon: "💬" },
    { key: "tools", label: "Tools", icon: "🔧" },
    { key: "compute", label: "Compute", icon: "🗄" },
  ];

  return (
    <>
      <DetailHeader
        backHref="#"
        title={agent.name}
        subtitle="Configure agent settings and behavior"
        avatar
      />
      <div className="px-8 pt-3">
        <button
          onClick={onBack}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          ← Back to agents
        </button>
      </div>
      <div className="flex gap-6 px-8 py-4 pb-10">
        {/* Sub-nav */}
        <div className="card h-fit w-48 shrink-0 p-2">
          {navItems.map((it) => (
            <button
              key={it.key}
              onClick={() => setTab(it.key)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                tab === it.key
                  ? "bg-slate-100 font-medium text-slate-900"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span className="text-slate-400">{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>

        {/* Panel */}
        <div className="min-w-0 flex-1">
          {tab === "general" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">General</h2>
              <div className="mt-4 space-y-5">
                <Detail k="Name" v={agent.name} />
                <Detail k="Tenant / BU" v={tenant?.tenantName ?? agent.tenantId} />
                <Detail k="Description" v={agent.description || "—"} />
                <Detail k="Status" v={<Pill status={agent.status} />} />
                <div>
                  <div className="text-xs font-medium text-slate-400">
                    Visibility
                  </div>
                  <div className="mt-1 flex items-center gap-3">
                    <Pill status={agent.visibility} />
                    <span className="text-sm text-slate-500">
                      {agent.visibility === "public"
                        ? "Anyone in your organization can see and use this agent."
                        : "Private to the creator."}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "model" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">Model</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                The foundation model this agent uses.
              </p>
              <div className="mt-4 rounded-lg border border-slate-200 p-4">
                <div className="font-medium">{model?.name ?? agent.modelId}</div>
                <div className="mt-1 mono text-sm text-slate-600">
                  {model?.modelId}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {model?.modelProvider} · {model?.inferenceProvider}
                </div>
              </div>
            </div>
          )}

          {tab === "prompt" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">Prompt</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                The system prompt that constrains the agent&apos;s behavior.
              </p>
              <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
                {agent.systemPrompt || "No system prompt."}
              </pre>
            </div>
          )}

          {tab === "tools" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">Tools</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Manage the tools available to this agent. Tools allow the agent
                to perform actions beyond conversation.
              </p>
              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Tools</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {tools.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                          No tools attached.
                        </td>
                      </tr>
                    ) : (
                      tools.map((t) => (
                        <tr key={t.id}>
                          <td className="px-4 py-3">
                            <span className="font-medium">{t.name}</span>{" "}
                            <span className="badge bg-green-50 text-green-700">
                              Ready
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-600">Registry</td>
                          <td className="px-4 py-3">
                            <span className="badge bg-amber-50 font-mono uppercase text-amber-700">
                              {t.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-500">
                            {t.tools.length}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "compute" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">Compute Runtime</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                This agent runs on Amazon Bedrock AgentCore, the platform&apos;s
                managed compute runtime.
              </p>
              <div className="mt-4 flex items-start gap-3 rounded-lg border border-slate-200 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 text-white">
                  ◇
                </div>
                <div>
                  <div className="font-medium">Bedrock AgentCore</div>
                  <div className="mt-0.5 text-sm text-slate-500">
                    Fully managed runtime powered by Amazon Bedrock AgentCore.
                    Handles scaling, orchestration, and tool execution
                    automatically.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Detail({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-400">{k}</div>
      <div className="mt-1 text-sm text-slate-800">{v}</div>
    </div>
  );
}
