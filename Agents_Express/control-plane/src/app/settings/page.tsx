"use client";

import { useEffect, useState } from "react";
import { PageHeader, Field, Modal, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { CatalogModel, CognitoGroup, InferenceProvider, Persona } from "@/lib/types";
import { GovernanceTab } from "@/components/GovernanceTab";

export default function SettingsPage() {
  const [tab, setTab] = useState<"models" | "personas" | "governance">("models");
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [groups, setGroups] = useState<CognitoGroup[]>([]);
  const [query, setQuery] = useState("");
  const [showAddModel, setShowAddModel] = useState(false);
  const [showAddPersona, setShowAddPersona] = useState(false);
  const [modelForm, setModelForm] = useState({
    name: "",
    modelProvider: "Anthropic",
    modelId: "",
    inferenceProvider: "Amazon Bedrock" as InferenceProvider,
  });

  async function load() {
    const [m, pg] = await Promise.all([
      getJSON<CatalogModel[]>("/api/catalog"),
      getJSON<{ personas: Persona[]; groups: CognitoGroup[] }>("/api/personas"),
    ]);
    setModels(m);
    setPersonas(pg.personas);
    setGroups(pg.groups);
  }
  useEffect(() => {
    load();
  }, []);

  async function addModel() {
    await sendJSON("/api/catalog", "POST", modelForm);
    setShowAddModel(false);
    setModelForm({
      name: "",
      modelProvider: "Anthropic",
      modelId: "",
      inferenceProvider: "Amazon Bedrock",
    });
    await load();
  }

  const shownModels = models.filter((m) =>
    `${m.name} ${m.modelProvider} ${m.modelId}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  return (
    <>
      <PageHeader
        title="Platform Settings"
        subtitle="Configure platform-wide settings and available resources"
      />
      <div className="flex gap-8 px-8 pb-10">
        <div className="w-48 shrink-0">
          <div className="card space-y-1 p-2">
            {(["models", "personas", "governance"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm capitalize ${
                  tab === t
                    ? "bg-slate-100 font-medium text-slate-900"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {t === "models"
                  ? "⚙ Models"
                  : t === "personas"
                  ? "👥 Personas"
                  : "◐ Governance"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1">
          {tab === "models" && (
            <div className="card p-6">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-base font-semibold">Available Models</h2>
                  <p className="mt-0.5 text-sm text-slate-500">
                    Manage the AI models available to users on the platform.
                  </p>
                </div>
                <button className="btn-primary" onClick={() => setShowAddModel(true)}>
                  + Add Model
                </button>
              </div>
              <div className="mt-4">
                <input
                  className="input"
                  placeholder="Search models..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Model Provider</th>
                      <th className="px-4 py-3">Model ID</th>
                      <th className="px-4 py-3">Inference Provider</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shownModels.map((m) => (
                      <tr key={m.id}>
                        <td className="px-4 py-3 font-medium">{m.name}</td>
                        <td className="px-4 py-3 text-slate-600">
                          <span className="text-orange-500">✳</span> {m.modelProvider}
                        </td>
                        <td className="px-4 py-3">
                          <span className="mono text-slate-700">{m.modelId}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          🟢 {m.inferenceProvider}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-400">⋮</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "personas" && (
            <div className="card p-6">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-base font-semibold">Personas</h2>
                  <p className="mt-0.5 text-sm text-slate-500">
                    Manage test personas from identity providers for agent
                    execution testing.
                  </p>
                </div>
                <button
                  className="btn-primary"
                  onClick={() => setShowAddPersona(true)}
                >
                  + Add Persona
                </button>
              </div>
              <div className="mt-4">
                <input className="input" placeholder="Search personas..." />
              </div>
              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Sub</th>
                      <th className="px-4 py-3">Groups</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Email</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {personas.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                          No personas.
                        </td>
                      </tr>
                    ) : (
                      personas.map((p) => (
                        <tr key={p.id}>
                          <td className="px-4 py-3 font-medium">{p.name}</td>
                          <td className="px-4 py-3">
                            <span className="mono rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">
                              {p.sub.slice(0, 18)}…
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {p.groups.join(", ")}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            <span className="text-purple-500">◆</span> {p.provider}
                          </td>
                          <td className="px-4 py-3 text-slate-600">{p.email}</td>
                          <td className="px-4 py-3 text-right text-slate-400">⋮</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "governance" && <GovernanceTab />}
        </div>
      </div>

      {showAddModel && (
        <Modal
          title="Add Model"
          subtitle="Make a foundation model available to agents on the platform."
          onClose={() => setShowAddModel(false)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setShowAddModel(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!modelForm.name || !modelForm.modelId}
                onClick={addModel}
              >
                Add Model
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Name" required>
              <input
                className="input"
                value={modelForm.name}
                onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })}
                placeholder="Claude Opus 4.6"
              />
            </Field>
            <Field label="Model Provider" required>
              <input
                className="input"
                value={modelForm.modelProvider}
                onChange={(e) =>
                  setModelForm({ ...modelForm, modelProvider: e.target.value })
                }
              />
            </Field>
            <Field label="Model ID" required>
              <input
                className="input mono"
                value={modelForm.modelId}
                onChange={(e) => setModelForm({ ...modelForm, modelId: e.target.value })}
                placeholder="global.anthropic.claude-opus-4-6-v1:0"
              />
            </Field>
            <Field label="Inference Provider" required>
              <select
                className="input"
                value={modelForm.inferenceProvider}
                onChange={(e) =>
                  setModelForm({
                    ...modelForm,
                    inferenceProvider: e.target.value as InferenceProvider,
                  })
                }
              >
                <option>Amazon Bedrock</option>
                <option>Anthropic</option>
                <option>OpenAI</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}

      {showAddPersona && (
        <AddPersonaModal
          groups={groups}
          onClose={() => setShowAddPersona(false)}
          onAdded={async () => {
            setShowAddPersona(false);
            await load();
            setTab("personas");
          }}
        />
      )}
    </>
  );
}

function AddPersonaModal({
  groups,
  onClose,
  onAdded,
}: {
  groups: CognitoGroup[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [provider, setProvider] = useState<Persona["provider"]>("AWS Cognito");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function toggle(g: string) {
    setSelected((s) =>
      s.includes(g) ? s.filter((x) => x !== g) : [...s, g]
    );
  }

  async function add() {
    setError(null);
    try {
      await sendJSON("/api/personas", "POST", {
        name,
        email,
        provider,
        groups: selected,
      });
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title="Add Persona"
      subtitle="Create a new persona profile from an identity provider. This persona can be used for testing agent execution."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!name || !email || selected.length === 0}
            onClick={add}
          >
            Add Persona
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Field label="Display Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
          />
        </Field>
        <Field label="Email">
          <input
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane_doe@anycompany.com"
          />
        </Field>
        <Field label="Identity Provider">
          <select
            className="input"
            value={provider}
            onChange={(e) => setProvider(e.target.value as Persona["provider"])}
          >
            <option value="AWS Cognito">AWS Cognito</option>
            <option value="Entra ID">Entra ID</option>
          </select>
        </Field>
        <div>
          <span className="label">Assign Groups</span>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            {groups.map((g) => (
              <label
                key={g.name}
                className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 hover:bg-slate-50"
              >
                <span>
                  <span className="block text-sm font-medium">{g.name}</span>
                  <span className="block text-xs text-slate-500">
                    {g.description}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-slate-900"
                  checked={selected.includes(g.name)}
                  onChange={() => toggle(g.name)}
                />
              </label>
            ))}
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {selected.length} group(s) selected
          </div>
          {selected.map((g) => (
            <div
              key={g}
              className="mt-2 flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"
            >
              <div>
                <div className="text-sm font-medium">{g}</div>
                <div className="text-xs text-slate-500">
                  {groups.find((x) => x.name === g)?.description}
                </div>
              </div>
              <button
                onClick={() => toggle(g)}
                className="text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
