"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Field, Modal, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import type { CapacityLine, PerAgentLimit, TenantUsage } from "@/lib/tenancy";
import { Tenant, TenantTier, TierConfig } from "@/lib/types";

/**
 * The `basic` / `pro` chip is gone from this page.
 *
 * It was on every tree row, in search results, in the detail panel and on
 * every sub-node card — four places telling an operator which SKU a BU is on,
 * which is not a question anyone asks while looking at an org tree. What they
 * ask is: does this BU own anything, is it near a limit, and where do I go to
 * see it. So the chip is replaced by live usage, a capacity bar, and links out
 * to the tenant's own agents and workflows.
 *
 * The TIER ITSELF is untouched — it still sets the limits the API enforces.
 * Only the presentation changed: a plan NAME where a plan name is useful (the
 * onboarding form, where you are choosing one), and nowhere else.
 */
type TenantRich = Tenant & {
  config: TierConfig;
  plan: string;
  usage: TenantUsage;
  capacity: { plan: string; lines: CapacityLine[]; anyFull: boolean; anyTight: boolean };
  perAgentLimits: PerAgentLimit[];
};

const TYPE_META: Record<Tenant["type"], { label: string; icon: string; color: string }> = {
  org: { label: "Org", icon: "🏛", color: "bg-slate-900 text-white" },
  bu: { label: "Business Unit", icon: "🏢", color: "bg-indigo-50 text-indigo-700" },
  function: { label: "Function", icon: "⚙", color: "bg-teal-50 text-teal-700" },
  subunit: { label: "Sub-unit", icon: "•", color: "bg-slate-100 text-slate-600" },
};

/** Plan copy for the onboarding form, derived from the real limits. */
const PLAN_CHOICES: { tier: TenantTier; name: string; blurb: (c: TierConfig) => string }[] = [
  {
    tier: "basic",
    name: "Standard",
    blurb: (c) =>
      `${c.maxAgents} agents · ${c.maxToolsPerAgent} tools/agent · ` +
      `${c.maxKnowledgeBases} KB/agent · ${c.monthlyTokenBudget?.toLocaleString()} tokens/mo · shared pool`,
  },
  {
    tier: "pro",
    name: "Expanded",
    blurb: (c) =>
      `${c.maxAgents} agents · ${c.maxToolsPerAgent} tools/agent · ` +
      `${c.maxKnowledgeBases} KB/agent · unlimited tokens · dedicated pool, analytics, audit export`,
  },
];

const BAR_COLOR: Record<CapacityLine["state"], string> = {
  ok: "bg-emerald-500",
  tight: "bg-amber-500",
  full: "bg-rose-500",
};

