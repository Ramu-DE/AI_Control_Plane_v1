"use client";

import { useEffect, useState } from "react";
import { PageHeader, Field, Modal, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import {
  CatalogModel,
  CognitoGroup,
  INFERENCE_PROVIDERS,
  InferenceProvider,
  Persona,
  TenantRole,
} from "@/lib/types";
import { GovernanceTab } from "@/components/GovernanceTab";
import { ActingAsSelect, useActingPersona } from "@/components/ActingAs";
import { deleteJSON } from "@/lib/api";

interface TenantOption {
  id: string;
  name: string;
  parentId: string | null;
}

/** Tenants depth-first under their parents, for an indented picker. */
function treeOrder(tenants: TenantOption[]): { t: TenantOption; depth: number }[] {
  const out: { t: TenantOption; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const t of tenants.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export default function SettingsPage() {
  const [tab, setTab] = useState<"models" | "personas" | "governance">("models");
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [groups, setGroups] = useState<CognitoGroup[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [personaQuery, setPersonaQuery] = useState("");
  const [showAddModel, setShowAddModel] = useState(false);
  const [showAddPersona, setShowAddPersona] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);
  const acting = useActingPersona();
  const [personaMsg, setPersonaMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function removePersona(p: Persona) {
    setPersonaMsg(null);
    if (!acting.personaId) {
      setPersonaMsg({ ok: false, text: "Choose who is acting first (an admin of the persona's tenants)." });
      return;
    }
    try {
      const r = await deleteJSON<{ outcome: string }>(
        `/api/personas?id=${encodeURIComponent(p.id)}&actorPersonaId=${encodeURIComponent(acting.personaId)}`);
      if (!r.ok) throw new Error(r.body.error ?? `failed (${r.status})`);
      const outcome = r.body.outcome;
      setPersonaMsg({ ok: true, text: `${p.name}: ${outcome}${outcome === "disabled" ? " (kept for the audit trail)" : ""}` });
      await load();
    } catch (e) {
      setPersonaMsg({ ok: false, text: (e as Error).message });
    }
  }
  const [modelForm, setModelForm] = useState({
    name: "",
    modelProvider: "Anthropic",
    modelId: "",
    inferenceProvider: "Amazon Bedrock" as InferenceProvider,
  });

  async function load() {
    const [m, pg] = await Promise.all([
      getJSON<CatalogModel[]>("/api/catalog"),
      getJSON<{ personas: Persona[]; groups: CognitoGroup[]; tenants: TenantOption[] }>("/api/personas"),
    ]);
    setModels(m);
    setPersonas(pg.personas);
    setGroups(pg.groups);
    setTenants(pg.tenants ?? []);
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
      .includes(modelQuery.toLowerCase())
  );

  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.name ?? id;
  const shownPersonas = personas.filter((p) =>
    `${p.name} ${p.email} ${p.sub} ${p.groups.join(" ")} ${p.provider} ${(p.memberships ?? [])
      .map((m) => `${m.tenantId} ${tenantName(m.tenantId)} ${m.role}`).join(" ")}`
      .toLowerCase()
      .includes(personaQuery.toLowerCase())
  );

  return (
    <>
      <PageHeader
        title="Platform Settings"
        subtitle="Configure platform-wide settings and available resources"
      />
      <div className="flex flex-col gap-6 px-4 pb-10 sm:px-6 lg:flex-row lg:gap-8 lg:px-8">
        <div className="lg:w-48 lg:shrink-0">
          <div className="card flex gap-1 overflow-x-auto p-2 lg:flex-col lg:space-y-1 lg:overflow-visible">
            {(["models", "personas", "governance"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-current={tab === t ? "page" : undefined}
                className={`flex w-full shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm capitalize ${
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

        <div className="min-w-0 flex-1">
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
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                />
              </div>
              <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Model Provider</th>
                      <th className="px-4 py-3">Model ID</th>
                      <th className="px-4 py-3">Inference Provider</th>
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
                    Identities from the IdP, scoped to Takeda tenants. A persona can only
                    act in a tenant it is a member of (or one beneath it), and Cedar sees
                    its role there as <span className="mono">principal.tenantRole</span>.
                  </p>
                </div>
                <button
                  className="btn-primary"
                  onClick={() => setShowAddPersona(true)}
                >
                  + Add Persona
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <ActingAsSelect {...acting}
                  hint="Edits and removals need an admin of every tenant whose access changes; you cannot change your own." />
                {personaMsg && (
                  <span className={`rounded-lg px-3 py-2 text-sm ${personaMsg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                    {personaMsg.text}
                  </span>
                )}
              </div>
              <div className="mt-4">
                <input
                  className="input"
                  placeholder="Search personas..."
                  value={personaQuery}
                  onChange={(e) => setPersonaQuery(e.target.value)}
                />
              </div>
              <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[48rem] text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Tenant access</th>
                      <th className="px-4 py-3">Region / GxP</th>
                      <th className="px-4 py-3">Groups</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Email</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shownPersonas.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                          No personas.
                        </td>
                      </tr>
                    ) : (
                      shownPersonas.map((p) => (
                        <tr key={p.id}>
                          <td className="px-4 py-3">
                            <span className="block font-medium">{p.name}</span>
                            <span className="mono text-xs text-slate-400">{p.sub.slice(0, 13)}…</span>
                            {p.attributes.jobTitle && (
                              <span className="block text-xs text-slate-500">{p.attributes.jobTitle}</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {(p.memberships ?? []).length === 0 ? (
                              <span className="badge bg-red-50 text-red-700">unscoped — cannot act</span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {(p.memberships ?? []).map((m) => (
                                  <span key={m.tenantId} className="badge bg-indigo-50 text-indigo-700"
                                    title={`${m.role} in ${m.tenantId} and every tenant beneath it`}>
                                    {tenantName(m.tenantId)} · {m.role}
                                    {m.tenantId === "takeda" ? " (org-wide)" : ""}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600">
                            {p.attributes.region ?? "—"}
                            {" · "}
                            {p.attributes.gxpTrained === "true" ? "GxP ✓" : "no GxP"}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {p.groups.join(", ")}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            <span className="text-purple-500">◆</span> {p.provider}
                          </td>
                          <td className="px-4 py-3 text-slate-600">{p.email}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right">
                            {p.disabled ? (
                              <span className="badge bg-slate-200 text-slate-600">disabled</span>
                            ) : (
                              <>
                                <button className="btn-ghost text-xs" onClick={() => setEditing(p)}>Edit</button>
                                <button className="btn-ghost text-xs text-red-700" onClick={() => removePersona(p)}>Remove</button>
                              </>
                            )}
                          </td>
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

      {editing && (
        <EditPersonaModal
          persona={editing}
          tenants={tenants}
          actorPersonaId={acting.personaId}
          onClose={() => setEditing(null)}
          onSaved={async (text) => {
            setEditing(null);
            setPersonaMsg({ ok: true, text });
            await load();
          }}
        />
      )}

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
                {INFERENCE_PROVIDERS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
          </div>
        </Modal>
      )}

      {showAddPersona && (
        <AddPersonaModal
          groups={groups}
          tenants={tenants}
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
  tenants,
  onClose,
  onAdded,
}: {
  groups: CognitoGroup[];
  tenants: TenantOption[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [provider, setProvider] = useState<Persona["provider"]>("Entra ID");
  const [selected, setSelected] = useState<string[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [role, setRole] = useState<TenantRole>("analyst");
  const [region, setRegion] = useState("US");
  const [gxpTrained, setGxpTrained] = useState(false);
  const [jobTitle, setJobTitle] = useState("");
  const tree = treeOrder(tenants);
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
        tenantId,
        role,
        region,
        gxpTrained,
        ...(jobTitle ? { jobTitle } : {}),
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
            disabled={!name || !email || !tenantId}
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
            placeholder="jane.doe@takeda.com"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tenant (BU / function)" hint="Membership covers this tenant and everything beneath it — never siblings or parents.">
            <select className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">Select a tenant…</option>
              {tree.map(({ t, depth }) => (
                <option key={t.id} value={t.id}>
                  {"\u00a0\u00a0".repeat(depth)}{depth ? "└ " : ""}{t.name} ({t.id})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Role in that tenant">
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as TenantRole)}>
              <option value="viewer">viewer — read results</option>
              <option value="analyst">analyst — run agents and workflows</option>
              <option value="approver">approver — approve review gates and records</option>
              <option value="admin">admin — manage the tenant</option>
            </select>
          </Field>
          <Field label="Data region (residency)">
            <select className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
              {["US", "EU", "JP", "GLOBAL"].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Job title (optional)">
            <input className="input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Clinical Data Scientist" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-slate-900" checked={gxpTrained}
            onChange={(e) => setGxpTrained(e.target.checked)} />
          GxP trained <span className="text-xs text-slate-500">(Cedar: principal.gxpTrained)</span>
        </label>
        {tenantId && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            IdP group this persona will carry:{" "}
            <span className="mono">TKD-{tenantId.toUpperCase()}-{role.toUpperCase()}</span>
          </p>
        )}
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
          <span className="label">Seniority group (optional — drives the expense demo&apos;s approval limit)</span>
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

function EditPersonaModal({
  persona,
  tenants,
  actorPersonaId,
  onClose,
  onSaved,
}: {
  persona: Persona;
  tenants: TenantOption[];
  actorPersonaId: string;
  onClose: () => void;
  onSaved: (text: string) => Promise<void>;
}) {
  const [memberships, setMemberships] = useState<{ tenantId: string; role: TenantRole }[]>(
    (persona.memberships ?? []).map((m) => ({ ...m })));
  const [region, setRegion] = useState(persona.attributes.region ?? "US");
  const [gxpTrained, setGxpTrained] = useState(persona.attributes.gxpTrained === "true");
  const [jobTitle, setJobTitle] = useState(persona.attributes.jobTitle ?? "");
  const [error, setError] = useState<string | null>(null);
  const tree = treeOrder(tenants);

  const update = (i: number, patch: Partial<{ tenantId: string; role: TenantRole }>) =>
    setMemberships((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  async function save() {
    setError(null);
    try {
      await sendJSON("/api/personas", "PATCH", {
        id: persona.id,
        actorPersonaId,
        memberships: memberships.filter((m) => m.tenantId),
        region,
        gxpTrained,
        jobTitle,
      });
      await onSaved(`${persona.name} updated`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title={`Edit ${persona.name}`}
      subtitle="Change tenant access and attributes. You can only change access in tenants you administer."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!actorPersonaId || memberships.every((m) => !m.tenantId)}
            onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {!actorPersonaId && (
          <p className="text-sm text-amber-700">Choose who is acting (above the table) before saving.</p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div>
          <span className="label">Tenant access</span>
          <div className="space-y-2">
            {memberships.map((m, i) => (
              <div key={i} className="flex gap-2">
                <select className="input" value={m.tenantId} onChange={(e) => update(i, { tenantId: e.target.value })}>
                  <option value="">Select a tenant…</option>
                  {tree.map(({ t, depth }) => (
                    <option key={t.id} value={t.id}>
                      {"\u00a0\u00a0".repeat(depth)}{depth ? "└ " : ""}{t.name} ({t.id})
                    </option>
                  ))}
                </select>
                <select className="input w-40" value={m.role} onChange={(e) => update(i, { role: e.target.value as TenantRole })}>
                  {["viewer", "analyst", "approver", "admin"].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button className="btn-ghost text-red-700" onClick={() => setMemberships((ms) => ms.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button className="btn-ghost text-sm" onClick={() => setMemberships((ms) => [...ms, { tenantId: "", role: "viewer" }])}>
              + Add tenant
            </button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Data region">
            <select className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
              {["US", "EU", "JP", "GLOBAL"].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Job title">
            <input className="input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-slate-900" checked={gxpTrained}
            onChange={(e) => setGxpTrained(e.target.checked)} />
          GxP trained
        </label>
      </div>
    </Modal>
  );
}
