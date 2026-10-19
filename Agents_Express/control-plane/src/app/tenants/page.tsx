"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, Modal, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { Tenant, TenantTier, TierConfig } from "@/lib/types";

type TenantWithConfig = Tenant & { config: TierConfig };

const TYPE_META: Record<Tenant["type"], { label: string; icon: string; color: string }> = {
  org: { label: "Org", icon: "🏛", color: "bg-slate-900 text-white" },
  bu: { label: "Business Unit", icon: "🏢", color: "bg-indigo-50 text-indigo-700" },
  function: { label: "Function", icon: "⚙", color: "bg-teal-50 text-teal-700" },
  subunit: { label: "Sub-unit", icon: "•", color: "bg-slate-100 text-slate-600" },
};

function TierChip({ tier }: { tier: TenantTier }) {
  return (
    <span
      className={`badge ${
        tier === "pro" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
      }`}
    >
      {tier}
    </span>
  );
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState<TenantWithConfig[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>("takeda");
  const [query, setQuery] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    tenantId: "",
    tenantName: "",
    tier: "basic" as TenantTier,
    parentId: "",
    type: "subunit" as Tenant["type"],
  });

  async function load() {
    const d = await getJSON<{ tenants: TenantWithConfig[] }>("/api/tenants");
    setTenants(d.tenants);
    setExpanded(
      new Set(
        d.tenants
          .filter((t) => t.type === "org" || t.parentId === "takeda")
          .map((t) => t.id)
      )
    );
  }
  useEffect(() => {
    load();
  }, []);

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, TenantWithConfig[]>();
    for (const t of tenants) {
      const k = t.parentId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return m;
  }, [tenants]);

  const byId = useMemo(() => {
    const m = new Map<string, TenantWithConfig>();
    tenants.forEach((t) => m.set(t.id, t));
    return m;
  }, [tenants]);

  const selected = byId.get(selectedId) ?? null;

  // Breadcrumb path from root to selected.
  const path = useMemo(() => {
    const out: TenantWithConfig[] = [];
    let cur = selected;
    while (cur) {
      out.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) ?? null : null;
    }
    return out;
  }, [selected, byId]);

  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function create() {
    setError(null);
    try {
      const created = await sendJSON<TenantWithConfig>("/api/tenants", "POST", {
        ...form,
        parentId: form.parentId || null,
      });
      setShow(false);
      setForm({ tenantId: "", tenantName: "", tier: "basic", parentId: "", type: "subunit" });
      await load();
      setSelectedId(created.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Filtered flat list when searching; else the tree.
  const matches = query
    ? tenants.filter((t) =>
        `${t.tenantName} ${t.tenantId}`.toLowerCase().includes(query.toLowerCase())
      )
    : [];

  function Row({ node, depth }: { node: TenantWithConfig; depth: number }) {
    const kids = childrenOf.get(node.id) ?? [];
    const open = expanded.has(node.id);
    const active = node.id === selectedId;
    return (
      <div>
        <div
          className={`group flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 ${
            active ? "bg-slate-100" : "hover:bg-slate-50"
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setSelectedId(node.id)}
        >
          {kids.length > 0 ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.id);
              }}
              className="w-4 shrink-0 text-slate-400 hover:text-slate-700"
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-4 shrink-0 text-center text-slate-300">·</span>
          )}
          <span className="shrink-0 text-xs">{TYPE_META[node.type].icon}</span>
          <span
            className={`flex-1 truncate text-sm ${
              active ? "font-semibold text-slate-900" : "text-slate-700"
            }`}
          >
            {node.tenantName}
          </span>
          <TierChip tier={node.tier} />
        </div>
        {open && kids.map((k) => <Row key={k.id} node={k} depth={depth + 1} />)}
      </div>
    );
  }

  const roots = childrenOf.get(null) ?? [];
  const selChildren = selected ? childrenOf.get(selected.id) ?? [] : [];

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle="Takeda organization — Business Units & Functions as governed tenant nodes."
        action={
          <button className="btn-primary" onClick={() => setShow(true)}>
            + Onboard Tenant
          </button>
        }
      />
      <div className="grid gap-6 px-8 pb-10 lg:grid-cols-[360px_1fr]">
        {/* LEFT: tree / search */}
        <div className="card flex h-fit flex-col p-3">
          <input
            className="input mb-2"
            placeholder="Search BU / function…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!query && (
            <div className="mb-2 flex items-center justify-between px-1 text-xs text-slate-400">
              <span>Organization tree</span>
              <span className="flex gap-2">
                <button
                  className="hover:text-slate-700"
                  onClick={() => setExpanded(new Set(tenants.map((t) => t.id)))}
                >
                  Expand
                </button>
                <button
                  className="hover:text-slate-700"
                  onClick={() => setExpanded(new Set())}
                >
                  Collapse
                </button>
              </span>
            </div>
          )}
          <div className="max-h-[70vh] overflow-y-auto">
            {query ? (
              matches.length === 0 ? (
                <p className="p-3 text-sm text-slate-400">No matches.</p>
              ) : (
                matches.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setSelectedId(m.id);
                      setQuery("");
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="text-xs">{TYPE_META[m.type].icon}</span>
                    <span className="flex-1 truncate">{m.tenantName}</span>
                    <TierChip tier={m.tier} />
                  </button>
                ))
              )
            ) : (
              roots.map((r) => <Row key={r.id} node={r} depth={0} />)
            )}
          </div>
        </div>

        {/* RIGHT: detail panel */}
        <div>
          {!selected ? (
            <EmptyState text="Select a node to see details." />
          ) : (
            <div className="space-y-5">
              {/* breadcrumb */}
              <div className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
                {path.map((p, i) => (
                  <span key={p.id} className="flex items-center gap-1">
                    {i > 0 && <span className="text-slate-300">/</span>}
                    <button
                      className={
                        p.id === selected.id
                          ? "font-semibold text-slate-900"
                          : "hover:text-slate-900"
                      }
                      onClick={() => setSelectedId(p.id)}
                    >
                      {p.tenantName}
                    </button>
                  </span>
                ))}
              </div>

              {/* header card */}
              <div className="card p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{TYPE_META[selected.type].icon}</span>
                      <h2 className="text-xl font-semibold">{selected.tenantName}</h2>
                    </div>
                    <div className="mono mt-1 text-xs text-slate-400">
                      {selected.tenantId}
                    </div>
                  </div>
                  <span className={`badge ${TYPE_META[selected.type].color}`}>
                    {TYPE_META[selected.type].label}
                  </span>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-5 md:grid-cols-4">
                  <Attr label="Tier" value={<TierChip tier={selected.tier} />} />
                  <Attr
                    label="Isolation"
                    value={
                      <span className="badge bg-blue-50 text-blue-700">
                        {selected.isolation === "silo" ? "Silo (dedicated)" : "Pool (shared)"}
                      </span>
                    }
                  />
                  <Attr label="Resource pool" value={<span className="mono text-xs">{selected.resourcePool}</span>} />
                  <Attr label="Sub-nodes" value={String(selChildren.length)} />
                </div>
              </div>

              {/* tier config */}
              <div className="card p-6">
                <h3 className="text-sm font-semibold">Tier limits &amp; features</h3>
                <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4">
                  <Attr label="Max agents" value={String(selected.config.maxAgents)} />
                  <Attr label="Tools / agent" value={String(selected.config.maxToolsPerAgent)} />
                  <Attr label="Knowledge bases" value={String(selected.config.maxKnowledgeBases)} />
                  <Attr
                    label="Token budget / mo"
                    value={
                      selected.config.monthlyTokenBudget
                        ? selected.config.monthlyTokenBudget.toLocaleString()
                        : "Unlimited"
                    }
                  />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {[
                    ["Analytics", selected.config.enableAnalytics],
                    ["Audit export", selected.config.enableAuditExport],
                    ["Custom policies", selected.config.enableCustomPolicies],
                    ["Dedicated gateway", selected.config.enableDedicatedGateway],
                  ].map(([label, on]) => (
                    <span
                      key={label as string}
                      className={`badge ${
                        on ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {on ? "✓" : "—"} {label}
                    </span>
                  ))}
                </div>
              </div>

              {/* children */}
              {selChildren.length > 0 && (
                <div className="card p-6">
                  <h3 className="text-sm font-semibold">
                    Sub-nodes ({selChildren.length})
                  </h3>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {selChildren.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setSelectedId(c.id)}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left hover:border-slate-300"
                      >
                        <span className="text-xs">{TYPE_META[c.type].icon}</span>
                        <span className="flex-1 truncate text-sm">{c.tenantName}</span>
                        <TierChip tier={c.tier} />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <button
                className="btn-ghost"
                onClick={() => {
                  setForm((f) => ({ ...f, parentId: selected.id, type: "subunit" }));
                  setShow(true);
                }}
              >
                + Add sub-unit under {selected.tenantName}
              </button>
            </div>
          )}
        </div>
      </div>

      {show && (
        <Modal
          title="Onboard Tenant"
          subtitle="Add a BU, function, or sub-unit. Tier sets feature limits and isolation (basic→pool, pro→silo)."
          onClose={() => setShow(false)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setShow(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!form.tenantId || !form.tenantName}
                onClick={create}
              >
                Onboard
              </button>
            </>
          }
        >
          <div className="space-y-4">
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Field label="Parent">
              <select
                className="input"
                value={form.parentId}
                onChange={(e) => setForm({ ...form, parentId: e.target.value })}
              >
                <option value="">(none — top-level)</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.tenantName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Type">
              <select
                className="input"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as Tenant["type"] })}
              >
                <option value="bu">Business Unit</option>
                <option value="function">Function</option>
                <option value="subunit">Sub-unit</option>
              </select>
            </Field>
            <Field label="Tenant ID" required hint="slug, e.g. bu-vaccines">
              <input
                className="input mono"
                value={form.tenantId}
                onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
                placeholder="bu-vaccines"
              />
            </Field>
            <Field label="Tenant Name" required>
              <input
                className="input"
                value={form.tenantName}
                onChange={(e) => setForm({ ...form, tenantName: e.target.value })}
                placeholder="Vaccines Business Unit"
              />
            </Field>
            <Field label="Tier">
              <select
                className="input"
                value={form.tier}
                onChange={(e) => setForm({ ...form, tier: e.target.value as TenantTier })}
              >
                <option value="basic">Basic (pooled / shared)</option>
                <option value="pro">Pro (siloed / dedicated)</option>
              </select>
            </Field>
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {form.tier === "pro"
                ? "Pro → silo isolation, unlimited tokens, analytics, audit export, custom policies, dedicated gateway, up to 20 KBs."
                : "Basic → pool isolation, 1M tokens, up to 3 agents, 1 KB, core features only."}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function Attr({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-400">{label}</div>
      <div className="mt-1 text-sm text-slate-800">{value}</div>
    </div>
  );
}