function CapacityBar({ line }: { line: CapacityLine }) {
  const pct =
    line.limit === null ? 0 : Math.min(100, Math.round((line.ratio ?? 0) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-slate-500">{line.label}</span>
        <span className="mono text-xs text-slate-700">
          {line.used}
          <span className="text-slate-400">
            {line.limit === null ? " / ∞" : ` / ${line.limit}`}
          </span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full transition-all ${BAR_COLOR[line.state]}`}
          style={{ width: `${line.limit === null ? 4 : Math.max(pct, line.used > 0 ? 4 : 0)}%` }}
        />
      </div>
    </div>
  );
}

/** A compact activity read-out for a tree row: one dot per populated kind. */
function RowActivity({ usage }: { usage: TenantUsage }) {
  const bits: string[] = [];
  if (usage.agents) bits.push(`${usage.agents}a`);
  if (usage.workflows) bits.push(`${usage.workflows}w`);
  if (!bits.length) return <span className="w-10 shrink-0" />;
  return (
    <span className="mono w-10 shrink-0 text-right text-[10px] text-slate-400">
      {bits.join(" ")}
    </span>
  );
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState<TenantRich[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>("takeda");
  const [query, setQuery] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyActive, setOnlyActive] = useState(false);
  const [form, setForm] = useState({
    tenantId: "",
    tenantName: "",
    tier: "basic" as TenantTier,
    parentId: "",
    type: "subunit" as Tenant["type"],
  });

  async function load() {
    const d = await getJSON<{ tenants: TenantRich[] }>("/api/tenants");
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
    const m = new Map<string | null, TenantRich[]>();
    for (const t of tenants) {
      const k = t.parentId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return m;
  }, [tenants]);

  const byId = useMemo(() => {
    const m = new Map<string, TenantRich>();
    tenants.forEach((t) => m.set(t.id, t));
    return m;
  }, [tenants]);

  const selected = byId.get(selectedId) ?? null;

  /** Roll-up across the selected subtree — what a BU lead actually owns. */
  const subtree = useMemo(() => {
    if (!selected) return null;
    const ids = new Set<string>([selected.id]);
    const queue = [selected.id];
    while (queue.length) {
      for (const c of childrenOf.get(queue.shift()!) ?? []) {
        if (!ids.has(c.id)) {
          ids.add(c.id);
          queue.push(c.id);
        }
      }
    }
    const nodes = [...ids].map((id) => byId.get(id)).filter(Boolean) as TenantRich[];
    return {
      nodes: nodes.length,
      agents: nodes.reduce((n, t) => n + t.usage.agents, 0),
      workflows: nodes.reduce((n, t) => n + t.usage.workflows, 0),
      atCapacity: nodes.filter((t) => t.capacity.anyFull).length,
    };
  }, [selected, childrenOf, byId]);

  const path = useMemo(() => {
    const out: TenantRich[] = [];
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
      const created = await sendJSON<TenantRich>("/api/tenants", "POST", {
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

  const matches = query
    ? tenants.filter((t) =>
        `${t.tenantName} ${t.tenantId}`.toLowerCase().includes(query.toLowerCase())
      )
    : [];

  /** Does this node, or anything beneath it, own an agent or a workflow? */
  const hasActivity = useMemo(() => {
    const memo = new Map<string, boolean>();
    const walk = (id: string): boolean => {
      if (memo.has(id)) return memo.get(id)!;
      memo.set(id, false); // guards a cycle in parentId data
      const t = byId.get(id);
      const own = !!t && (t.usage.agents > 0 || t.usage.workflows > 0);
      const kids = (childrenOf.get(id) ?? []).some((c) => walk(c.id));
      const result = own || kids;
      memo.set(id, result);
      return result;
    };
    tenants.forEach((t) => walk(t.id));
    return memo;
  }, [tenants, byId, childrenOf]);

  function Row({ node, depth }: { node: TenantRich; depth: number }) {
    const kids = childrenOf.get(node.id) ?? [];
    const open = expanded.has(node.id);
    const active = node.id === selectedId;
    if (onlyActive && !hasActivity.get(node.id)) return null;
    return (
      <div>
        <div
          className={`group flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 ${
            active ? "bg-slate-900/5 ring-1 ring-slate-900/10" : "hover:bg-slate-50"
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
              aria-label={open ? "Collapse" : "Expand"}
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
          {node.capacity.anyFull && (
            <span
              className="shrink-0 text-[10px] text-rose-600"
              title="At its agent limit"
            >
              ●
            </span>
          )}
          <RowActivity usage={node.usage} />
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
              <button
                className={`rounded px-1.5 py-0.5 ${
                  onlyActive ? "bg-slate-900 text-white" : "hover:text-slate-700"
                }`}
                onClick={() => setOnlyActive((v) => !v)}
                title="Show only nodes that own an agent or workflow, or contain one"
              >
                {onlyActive ? "Active only" : "All nodes"}
              </button>
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
                    <RowActivity usage={m.usage} />
                  </button>
                ))
              )
            ) : (
              roots.map((r) => <Row key={r.id} node={r} depth={0} />)
            )}
          </div>
          <p className="mt-2 border-t border-slate-100 px-1 pt-2 text-[10px] leading-relaxed text-slate-400">
            <span className="mono">a</span> agents · <span className="mono">w</span>{" "}
            workflows · <span className="text-rose-600">●</span> at agent limit
          </p>
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

                {/* live counts — what this node owns, and where to go next */}
                <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <StatTile
                    label="Agents"
                    value={selected.usage.agents}
                    note={
                      selected.usage.agents > 0
                        ? `${selected.usage.agentsReady} ready`
                        : undefined
                    }
                    href={`/agents?tenant=${encodeURIComponent(selected.id)}`}
                  />
                  <StatTile
                    label="Workflows"
                    value={selected.usage.workflows}
                    href={`/workflows?tenant=${encodeURIComponent(selected.id)}`}
                  />
                  <StatTile
                    label="Attached tools"
                    value={selected.usage.toolsAttached}
                    note={
                      selected.usage.knowledgeBasesAttached > 0
                        ? `${selected.usage.knowledgeBasesAttached} KB`
                        : undefined
                    }
                    href="/registry"
                  />
                  <StatTile
                    label="Sub-units"
                    value={selected.usage.subUnits}
                    note={
                      selected.usage.descendants > selected.usage.subUnits
                        ? `${selected.usage.descendants} in subtree`
                        : undefined
                    }
                  />
                </div>
              </div>

              {/* capacity */}
              <div className="card p-6">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">Capacity</h3>
                  <span className="text-xs text-slate-400">
                    {selected.plan} plan ·{" "}
                    {selected.isolation === "silo"
                      ? "dedicated pool"
                      : "shared pool"}{" "}
                    · <span className="mono">{selected.resourcePool}</span>
                  </span>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {selected.capacity.lines.map((l) => (
                    <CapacityBar key={l.key} line={l} />
                  ))}
                  <div>
                    <div className="text-xs font-medium text-slate-500">
                      Monthly token budget
                    </div>
                    <div className="mono mt-1 text-sm text-slate-800">
                      {selected.config.monthlyTokenBudget
                        ? selected.config.monthlyTokenBudget.toLocaleString()
                        : "Unlimited"}
                    </div>
                  </div>
                </div>

                {/* Per-AGENT ceilings, kept visually separate from the bars
                    above because they are not tenant-wide totals. */}
                <div className="mt-5 border-t border-slate-100 pt-4">
                  <div className="text-xs font-medium text-slate-500">
                    Per-agent ceilings
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selected.perAgentLimits.map((l) => (
                      <span
                        key={l.key}
                        className={`badge ${
                          l.atCeiling
                            ? "bg-amber-50 text-amber-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                        title={
                          selected.usage.agents === 0
                            ? "No agents yet"
                            : `Highest on any one agent: ${l.peak}`
                        }
                      >
                        {l.label}: {l.limit}
                        {selected.usage.agents > 0 && (
                          <span className="ml-1 text-slate-400">
                            (peak {l.peak})
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>

                {selected.capacity.anyFull && (
                  <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    At the agent limit for this plan — creating another agent
                    here will be refused.
                  </p>
                )}

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

              {/* subtree roll-up */}
              {subtree && subtree.nodes > 1 && (
                <div className="card p-6">
                  <h3 className="text-sm font-semibold">
                    Subtree roll-up
                    <span className="ml-2 font-normal text-slate-400">
                      {subtree.nodes} node(s) including this one
                    </span>
                  </h3>
                  <div className="mt-3 grid grid-cols-3 gap-4">
                    <Attr label="Agents" value={String(subtree.agents)} />
                    <Attr label="Workflows" value={String(subtree.workflows)} />
                    <Attr
                      label="At agent limit"
                      value={
                        subtree.atCapacity > 0 ? (
                          <span className="text-rose-600">{subtree.atCapacity}</span>
                        ) : (
                          "0"
                        )
                      }
                    />
                  </div>
                </div>
              )}

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
                        className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left hover:border-slate-400 hover:bg-slate-50"
                      >
                        <span className="text-xs">{TYPE_META[c.type].icon}</span>
                        <span className="flex-1 truncate text-sm">{c.tenantName}</span>
                        {c.capacity.anyFull && (
                          <span className="text-[10px] text-rose-600">●</span>
                        )}
                        <RowActivity usage={c.usage} />
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
          subtitle="Add a BU, function, or sub-unit. The plan sets capacity limits and isolation."
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
            {/* A plan is CHOSEN here, so here it has a name and its limits are
                spelled out. Picking from two opaque words was the part of the
                old form that actually needed the label. */}
            <Field label="Plan">
              <div className="space-y-2">
                {PLAN_CHOICES.map((p) => {
                  const cfg = tenants.find((t) => t.tier === p.tier)?.config;
                  const chosen = form.tier === p.tier;
                  return (
                    <button
                      key={p.tier}
                      type="button"
                      onClick={() => setForm({ ...form, tier: p.tier })}
                      className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                        chosen
                          ? "border-slate-900 bg-slate-900/[0.03] ring-1 ring-slate-900/10"
                          : "border-slate-200 hover:border-slate-400"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-3 w-3 shrink-0 rounded-full border ${
                            chosen ? "border-slate-900 bg-slate-900" : "border-slate-300"
                          }`}
                        />
                        <span className="text-sm font-medium">{p.name}</span>
                      </div>
                      {cfg && (
                        <div className="mt-1 pl-5 text-xs leading-relaxed text-slate-500">
                          {p.blurb(cfg)}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

function StatTile({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: number;
  note?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="text-xs font-medium text-slate-400">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-slate-900">
          {value}
        </span>
        {note && <span className="text-xs text-slate-400">{note}</span>}
      </div>
    </>
  );
  // Only linked when there is something to look at: a tile reading 0 that
  // navigates to an empty list is a dead end dressed up as an action.
  if (!href || value === 0) {
    return <div className="rounded-xl bg-slate-50 px-4 py-3">{body}</div>;
  }
  return (
    <Link
      href={href}
      className="group rounded-xl bg-slate-50 px-4 py-3 transition hover:bg-slate-100"
    >
      {body}
      <span className="mt-1 block text-[10px] text-slate-400 group-hover:text-slate-600">
        View →
      </span>
    </Link>
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
