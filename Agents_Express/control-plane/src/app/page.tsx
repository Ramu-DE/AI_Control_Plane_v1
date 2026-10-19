import Link from "next/link";
import { store } from "@/lib/store";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

function Stat({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: number | string;
  href: string;
  hint: string;
}) {
  return (
    <Link href={href} className="card p-5 transition hover:shadow-md">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-3xl font-semibold">{value}</div>
      <div className="mt-1 text-sm text-slate-500">{hint}</div>
    </Link>
  );
}

export default function DashboardPage() {
  const activePolicies = store.policies.filter((p) => p.enabled).length;
  const gatewayPolicies = store.policies.filter((p) => p.layer === "gateway").length;
  const avpPolicies = store.policies.filter((p) => p.layer === "avp").length;

  // Governance signals (surfaced for the Platform Admin persona).
  const pendingApprovals =
    store.records.filter(
      (r) => r.status === "Draft" || r.status === "Pending approval"
    ).length +
    store.libraryPolicies.filter(
      (p) => p.status === "Draft" || p.status === "In Review"
    ).length;
  const unsyncedPolicies = store.policyEngines.reduce(
    (n, e) => n + e.importedPolicies.filter((p) => !p.synced).length,
    0
  );
  const tenantCount = store.tenants.length;
  const proTenants = store.tenants.filter((t) => t.tier === "pro").length;

  const signals: {
    label: string;
    value: number;
    href: string;
    tone: "warn" | "ok";
  }[] = [
    { label: "Pending approvals", value: pendingApprovals, href: "/approvals", tone: pendingApprovals > 0 ? "warn" : "ok" },
    { label: "Unsynced policies", value: unsyncedPolicies, href: "/policy-engines", tone: unsyncedPolicies > 0 ? "warn" : "ok" },
    { label: "Tenants (BUs)", value: tenantCount, href: "/tenants", tone: "ok" },
    { label: "Pro / siloed tenants", value: proTenants, href: "/tenants", tone: "ok" },
  ];

  return (
    <>
      <PageHeader
        title="Control Plane Overview"
        subtitle="Build and govern AI agents as digital employees — registry, agents, policies, model governance, and audit in one place."
      />
      <div className="p-8">
        {/* Governance signals */}
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {signals.map((s) => (
            <Link
              key={s.label}
              href={s.href}
              className={`card p-4 transition hover:shadow-md ${
                s.tone === "warn" && s.value > 0 ? "border-amber-300 bg-amber-50" : ""
              }`}
            >
              <div className="text-xs font-medium text-slate-500">{s.label}</div>
              <div
                className={`mt-1 text-2xl font-semibold ${
                  s.tone === "warn" && s.value > 0 ? "text-amber-700" : ""
                }`}
              >
                {s.value}
              </div>
            </Link>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label="Registry Records"
            value={store.records.length}
            href="/registry"
            hint={`${store.registries.length} registry · MCP & Custom (Part 1)`}
          />
          <Stat
            label="Agents"
            value={store.agents.length}
            href="/agents"
            hint="Declarative agents (Part 2)"
          />
          <Stat
            label="Active Policies"
            value={activePolicies}
            href="/policies"
            hint={`${gatewayPolicies} gateway · ${avpPolicies} AVP (Part 3)`}
          />
          <Stat
            label="Catalog Models"
            value={store.models.length}
            href="/settings"
            hint="Available models (Settings → Models)"
          />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="card p-6">
            <h2 className="text-sm font-semibold">How the pieces fit</h2>
            <ol className="mt-3 space-y-2 text-sm text-slate-600">
              <li>
                <b>1. Registry</b> — catalog MCP servers &amp; Lambda tools so teams
                discover and reuse them.
              </li>
              <li>
                <b>2. Agents</b> — declarative config (model, prompt, tools,
                compute); runtime builds the agent at invocation.
              </li>
              <li>
                <b>3. Policies</b> — Cedar, two layers: AgentCore Policy at the
                gateway + Verified Permissions inside the tool.
              </li>
              <li>
                <b>4. Playground</b> — simulate personas to see allow/deny across
                both layers.
              </li>
              <li>
                <b>5. Model Governance</b> — LLM gateway routes, providers, and
                rate limits (what an agent may spend).
              </li>
            </ol>
          </div>

          <div className="card p-6">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <ul className="mt-3 space-y-3">
              {store.audit.slice(0, 6).map((e) => (
                <li key={e.id} className="flex items-start gap-3 text-sm">
                  <span className="badge bg-slate-100 text-slate-600">
                    {e.category}
                  </span>
                  <div>
                    <div className="text-slate-700">{e.detail}</div>
                    <div className="text-xs text-slate-400">
                      {e.actor} · {new Date(e.at).toLocaleString()}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Link
              href="/audit"
              className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline"
            >
              View full audit trail →
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
