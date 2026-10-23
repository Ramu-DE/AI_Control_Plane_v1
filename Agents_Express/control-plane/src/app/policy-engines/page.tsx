"use client";

import { useEffect, useState } from "react";
import { PageHeader, Pill, Modal, Field, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { EnforcementMode, PolicyEngine } from "@/lib/types";

interface EnginesData {
  engines: PolicyEngine[];
  libraryPolicies: { id: string; name: string; effect: string }[];
  gateways: { gatewayId: string; name: string }[];
}

export default function PolicyEnginesPage() {
  const [data, setData] = useState<EnginesData>({
    engines: [],
    libraryPolicies: [],
    gateways: [],
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    setData(await getJSON<EnginesData>("/api/policy-engines"));
  }
  useEffect(() => {
    load();
  }, []);

  const engine = data.engines.find((e) => e.id === selected);
  if (engine) {
    return (
      <EngineDetail
        engine={engine}
        data={data}
        onBack={() => setSelected(null)}
        onChanged={load}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Policy Engines"
        subtitle="AgentCore Policy engines hold Cedar policies and are attached to gateways to enforce them."
        action={
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            + Create Engine
          </button>
        }
      />
      <div className="px-8 pb-10">
        {data.engines.length === 0 ? (
          <EmptyState text="No policy engines yet." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.engines.map((e) => (
              <button
                key={e.id}
                onClick={() => setSelected(e.id)}
                className="card p-5 text-left transition hover:border-slate-300"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{e.name}</span>
                  <span className="badge bg-green-50 text-green-700">
                    {e.status}
                  </span>
                </div>
                <div className="mt-1 text-sm text-slate-500">{e.description}</div>
                <div className="mt-3 flex gap-2 text-xs text-slate-500">
                  <span className="badge bg-slate-100">
                    {e.importedPolicies.length} policies
                  </span>
                  <span className="badge bg-slate-100">
                    {e.gateways.length} gateway(s)
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateEngineModal
          onClose={() => setShowCreate(false)}
          onCreated={async (id) => {
            setShowCreate(false);
            await load();
            setSelected(id);
          }}
        />
      )}
    </>
  );
}

function CreateEngineModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function create() {
    setError(null);
    setBusy(true);
    try {
      const e = await sendJSON<PolicyEngine>("/api/policy-engines", "POST", {
        op: "create",
        name,
        description,
      });
      onCreated(e.id);
    } catch (err) {
      // Previously this rejection had nowhere to go: no message, no state
      // change, modal still open — indistinguishable from a dead button.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create Engine"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!name || busy}
            onClick={create}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}
        <Field label="Name" required>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="anycompany_policy_engine"
          />
        </Field>
        <Field label="Description">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Policy engine for AnyCompany internal tools"
          />
        </Field>
      </div>
    </Modal>
  );
}

function EngineDetail({
  engine,
  data,
  onBack,
  onChanged,
}: {
  engine: PolicyEngine;
  data: EnginesData;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<
    "overview" | "policies" | "gateways" | "sync"
  >("overview");
  const [showImport, setShowImport] = useState(false);
  const [showAttach, setShowAttach] = useState(false);

  async function syncAll() {
    await sendJSON("/api/policy-engines", "POST", {
      op: "sync",
      engineId: engine.id,
    });
    await onChanged();
  }
  async function importPolicy(policyId: string) {
    await sendJSON("/api/policy-engines", "POST", {
      op: "import",
      engineId: engine.id,
      policyId,
    });
    await onChanged();
  }
  async function attach(gatewayId: string, name: string, mode: EnforcementMode) {
    await sendJSON("/api/policy-engines", "POST", {
      op: "attach",
      engineId: engine.id,
      gatewayId,
      name,
      mode,
    });
    setShowAttach(false);
    await onChanged();
  }

  const importedIds = new Set(engine.importedPolicies.map((p) => p.policyId));
  const batches = engine.syncHistory;

  return (
    <>
      <div className="flex items-center gap-3 border-b border-slate-200 px-8 py-4">
        <button onClick={onBack} className="text-slate-500 hover:text-slate-900">
          ←
        </button>
        <h1 className="text-lg font-semibold">{engine.name}</h1>
        <span className="badge bg-green-50 text-green-700">{engine.status}</span>
      </div>

      <div className="flex gap-6 px-8 py-4 pb-10">
        <div className="card h-fit w-48 shrink-0 p-2">
          {([
            ["overview", "📖 Overview"],
            ["policies", "📄 Policies"],
            ["gateways", "⛓ Gateways"],
            ["sync", "🕘 Sync history"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                tab === k
                  ? "bg-slate-100 font-medium text-slate-900"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          {tab === "overview" && (
            <div className="card p-6">
              <div className="flex items-start justify-between">
                <h2 className="text-base font-semibold">Engine</h2>
                <button className="btn-primary" onClick={syncAll}>
                  ⟳ Sync all
                </button>
              </div>
              <div className="mt-5 grid grid-cols-1 gap-y-5 md:grid-cols-3">
                <D k="Status" v={<Pill status="Approved" />} />
                <D k="Region" v={engine.region} />
                <D k="Policies" v={String(engine.importedPolicies.length)} />
                <D k="Gateways" v={String(engine.gateways.length)} />
                <D k="Created" v={fmt(engine.createdAt)} />
                <D k="Last Updated" v={fmt(engine.updatedAt)} />
                <D
                  k="AWS Policy Engine ID"
                  v={<span className="mono text-xs">{engine.awsEngineId}</span>}
                />
                <D
                  k="AWS Policy Engine ARN"
                  v={<span className="mono text-xs">{engine.awsEngineArn}</span>}
                />
              </div>
              <div className="mt-6 border-t border-slate-100 pt-4">
                <div className="text-xs font-medium text-slate-400">Description</div>
                <div className="mt-1 text-sm text-slate-700">
                  {engine.description}
                </div>
              </div>
            </div>
          )}

          {tab === "policies" && (
            <div className="card p-6">
              <div className="flex items-start justify-between">
                <h2 className="text-base font-semibold">
                  Engine policies ({engine.importedPolicies.length})
                </h2>
                <button className="btn-ghost" onClick={() => setShowImport(true)}>
                  📚 Import from Library
                </button>
              </div>
              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Sync</th>
                      <th className="px-4 py-3">Last synced</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {engine.importedPolicies.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                          No policies yet. Import one from the library.
                        </td>
                      </tr>
                    ) : (
                      engine.importedPolicies.map((p) => (
                        <tr key={p.policyId}>
                          <td className="px-4 py-3 font-medium">{p.name}</td>
                          <td className="px-4 py-3">
                            <span className="badge bg-green-50 capitalize text-green-700">
                              {p.type}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`badge ${
                                p.synced
                                  ? "bg-green-50 text-green-700"
                                  : "bg-slate-100 text-slate-500"
                              }`}
                            >
                              {p.synced ? "Synced" : "Unsynced"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-500">
                            {p.lastSynced ? fmt(p.lastSynced) : "Never synced"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "gateways" && (
            <div className="card p-6">
              <div className="flex items-start justify-between">
                <h2 className="text-base font-semibold">Attached gateways</h2>
                <button className="btn-primary" onClick={() => setShowAttach(true)}>
                  + Attach gateway
                </button>
              </div>
              {engine.gateways.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">
                  No gateways attached. Attach one to enforce these policies on
                  incoming traffic.
                </p>
              ) : (
                <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                        <th className="px-4 py-3">Gateway</th>
                        <th className="px-4 py-3">Mode</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {engine.gateways.map((g) => (
                        <tr key={g.gatewayId}>
                          <td className="px-4 py-3 font-medium">{g.name}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`badge ${
                                g.mode === "Enforce"
                                  ? "bg-green-50 text-green-700"
                                  : "bg-amber-50 text-amber-700"
                              }`}
                            >
                              {g.mode}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === "sync" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">
                Sync history ({batches.length})
              </h2>
              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Scope</th>
                      <th className="px-4 py-3">Action</th>
                      <th className="px-4 py-3">Result</th>
                      <th className="px-4 py-3">Actor</th>
                      <th className="px-4 py-3">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {batches.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-3">
                          <span className="badge bg-slate-100 text-slate-600">
                            {s.scope}
                          </span>
                        </td>
                        <td className="px-4 py-3 mono text-xs text-slate-600">
                          {s.action}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`badge ${
                              s.result === "Success"
                                ? "bg-green-50 text-green-700"
                                : "bg-red-50 text-red-700"
                            }`}
                          >
                            {s.result}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{s.actor}</td>
                        <td className="px-4 py-3 text-slate-500">{fmt(s.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {showImport && (
        <Modal
          title="Import from Library"
          subtitle="Select policies to bind to this engine."
          onClose={() => setShowImport(false)}
          footer={
            <button className="btn-primary" onClick={() => setShowImport(false)}>
              Done
            </button>
          }
        >
          <div className="space-y-2">
            {data.libraryPolicies.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
              >
                <div>
                  <div className="font-medium">{p.name}</div>
                  <span className="badge bg-green-50 capitalize text-green-700">
                    {p.effect}
                  </span>
                </div>
                <button
                  className="btn-ghost"
                  disabled={importedIds.has(p.id)}
                  onClick={() => importPolicy(p.id)}
                >
                  {importedIds.has(p.id) ? "Imported" : "Import"}
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {showAttach && (
        <AttachGatewayModal
          gateways={data.gateways}
          attachedIds={new Set(engine.gateways.map((g) => g.gatewayId))}
          onClose={() => setShowAttach(false)}
          onAttach={attach}
        />
      )}
    </>
  );
}

function AttachGatewayModal({
  gateways,
  attachedIds,
  onClose,
  onAttach,
}: {
  gateways: { gatewayId: string; name: string }[];
  attachedIds: Set<string>;
  onClose: () => void;
  onAttach: (id: string, name: string, mode: EnforcementMode) => void;
}) {
  const available = gateways.filter((g) => !attachedIds.has(g.gatewayId));
  const [gatewayId, setGatewayId] = useState(available[0]?.gatewayId ?? "");
  const [mode, setMode] = useState<EnforcementMode>("Enforce");

  return (
    <Modal
      title="Attach gateway"
      subtitle="Attach a gateway to enforce these policies on incoming traffic."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!gatewayId}
            onClick={() =>
              onAttach(
                gatewayId,
                gateways.find((g) => g.gatewayId === gatewayId)!.name,
                mode
              )
            }
          >
            Attach
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Gateway">
          <select
            className="input"
            value={gatewayId}
            onChange={(e) => setGatewayId(e.target.value)}
          >
            {available.map((g) => (
              <option key={g.gatewayId} value={g.gatewayId}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <span className="label">Enforcement mode</span>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3">
              <input
                type="radio"
                checked={mode === "Enforce"}
                onChange={() => setMode("Enforce")}
                className="mt-1 accent-slate-900"
              />
              <span>
                <span className="block text-sm font-medium">Enforce</span>
                <span className="text-xs text-slate-500">
                  Denied requests are blocked at the gateway before any tool runs.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3">
              <input
                type="radio"
                checked={mode === "Log only"}
                onChange={() => setMode("Log only")}
                className="mt-1 accent-slate-900"
              />
              <span>
                <span className="block text-sm font-medium">Log only</span>
                <span className="text-xs text-slate-500">
                  Requests are evaluated and logged, but all are allowed through.
                </span>
              </span>
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function D({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-400">{k}</div>
      <div className="mt-1 text-sm text-slate-800">{v}</div>
    </div>
  );
}
function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
