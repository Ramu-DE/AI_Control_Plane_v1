"use client";

import { useEffect, useState } from "react";
import { Modal, Field, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import {
  DimensionType,
  InferenceTarget,
  MetricPeriod,
  RateLimit,
  RateLimitDimension,
  RateLimitEntry,
  TargetSource,
  OutboundAuth,
} from "@/lib/types";

interface GovData {
  targets: InferenceTarget[];
  rateLimits: RateLimit[];
  gatewayModels: { id: string; name: string; modelId: string }[];
}

export function GovernanceTab() {
  const [data, setData] = useState<GovData>({ targets: [], rateLimits: [], gatewayModels: [] });
  const [showTarget, setShowTarget] = useState(false);
  const [showRateLimit, setShowRateLimit] = useState(false);

  async function load() {
    setData(await getJSON<GovData>("/api/governance"));
  }
  useEffect(() => {
    load();
  }, []);

  async function delRateLimit(id: string) {
    await sendJSON("/api/governance", "POST", { op: "delete-ratelimit", id });
    await load();
  }

  return (
    <div className="space-y-6">
      {/* Targets */}
      <div className="card p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold">
              Targets{" "}
              <span className="text-slate-400">({data.targets.length})</span>
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Inference targets (model providers) the LLM gateway routes to.
            </p>
          </div>
          <button className="btn-primary" onClick={() => setShowTarget(true)}>
            + Add
          </button>
        </div>
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                <th className="px-4 py-3">Target name</th>
                <th className="px-4 py-3">Target status</th>
                <th className="px-4 py-3">Target type</th>
                <th className="px-4 py-3">Models</th>
                <th className="px-4 py-3">Outbound auth</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.targets.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3 font-medium">{t.name}</td>
                  <td className="px-4 py-3">
                    <span className="badge bg-green-50 text-green-700">{t.status}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {t.source === "Connector" ? `Connector - ${t.connector}` : "Custom (Provider)"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {t.models && t.models.length ? t.models.join(", ") : "all"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{t.outboundAuth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rate limits */}
      <div className="card p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold">
              Rate limits{" "}
              <span className="text-slate-400">({data.rateLimits.length})</span>
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Requests throttled with 429 when a threshold is exceeded. rate 0 =
              block. Evaluated with AND semantics across all limits.
            </p>
          </div>
          <button className="btn-primary" onClick={() => setShowRateLimit(true)}>
            + Add
          </button>
        </div>
        {data.rateLimits.length === 0 ? (
          <div className="mt-4">
            <EmptyState text="No rate limits yet." />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {data.rateLimits.map((r) => (
              <div key={r.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.dimensions.map((d, i) => (
                        <span key={i} className="badge bg-slate-100 text-slate-600">
                          {i + 1}. {d.type}
                          {d.oauthKey ? `:${d.oauthKey}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    className="text-slate-400 hover:text-red-600"
                    onClick={() => delRateLimit(r.id)}
                    title="Delete rate limit"
                  >
                    🗑
                  </button>
                </div>
                <div className="mt-3 overflow-x-auto rounded-lg border border-slate-100">
                  <table className="w-full min-w-[32rem] text-xs">
                    <thead>
                      <tr className="bg-slate-50 text-left font-semibold text-slate-500">
                        <th className="px-3 py-2">Dimension values</th>
                        <th className="px-3 py-2">Request</th>
                        <th className="px-3 py-2">Token</th>
                        <th className="px-3 py-2">Connection</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {r.entries.map((e) => (
                        <tr key={e.id}>
                          <td className="px-3 py-2 mono">
                            {e.conditions
                              .map((c) => (c.value === undefined ? "All" : c.value))
                              .join(" · ")}
                          </td>
                          <td className="px-3 py-2">
                            {e.requestRate !== null
                              ? `${e.requestRate} per ${e.requestPeriod.toLowerCase()}`
                              : "—"}
                          </td>
                          <td className="px-3 py-2">
                            {e.tokenRate !== null ? `${e.tokenRate} per minute` : "—"}
                          </td>
                          <td className="px-3 py-2">
                            {e.connectionRate !== null ? `${e.connectionRate} per second` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showTarget && (
        <AddTargetForm onClose={() => setShowTarget(false)} onDone={async () => { setShowTarget(false); await load(); }} />
      )}
      {showRateLimit && (
        <AddRateLimitForm onClose={() => setShowRateLimit(false)} onDone={async () => { setShowRateLimit(false); await load(); }} />
      )}
    </div>
  );
}

/* ---------- Add inference target ---------- */
function AddTargetForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [passthrough, setPassthrough] = useState(false);
  const [source, setSource] = useState<TargetSource>("Custom");
  const [endpoint, setEndpoint] = useState("https://bedrock-mantle.us-east-1.api.aws");
  const [apiPath, setApiPath] = useState("/v1/responses");
  const [modelsText, setModelsText] = useState("openai.gpt-oss-20b");
  const [outboundAuth, setOutboundAuth] = useState<OutboundAuth>("IAM Role");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    try {
      await sendJSON("/api/governance", "POST", {
        op: "add-target",
        name,
        description,
        passthrough,
        source,
        connector: source === "Connector" ? "Bedrock Mantle" : undefined,
        endpoint: source === "Custom" ? endpoint : undefined,
        apiPath: source === "Custom" ? apiPath : undefined,
        models:
          source === "Custom"
            ? modelsText.split(",").map((m) => m.trim()).filter(Boolean)
            : [],
        outboundAuth,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title="Add inference target"
      subtitle="Register a model provider on the LLM gateway."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!name} onClick={add}>Add target</button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Field label="Target name" required hint="a-z A-Z 0-9 and - (hyphen). Up to 50 characters.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="fast-tier" />
        </Field>
        <Field label="Target description" hint="optional">
          <textarea className="input h-16" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Low-cost tier, allowlisted to one model" />
        </Field>
        <div>
          <span className="label">Passthrough</span>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3">
            <input type="radio" className="mt-1 accent-slate-900" checked={!passthrough} onChange={() => setPassthrough(false)} />
            <span>
              <span className="block text-sm font-medium">Do not use passthrough</span>
              <span className="text-xs text-slate-500">Model-based routing and model ID translation.</span>
            </span>
          </label>
          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3">
            <input type="radio" className="mt-1 accent-slate-900" checked={passthrough} onChange={() => setPassthrough(true)} />
            <span>
              <span className="block text-sm font-medium">Use passthrough</span>
              <span className="text-xs text-slate-500">Forwarded as-is for non-inference operations.</span>
            </span>
          </label>
        </div>
        <Field label="Model source" hint="Choose a connector for zero-config, or Custom to declare it.">
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as TargetSource)}>
            <option value="Connector">Connector (Bedrock Mantle)</option>
            <option value="Custom">Custom (Provider)</option>
          </select>
        </Field>
        {source === "Custom" && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3">
            <Field label="Endpoint">
              <input className="input mono text-xs" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            </Field>
            <Field label="API path">
              <select className="input" value={apiPath} onChange={(e) => setApiPath(e.target.value)}>
                <option value="/v1/responses">/v1/responses</option>
                <option value="/v1/chat/completions">/v1/chat/completions</option>
              </select>
            </Field>
            <Field label="Models (allowlist, comma-separated)">
              <input className="input mono text-xs" value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder="openai.gpt-oss-20b" />
            </Field>
          </div>
        )}
        <Field label="Outbound Auth">
          <select className="input" value={outboundAuth} onChange={(e) => setOutboundAuth(e.target.value as OutboundAuth)}>
            <option value="IAM Role">IAM Role</option>
            <option value="API key">API key</option>
            <option value="OAuth">OAuth</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

/* ---------- Add rate limit (two-level form) ---------- */
const DIMENSION_TYPES: DimensionType[] = ["Target", "Tool", "Model", "OAuth Claim", "IAM Principal ARN", "IAM source Identity"];

function AddRateLimitForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dimensions, setDimensions] = useState<RateLimitDimension[]>([{ type: "Target" }]);
  const [entries, setEntries] = useState<RateLimitEntry[]>([]);
  const [showEntry, setShowEntry] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addDimension() {
    if (dimensions.length >= 3) return;
    setDimensions([...dimensions, { type: "Target" }]);
  }
  function setDim(i: number, patch: Partial<RateLimitDimension>) {
    setDimensions((ds) => ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }

  async function save() {
    setError(null);
    try {
      await sendJSON("/api/governance", "POST", {
        op: "add-ratelimit",
        name,
        description,
        dimensions,
        entries,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title="Add rate limit"
      subtitle="Define rate and token limits scoped by target, tool, model, or caller identity. Requests are rejected with a 429 when a threshold is exceeded."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!name || entries.length === 0} onClick={save}>Add rate limit</button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div>
          <h3 className="text-sm font-semibold">Rate limit details</h3>
          <Field label="Name" required hint="a-z A-Z 0-9 _ and - up to 50 characters. Cannot be changed after creation.">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="per-target-budget" />
          </Field>
          <div className="mt-3">
            <Field label="Description" hint="optional">
              <textarea className="input h-14" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Enter description" />
            </Field>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold">Dimensions</h3>
          <p className="text-xs text-slate-500">Select what each entry is scoped by. Priority order affects how the rate limit is applied.</p>
          <div className="mt-2 space-y-2">
            {dimensions.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-20 text-xs text-slate-500">Priority {i + 1}</span>
                <select
                  className="input flex-1"
                  value={d.type}
                  disabled={entries.length > 0}
                  onChange={(e) => setDim(i, { type: e.target.value as DimensionType })}
                >
                  {DIMENSION_TYPES.map((dt) => (
                    <option key={dt} value={dt}>{dt}</option>
                  ))}
                </select>
                {d.type === "OAuth Claim" && (
                  <input
                    className="input w-28"
                    placeholder="sub"
                    value={d.oauthKey ?? ""}
                    disabled={entries.length > 0}
                    onChange={(e) => setDim(i, { oauthKey: e.target.value })}
                  />
                )}
              </div>
            ))}
          </div>
          {dimensions.length < 3 && entries.length === 0 && (
            <button className="btn-ghost mt-2" onClick={addDimension}>+ Add dimension</button>
          )}
          {entries.length > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              Existing dimensions cannot be modified once entries exist.
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Entries ({entries.length})</h3>
            <button className="btn-ghost" onClick={() => setShowEntry(true)}>+ Add entry</button>
          </div>
          {entries.length === 0 ? (
            <p className="mt-2 text-xs text-slate-400">No entries yet. Add at least one (include a per- wildcard catch-all).</p>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[32rem] text-xs">
                <thead>
                  <tr className="bg-slate-50 text-left font-semibold text-slate-500">
                    <th className="px-3 py-2">Dimension values</th>
                    <th className="px-3 py-2">Request</th>
                    <th className="px-3 py-2">Token</th>
                    <th className="px-3 py-2">Connection</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="px-3 py-2 mono">
                        {e.conditions.map((c) => (c.value === undefined ? "All" : c.value)).join(" · ")}
                      </td>
                      <td className="px-3 py-2">{e.requestRate !== null ? `${e.requestRate} per ${e.requestPeriod.toLowerCase()}` : "—"}</td>
                      <td className="px-3 py-2">{e.tokenRate !== null ? `${e.tokenRate} per minute` : "—"}</td>
                      <td className="px-3 py-2">{e.connectionRate !== null ? `${e.connectionRate} per second` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showEntry && (
        <AddEntryForm
          dimensions={dimensions}
          onClose={() => setShowEntry(false)}
          onAdd={(entry) => {
            setEntries((es) => [...es, entry]);
            setShowEntry(false);
          }}
        />
      )}
    </Modal>
  );
}

/* ---------- Add entry sub-form ---------- */
function AddEntryForm({
  dimensions,
  onClose,
  onAdd,
}: {
  dimensions: RateLimitDimension[];
  onClose: () => void;
  onAdd: (e: RateLimitEntry) => void;
}) {
  const [requestRate, setRequestRate] = useState<string>("0");
  const [requestPeriod, setRequestPeriod] = useState<MetricPeriod>("Minute");
  const [tokenRate, setTokenRate] = useState<string>("");
  const [conditions, setConditions] = useState<{ specific: boolean; value: string }[]>(
    dimensions.map(() => ({ specific: false, value: "" }))
  );

  function setCond(i: number, patch: Partial<{ specific: boolean; value: string }>) {
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  function commit() {
    onAdd({
      id: `tmp-${Math.random().toString(36).slice(2, 8)}`,
      conditions: conditions.map((c) => ({ value: c.specific ? c.value : undefined })),
      requestRate: requestRate === "" ? null : Number(requestRate),
      requestPeriod,
      tokenRate: tokenRate === "" ? null : Number(tokenRate),
      connectionRate: null,
    });
  }

  return (
    <Modal
      title="Add entry"
      subtitle="A dimension-value combination with its rate limits."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={commit}>Add entry</button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Request rate limits</h3>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="Rate (0 = block)">
              <input className="input" type="number" value={requestRate} onChange={(e) => setRequestRate(e.target.value)} />
            </Field>
            <Field label="Time period">
              <select className="input" value={requestPeriod} onChange={(e) => setRequestPeriod(e.target.value as MetricPeriod)}>
                <option>Second</option>
                <option>Minute</option>
              </select>
            </Field>
          </div>
        </div>
        <Field label="Token rate limit (per minute, inference only — blank = none)">
          <input className="input" type="number" value={tokenRate} onChange={(e) => setTokenRate(e.target.value)} placeholder="20000" />
        </Field>
        <div>
          <h3 className="text-sm font-semibold">Dimension conditions</h3>
          <div className="mt-2 space-y-3">
            {dimensions.map((d, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3">
                <div className="mb-2 text-xs font-medium text-slate-600">
                  Priority {i + 1}: {d.type}
                  {d.oauthKey ? `:${d.oauthKey}` : ""}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="input w-40"
                    value={conditions[i].specific ? "specific" : "all"}
                    onChange={(e) => setCond(i, { specific: e.target.value === "specific" })}
                  >
                    <option value="all">All (per- wildcard)</option>
                    <option value="specific">Specific value</option>
                  </select>
                  {conditions[i].specific && (
                    <input
                      className="input mono flex-1 text-xs"
                      value={conditions[i].value}
                      onChange={(e) => setCond(i, { value: e.target.value })}
                      placeholder={d.type === "Target" ? "bedrock-mantle" : d.type === "OAuth Claim" ? "paste sub…" : "value"}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
