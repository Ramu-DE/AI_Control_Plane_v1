"use client";

import { useEffect, useState } from "react";
import { PageHeader, Pill, EmptyState } from "@/components/ui";
import { getJSON } from "@/lib/api";
import { PolicyStore } from "@/lib/types";

export default function PolicyStoresPage() {
  const [stores, setStores] = useState<PolicyStore[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    getJSON<{ stores: PolicyStore[] }>("/api/policy-stores").then((d) =>
      setStores(d.stores)
    );
  }, []);

  const store = stores.find((s) => s.id === selected);
  if (store) return <StoreDetail store={store} onBack={() => setSelected(null)} />;

  return (
    <>
      <PageHeader
        title="Policy Stores"
        subtitle="Manage Amazon Verified Permissions policy stores for tool-level authorization."
      />
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {stores.length === 0 ? (
          <EmptyState text="No policy stores." />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Region</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stores.map((s) => (
                  <tr
                    key={s.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => setSelected(s.id)}
                  >
                    <td className="px-4 py-3 font-medium">{s.name}</td>
                    <td className="px-4 py-3 text-slate-600">{s.description}</td>
                    <td className="px-4 py-3 text-slate-600">{s.region}</td>
                    <td className="px-4 py-3">
                      <span className="badge bg-green-50 text-green-700">
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-400">›</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function StoreDetail({
  store,
  onBack,
}: {
  store: PolicyStore;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "schema" | "policies" | "sync">(
    "overview"
  );

  return (
    <>
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={onBack}
          className="text-slate-500 hover:text-slate-900"
          aria-label="Back"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold">{store.name}</h1>
        <span className="badge bg-green-50 text-green-700">{store.status}</span>
      </div>
      <div className="flex flex-col gap-6 px-4 py-4 pb-10 sm:px-6 lg:flex-row lg:px-8">
        <div className="card h-fit p-2 lg:w-48 lg:shrink-0">
          <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {([
              ["overview", "📖 Overview"],
              ["schema", "🧩 Schema"],
              ["policies", "📄 Policies"],
              ["sync", "🕘 Sync history"],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                aria-current={tab === k ? "page" : undefined}
                className={`flex w-full shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                  tab === k
                    ? "bg-slate-100 font-medium text-slate-900"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          {tab === "overview" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">Overview</h2>
              <div className="mt-5 grid grid-cols-1 gap-y-5 md:grid-cols-3">
                <D k="Store Name" v={store.name} />
                <D k="Description" v={store.description} />
                <D k="Region" v={store.region} />
                <D
                  k="Namespace"
                  v={<span className="mono">{store.namespace}</span>}
                />
                <D
                  k="Policy store ID"
                  v={<span className="mono text-xs">{store.policyStoreId}</span>}
                />
                <D k="Status" v={<span className="badge bg-green-50 text-green-700">{store.status}</span>} />
              </div>
              <div className="mt-6 rounded-lg bg-blue-50 p-4 text-sm text-blue-900">
                The <b>namespace</b> ({store.namespace}) must match what the
                Lambda qualifies its entities with (e.g.{" "}
                <span className="mono">{store.namespace}::User</span>,{" "}
                <span className="mono">{store.namespace}::Expense</span>).
                A mismatch yields silent DENY decisions.
              </div>
            </div>
          )}

          {tab === "schema" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">Schema</h2>
              <pre className="mono mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                {store.schema}
              </pre>
            </div>
          )}

          {tab === "policies" && (
            <div className="space-y-4">
              <div className="card overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {store.policies.map((p) => (
                      <tr key={p.id}>
                        <td className="px-4 py-3 font-medium">{p.name}</td>
                        <td className="px-4 py-3">
                          <span className="badge bg-green-50 capitalize text-green-700">
                            {p.type}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Pill status={p.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {store.policies.map((p) => (
                <div key={p.id} className="card p-5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{p.name}</h3>
                    <Pill status={p.status} />
                  </div>
                  <pre className="mono mt-3 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                    {p.cedar}
                  </pre>
                </div>
              ))}
            </div>
          )}

          {tab === "sync" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">Sync history</h2>
              <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Scope</th>
                      <th className="px-4 py-3">Target</th>
                      <th className="px-4 py-3">Result</th>
                      <th className="px-4 py-3">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {store.syncHistory.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-3">
                          <span className="badge bg-slate-100 text-slate-600">
                            {s.scope}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{s.target}</td>
                        <td className="px-4 py-3">
                          <span className="badge bg-green-50 text-green-700">
                            {s.result}
                          </span>
                        </td>
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
    </>
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
