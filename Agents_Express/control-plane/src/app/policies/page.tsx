"use client";

import { useEffect, useState } from "react";
import { PageHeader, Pill, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import {
  CognitoGroup,
  LibraryPolicy,
  LibraryPolicyStatus,
} from "@/lib/types";

type View =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; policyId: string }
  | { kind: "detail"; policyId: string };

export default function PolicyLibraryPage() {
  const [policies, setPolicies] = useState<LibraryPolicy[]>([]);
  const [groups, setGroups] = useState<CognitoGroup[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });

  async function load() {
    const d = await getJSON<{ policies: LibraryPolicy[]; groups: CognitoGroup[] }>(
      "/api/policy-library"
    );
    setPolicies(d.policies);
    setGroups(d.groups);
  }
  useEffect(() => {
    load();
  }, []);

  if (view.kind === "create") {
    return (
      <PolicyEditor
        title="Create Policy"
        groups={groups}
        onCancel={() => setView({ kind: "list" })}
        onSaved={async () => {
          await load();
          setView({ kind: "list" });
        }}
      />
    );
  }

  if (view.kind === "edit") {
    const p = policies.find((x) => x.id === view.policyId)!;
    return (
      <PolicyEditor
        title={`Edit: ${p.name}`}
        groups={groups}
        existing={p}
        onCancel={() => setView({ kind: "detail", policyId: p.id })}
        onSaved={async () => {
          await load();
          setView({ kind: "detail", policyId: p.id });
        }}
      />
    );
  }

  if (view.kind === "detail") {
    const p = policies.find((x) => x.id === view.policyId);
    if (!p) return null;
    return (
      <PolicyDetail
        policy={p}
        onBack={() => setView({ kind: "list" })}
        onEdit={() => setView({ kind: "edit", policyId: p.id })}
        onChanged={load}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Policy Library"
        subtitle="Author, version, and publish Cedar authorization policies."
        action={
          <button className="btn-primary" onClick={() => setView({ kind: "create" })}>
            + Create Policy
          </button>
        }
      />
      <div className="px-8 pb-10">
        {policies.length === 0 ? (
          <EmptyState text="No policies yet." />
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                  <th className="px-4 py-3">Policy name</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Version</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {policies.map((p) => (
                  <tr
                    key={p.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => setView({ kind: "detail", policyId: p.id })}
                  >
                    <td className="px-4 py-3 font-medium">{p.name}</td>
                    <td className="px-4 py-3">
                      <span className="badge bg-green-50 capitalize text-green-700">
                        {p.effect}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Pill status={p.status} />
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      v{p.versions.length}
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

/* ---------- NL2Cedar full-page editor ---------- */
function PolicyEditor({
  title,
  groups,
  existing,
  onCancel,
  onSaved,
}: {
  title: string;
  groups: CognitoGroup[];
  existing?: LibraryPolicy;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [nl, setNl] = useState("");
  const [cedar, setCedar] = useState(
    existing ? existing.versions[existing.versions.length - 1].cedar : ""
  );
  const [valid, setValid] = useState(false);
  const [showMeta, setShowMeta] = useState(!existing);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [message, setMessage] = useState("");

  // Very small NL→Cedar generator for the demo (resolves @-tags into Cedar).
  function generate() {
    const lower = nl.toLowerCase();
    const matchedGroups = groups
      .map((g) => g.name)
      .filter((g) => lower.includes(g));
    const tools = [
      "listMyExpenses",
      "submitExpense",
      "listTeamExpenses",
      "approveExpense",
      "rejectExpense",
    ].filter((t) => nl.includes(t));

    const actions = tools.length
      ? tools.length === 1
        ? `action == AgentCore::Action::"expense-tool___${tools[0]}"`
        : `action in [\n    ${tools
            .map((t) => `AgentCore::Action::"expense-tool___${t}"`)
            .join(",\n    ")}\n  ]`
      : `action`;

    const groupConds = matchedGroups.length
      ? matchedGroups.length === 1
        ? `principal.getTag("cognito:groups") like "*${matchedGroups[0]}*"`
        : `(\n    ${matchedGroups
            .map((g) => `principal.getTag("cognito:groups") like "*${g}*"`)
            .join(" ||\n    ")}\n  )`
      : `true`;

    const out = `permit(
  principal is AgentCore::OAuthUser,
  ${actions},
  resource == AgentCore::Gateway::"agent-platform-gateway"
)
when {
  principal.hasTag("cognito:groups") &&
  ${groupConds}
};`;
    setCedar(out);
    setValid(matchedGroups.length > 0 && tools.length > 0);
  }

  async function save() {
    if (existing) {
      await sendJSON("/api/policy-library", "PATCH", {
        id: existing.id,
        op: "version",
        nl,
        cedar,
        message: message || "Updated policy",
      });
    } else {
      await sendJSON("/api/policy-library", "POST", {
        name,
        description,
        nl,
        cedar,
        message: message || "Policy created as initial draft",
      });
    }
    onSaved();
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Editor header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-6 py-3">
        <div className="flex items-center gap-3">
          <button onClick={onCancel} className="text-slate-500 hover:text-slate-900">
            ←
          </button>
          <h1 className="text-base font-semibold">{title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {showMeta ? null : (
            <button className="btn-ghost" onClick={() => setShowMeta(true)}>
              Details
            </button>
          )}
          <button className="btn-ghost" onClick={onCancel}>
            ✕ Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!cedar || (!existing && !name)}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>

      {/* metadata (for create) */}
      {showMeta && (
        <div className="grid gap-4 border-b border-slate-200 bg-slate-50 px-6 py-4 md:grid-cols-3">
          <label className="block">
            <span className="label">Policy name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="expense_ic"
              disabled={!!existing}
            />
          </label>
          <label className="block md:col-span-2">
            <span className="label">Description</span>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Expense Policy for Individual Contributors in AnyCompany"
              disabled={!!existing}
            />
          </label>
        </div>
      )}

      {/* two-pane composer */}
      <div className="grid flex-1 grid-cols-2 overflow-hidden">
        {/* NL composer */}
        <div className="flex flex-col border-r border-slate-200">
          <textarea
            className="flex-1 resize-none p-6 text-sm outline-none"
            placeholder="Describe the policy behavior in natural language…  e.g. Allow seniority_ic to perform listMyExpenses at agent-platform-gateway"
            value={nl}
            onChange={(e) => setNl(e.target.value)}
          />
          <div className="flex items-center justify-between border-t border-slate-100 px-6 py-3">
            <span className="text-xs text-slate-400">
              Tip: mention a group ({groups.map((g) => g.name).join(", ")}) and
              tool names.
            </span>
            <button className="btn-primary" onClick={generate}>
              ✨ Generate
            </button>
          </div>
        </div>

        {/* Cedar pane */}
        <div className="flex flex-col bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Cedar Policy
              </span>
              {valid && (
                <span className="badge bg-green-50 text-green-700">✓ Valid</span>
              )}
            </div>
          </div>
          <textarea
            className="mono flex-1 resize-none bg-slate-900 p-6 text-xs text-slate-100 outline-none"
            value={cedar}
            onChange={(e) => setCedar(e.target.value)}
            placeholder="// Cedar policy appears here after Generate"
          />
          {existing && (
            <div className="border-t border-slate-100 px-6 py-3">
              <input
                className="input"
                placeholder="Version message (e.g. Added submit expense tool)"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Policy detail (Overview / Definition / Versions / Activity) ---------- */
function PolicyDetail({
  policy,
  onBack,
  onEdit,
  onChanged,
}: {
  policy: LibraryPolicy;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<
    "overview" | "definition" | "versions" | "activity"
  >("overview");
  const [statusMenu, setStatusMenu] = useState(false);
  const [cmpA, setCmpA] = useState(1);
  const [cmpB, setCmpB] = useState(policy.versions.length);

  const latest = policy.versions[policy.versions.length - 1];

  async function changeStatus(to: LibraryPolicyStatus) {
    setStatusMenu(false);
    await sendJSON("/api/policy-library", "PATCH", {
      id: policy.id,
      op: "status",
      status: to,
    });
    await onChanged();
  }

  const transitions: Record<LibraryPolicyStatus, LibraryPolicyStatus[]> = {
    Draft: ["In Review", "Published"],
    "In Review": ["Published", "Draft"],
    Published: ["Archived"],
    Archived: ["Draft"],
  };

  return (
    <>
      <div className="flex items-center justify-between border-b border-slate-200 px-8 py-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-slate-500 hover:text-slate-900">
            ←
          </button>
          <h1 className="text-lg font-semibold">{policy.name}</h1>
          <Pill status={policy.status} />
        </div>
        <button className="btn-ghost" onClick={onEdit}>
          ✎ Edit Policy
        </button>
      </div>

      <div className="flex gap-6 px-8 py-4 pb-10">
        <div className="card h-fit w-48 shrink-0 p-2">
          {([
            ["overview", "📖 Overview"],
            ["definition", "📄 Definition"],
            ["versions", "⑂ Versions"],
            ["activity", "🕘 Activity"],
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
                <h2 className="text-base font-semibold">Overview</h2>
                <div className="relative">
                  <button
                    className="btn-ghost"
                    onClick={() => setStatusMenu((o) => !o)}
                    disabled={transitions[policy.status].length === 0}
                  >
                    Change status ▾
                  </button>
                  {statusMenu && (
                    <div className="absolute right-0 z-10 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                      {transitions[policy.status].map((s) => (
                        <button
                          key={s}
                          onClick={() => changeStatus(s)}
                          className="block w-full px-4 py-2 text-left text-sm hover:bg-slate-50"
                        >
                          {s === "In Review"
                            ? "Submit for Review"
                            : s === "Published"
                            ? "Publish"
                            : s === "Archived"
                            ? "Archive"
                            : s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-5 grid grid-cols-1 gap-y-5 md:grid-cols-3">
                <D k="Name" v={policy.name} />
                <D k="Status" v={<Pill status={policy.status} />} />
                <D
                  k="Type"
                  v={
                    <span className="badge bg-green-50 capitalize text-green-700">
                      {policy.effect}
                    </span>
                  }
                />
                <D k="Creator" v={policy.creator} />
                <D k="Created" v={fmt(policy.createdAt)} />
                <D k="Last Updated" v={fmt(policy.updatedAt)} />
                <D
                  k="Current Version"
                  v={`v${policy.versions.length} (${policy.versions.length} version${
                    policy.versions.length === 1 ? "" : "s"
                  })`}
                />
                <D k="Linked Policies" v="0 linked" />
              </div>
            </div>
          )}

          {tab === "definition" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">Definition (v{latest.version})</h2>
              <p className="mt-1 text-sm text-slate-500">{latest.nl}</p>
              <pre className="mono mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                {latest.cedar}
              </pre>
            </div>
          )}

          {tab === "versions" && (
            <div className="space-y-6">
              <div className="card p-6">
                <h2 className="text-base font-semibold">Compare Versions</h2>
                <div className="mt-3 flex items-center gap-3">
                  <select
                    className="input w-32"
                    value={cmpA}
                    onChange={(e) => setCmpA(Number(e.target.value))}
                  >
                    {policy.versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                      </option>
                    ))}
                  </select>
                  <span className="text-slate-400">vs</span>
                  <select
                    className="input w-32"
                    value={cmpB}
                    onChange={(e) => setCmpB(Number(e.target.value))}
                  >
                    {policy.versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <pre className="mono overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                    {policy.versions.find((v) => v.version === cmpA)?.cedar}
                  </pre>
                  <pre className="mono overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                    {policy.versions.find((v) => v.version === cmpB)?.cedar}
                  </pre>
                </div>
              </div>
              <div className="card p-6">
                <h2 className="text-base font-semibold">Version History</h2>
                <div className="mt-3 space-y-2">
                  {[...policy.versions].reverse().map((v) => (
                    <div
                      key={v.version}
                      className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                    >
                      <div>
                        <span className="font-medium">v{v.version}</span>{" "}
                        <span className="text-sm text-slate-500">{v.message}</span>
                        <div className="text-xs text-slate-400">
                          {v.author} · {fmt(v.at)}
                        </div>
                      </div>
                      {v.version !== latest.version && (
                        <button className="btn-ghost text-xs">Revert</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === "activity" && (
            <div className="card p-6">
              <h2 className="text-base font-semibold">
                Activity ({policy.activity.length})
              </h2>
              <div className="mt-4 space-y-4">
                {policy.activity.map((a, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                        a.kind === "created"
                          ? "bg-green-100 text-green-700"
                          : "bg-purple-100 text-purple-700"
                      }`}
                    >
                      {a.kind === "created" ? "+" : "⑂"}
                    </span>
                    <div>
                      <div className="text-sm text-slate-800">
                        {a.version ? `Version ${a.version} — ` : ""}
                        {a.message}
                      </div>
                      <div className="text-xs text-slate-400">
                        {a.author} · {fmt(a.at)}
                      </div>
                    </div>
                  </div>
                ))}
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
