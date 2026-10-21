"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader, EmptyState } from "@/components/ui";
import { getJSON, sendJSON, withBase } from "@/lib/api";

// ---- Types mirroring the /api/aws/* contracts -----------------------------

interface Probe {
  service: string;
  state: "ok" | "access-denied" | "error" | "skipped";
  detail?: string;
  count?: number;
}
interface AwsStatus {
  ok: boolean;
  mode: "local" | "aws";
  region: string | null;
  regionError?: string | null;
  identity?: { account: string; arn: string; userId: string } | null;
  identityError?: string | null;
  probes: Probe[];
  message?: string;
  error?: string;
  code?: string;
}
interface KnowledgeBase {
  id: string;
  name: string;
  status: string;
  description?: string;
}
interface Agent {
  id: string;
  name: string;
  status: string;
  description?: string;
}
interface PolicyStore {
  id: string;
  arn?: string;
  description?: string;
}
interface RetrievalResult {
  content: string;
  score?: number;
  source?: string;
}

// A typed GET that tolerates honest non-2xx AWS responses (access-denied /
// local-mode) by returning the parsed body instead of throwing.
async function getList<T>(
  url: string,
  key: string
): Promise<{ items: T[]; error?: string; code?: string }> {
  try {
    const res = await fetch(withBase(url), { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { items: (body[key] as T[]) ?? [] };
    return { items: [], error: body.error ?? `HTTP ${res.status}`, code: body.code };
  } catch (e) {
    return { items: [], error: (e as Error).message };
  }
}

export default function AwsResourcesPage() {
  const [status, setStatus] = useState<AwsStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getJSON<AwsStatus>("/api/aws/status")
      .then(setStatus)
      .catch((e) =>
        setStatus({
          ok: false,
          mode: "local",
          region: null,
          probes: [],
          error: (e as Error).message,
        })
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const isAws = status?.mode === "aws";

  return (
    <>
      <PageHeader
        title="AWS Resources"
        subtitle="Execution mode, identity, service probes, and live Bedrock / Verified Permissions discovery."
        action={
          <button className="btn-primary" onClick={load}>
            Refresh
          </button>
        }
      />
      <div className="space-y-6 px-4 pb-10 sm:px-6 lg:px-8">
        <StatusPanel status={status} loading={loading} />
        {isAws && status?.identity && (
          <>
            <KnowledgeBasesPanel />
            <AgentsPanel />
            <PolicyStoresPanel />
          </>
        )}
      </div>
    </>
  );
}

function ModeBadge({ mode }: { mode: "local" | "aws" }) {
  const isAws = mode === "aws";
  return (
    <span
      className={`badge ${isAws ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${isAws ? "bg-green-500" : "bg-slate-400"}`} />
      {isAws ? "AWS (live)" : "Local (in-memory)"}
    </span>
  );
}

function StatusPanel({
  status,
  loading,
}: {
  status: AwsStatus | null;
  loading: boolean;
}) {
  if (loading && !status)
    return <div className="card p-6 text-sm text-slate-500">Loading status…</div>;
  if (!status) return null;

  return (
    <div className="card p-6">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold">Execution status</h2>
        <ModeBadge mode={status.mode} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-y-5 md:grid-cols-3">
        <D k="Mode" v={status.mode} />
        <D
          k="Region"
          v={
            status.region ? (
              <span className="mono">{status.region}</span>
            ) : (
              <span className="text-amber-600">
                {status.regionError || "not set"}
              </span>
            )
          }
        />
        <D
          k="Account"
          v={
            status.identity?.account ? (
              <span className="mono">{status.identity.account}</span>
            ) : (
              <span className="text-slate-400">—</span>
            )
          }
        />
        {status.identity?.arn && (
          <D
            k="Caller ARN"
            v={<span className="mono break-all text-xs">{status.identity.arn}</span>}
          />
        )}
      </div>

      {status.mode === "local" && (
        <div className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
          {status.message ||
            "Running against the local in-memory store. Set AWS_EXECUTION_MODE=aws (and AWS_REGION) to enable live AWS calls."}
        </div>
      )}
      {status.identityError && (
        <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          Identity probe: {status.identityError}
        </div>
      )}
      {status.error && (
        <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {status.code ? `${status.code}: ` : ""}
          {status.error}
        </div>
      )}

      {status.probes.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Service probes
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {status.probes.map((p) => (
              <div
                key={p.service}
                className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                <span className="mono text-xs">{p.service}</span>
                <ProbePill probe={p} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProbePill({ probe }: { probe: Probe }) {
  const styles: Record<string, string> = {
    ok: "bg-green-50 text-green-700",
    "access-denied": "bg-amber-50 text-amber-700",
    error: "bg-red-50 text-red-700",
    skipped: "bg-slate-100 text-slate-500",
  };
  const label =
    probe.state === "ok"
      ? typeof probe.count === "number"
        ? `ok · ${probe.count}`
        : "ok"
      : probe.state === "access-denied"
        ? "access denied"
        : probe.detail || probe.state;
  return <span className={`badge ${styles[probe.state]}`}>{label}</span>;
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function AccessNote({ error, code }: { error?: string; code?: string }) {
  if (!error) return null;
  const denied = code === "access-denied";
  return (
    <div
      className={`rounded-lg p-3 text-sm ${
        denied ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700"
      }`}
    >
      {denied ? "Access denied: " : ""}
      {error}
    </div>
  );
}

function KnowledgeBasesPanel() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getList<KnowledgeBase>("/api/aws/knowledge-bases", "knowledgeBases").then((r) => {
      setKbs(r.items);
      setError(r.error);
      setCode(r.code);
      setLoading(false);
    });
  }, []);

  return (
    <Panel title="Bedrock Knowledge Bases">
      {loading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : error ? (
        <AccessNote error={error} code={code} />
      ) : kbs.length === 0 ? (
        <EmptyState text="No Bedrock Knowledge Bases in this account/region." />
      ) : (
        <div className="space-y-6">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {kbs.map((kb) => (
                  <tr key={kb.id}>
                    <td className="px-4 py-3 font-medium">{kb.name}</td>
                    <td className="px-4 py-3">
                      <span className="mono text-xs">{kb.id}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="badge bg-green-50 text-green-700">
                        {kb.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <RetrieveForm knowledgeBases={kbs} />
        </div>
      )}
    </Panel>
  );
}

function RetrieveForm({ knowledgeBases }: { knowledgeBases: KnowledgeBase[] }) {
  const [kbId, setKbId] = useState(knowledgeBases[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RetrievalResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await sendJSON<{ results: RetrievalResult[] }>(
        "/api/aws/retrieve",
        "POST",
        { knowledgeBaseId: kbId, query }
      );
      setResults(res.results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-semibold">Test query (Retrieve)</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Read-only semantic retrieval — no model generation, no mutation.
      </p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <select
          className="input sm:w-64"
          value={kbId}
          onChange={(e) => setKbId(e.target.value)}
        >
          {knowledgeBases.map((kb) => (
            <option key={kb.id} value={kb.id}>
              {kb.name} ({kb.id})
            </option>
          ))}
        </select>
        <input
          className="input flex-1"
          placeholder="Ask the knowledge base…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim() && !busy) run();
          }}
        />
        <button
          className="btn-primary"
          onClick={run}
          disabled={busy || !kbId || !query.trim()}
        >
          {busy ? "Retrieving…" : "Retrieve"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {results && results.length === 0 && (
        <div className="mt-3 text-sm text-slate-500">No results.</div>
      )}
      {results && results.length > 0 && (
        <div className="mt-3 space-y-2">
          {results.map((r, i) => (
            <div key={i} className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="mono break-all">{r.source || "—"}</span>
                {typeof r.score === "number" && (
                  <span>score {r.score.toFixed(4)}</span>
                )}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-slate-700">
                {r.content}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentsPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getList<Agent>("/api/aws/agents", "agents").then((r) => {
      setAgents(r.items);
      setError(r.error);
      setCode(r.code);
      setLoading(false);
    });
  }, []);

  return (
    <Panel title="Bedrock Agents">
      {loading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : error ? (
        <AccessNote error={error} code={code} />
      ) : agents.length === 0 ? (
        <EmptyState text="No Bedrock agents in this account/region." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {agents.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-3 font-medium">{a.name}</td>
                  <td className="px-4 py-3">
                    <span className="mono text-xs">{a.id}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="badge bg-slate-100 text-slate-600">
                      {a.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function PolicyStoresPanel() {
  const [stores, setStores] = useState<PolicyStore[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getList<PolicyStore>("/api/aws/policy-stores", "policyStores").then((r) => {
      setStores(r.items);
      setError(r.error);
      setCode(r.code);
      setLoading(false);
    });
  }, []);

  return (
    <Panel title="Verified Permissions Policy Stores">
      {loading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : error ? (
        <AccessNote error={error} code={code} />
      ) : stores.length === 0 ? (
        <EmptyState text="No Verified Permissions policy stores in this account/region." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                <th className="px-4 py-3">Store ID</th>
                <th className="px-4 py-3">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stores.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3">
                    <span className="mono text-xs">{s.id}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {s.description || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
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
