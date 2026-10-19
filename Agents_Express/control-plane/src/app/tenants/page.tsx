"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, Modal, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { Tenant, TenantTier, TierConfig } from "@/lib/types";

type TenantWithConfig = Tenant & { config: TierConfig };

const TYPE_LABEL: Record<Tenant["type"], string> = {
  org: "Org",
  bu: "Business Unit",
  function: "Function",
  subunit: "Sub-unit",
};
const TYPE_COLOR: Record<Tenant["type"], string> = {
  org: "bg-slate-900 text-white",
  bu: "bg-indigo-50 text-indigo-700",
  function: "bg-teal-50 text-teal-700",
  subunit: "bg-slate-100 text-slate-600",
};

export default function TenantsPage() {
  const [tenants, setTenants] = useState<TenantWithConfig[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
    // expand root + BUs/functions by default
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
      const key = t.parentId;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return m;
  }, [tenants]);

  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function create() {
    setError(null);
    try {
      await sendJSON("/api/tenants", "POST", {
        ...form,
        parentId: form.parentId || null,
      });
      setShow(false);
      setForm({
        tenantId: "",
        tenantName: "",
        tier: "basic",
        parentId: "",
        type: "subunit",
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function renderNode(node: TenantWithConfig, depth: number): React.ReactNode {
    const kids = childrenOf.get(node.id) ?? [];
    const isOpen = expanded.has(node.id);
    return (
      <div key={node.id}>
        <div
          className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50"
          style={{ paddingLeft: `${depth * 20 + 12}px` }}
        >
          {kids.length > 0 ? (
            <button
              onClick={() => toggle(node.id)}
              className="w-4 text-slate-400 hover:text-slate-700"
            >
              {isOpen ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-4 text-slate-300">•</span>
          )}
          <span className="flex-1 text-sm font-medium text-slate-800">
            {node.tenantName}
          </span>
          <span className={`badge ${TYPE_COLOR[node.type]}`}>
            {TYPE_LABEL[node.type]}
          </span>
          <span
            className={`badge ${
              node.tier === "pro"
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {node.tier}
          </span>
          <span className="badge bg-blue-50 text-blue-700">
            {node.isolation === "silo" ? "silo" : "pool"}
          </span>
          <span className="mono hidden w-48 truncate text-xs text-slate-400 md:inline">
            {node.resourcePool}
          </span>
        </div>
        {isOpen && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  }

  const roots = childrenOf.get(null) ?? [];
  const counts = {
    total: tenants.length,
    bu: tenants.filter((t) => t.type === "bu").length,
    fn: tenants.filter((t) => t.type === "function").length,
    pro: tenants.filter((t) => t.tier === "pro").length,
  };

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle="Takeda organizational hierarchy — Business Units & Functions as tenant nodes, each with its own tier and pool/silo isolation."
        action={
          <button className="btn-primary" onClick={() => setShow(true)}>
            + Onboard Tenant
          </button>
        }
      />
      <div className="px-8 pb-10">
        {/* summary stats */}
        <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            ["Total nodes", counts.total],
            ["Business Units", counts.bu],
            ["Functions", counts.fn],
            ["Pro / siloed", counts.pro],
          ].map(([label, val]) => (
            <div key={label} className="card p-4">
              <div className="text-xs font-medium text-slate-400">{label}</div>
              <div className="mt-1 text-2xl font-semibold">{val}</div>
            </div>
          ))}
        </div>

        {tenants.length === 0 ? (
          <EmptyState text="No tenants yet." />
        ) : (
          <div className="card p-3">
            <div className="flex items-center justify-between px-3 py-2">
              <h2 className="text-sm font-semibold text-slate-600">
                Organization tree
              </h2>
              <div className="flex gap-2 text-xs">
                <button
                  className="text-slate-500 hover:text-slate-900"
                  onClick={() => setExpanded(new Set(tenants.map((t) => t.id)))}
                >
                  Expand all
                </button>
                <span className="text-slate-300">·</span>
                <button
                  className="text-slate-500 hover:text-slate-900"
                  onClick={() => setExpanded(new Set())}
                >
                  Collapse all
                </button>
              </div>
            </div>
            {roots.map((r) => renderNode(r, 0))}
          </div>
        )}
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
                    {"— ".repeat(0)}
                    {t.tenantName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Type">
              <select
                className="input"
                value={form.type}
                onChange={(e) =>
                  setForm({ ...form, type: e.target.value as Tenant["type"] })
                }
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
                onChange={(e) =>
                  setForm({ ...form, tier: e.target.value as TenantTier })
                }
              >
                <option value="basic">Basic (pooled / shared)</option>
                <option value="pro">Pro (siloed / dedicated)</option>
              </select>
            </Field>
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {form.tier === "pro"
                ? "Pro → silo isolation, unlimited token budget, analytics, audit export, custom policies, dedicated gateway."
                : "Basic → pool isolation, 1M token budget, up to 3 agents, core features only."}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
