"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { PageHeader, Pill, Field, Modal, EmptyState, RadioCard } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import type { RecordStatus } from "@/lib/types";
import type { A2AAgentCard, A2AExchange, A2APeer } from "@/lib/a2a/types";

type PeerView = A2APeer & { callable: boolean; peerScopedPolicy: boolean };

interface A2AData {
  peers: PeerView[];
  personas: { id: string; name: string; email: string; groups: string[] }[];
  tenants: { id: string; tenantName: string }[];
  policy: { action: string; perimeterTool: string; peerScopedToolExample: string };
}

const EMPTY: A2AData = {
  peers: [],
  personas: [],
  tenants: [],
  policy: { action: "callAgent", perimeterTool: "a2a", peerScopedToolExample: "a2a:<peerId>" },
};

export default function A2APage() {
  const [data, setData] = useState<A2AData>(EMPTY);
  const [selectedId, setSelectedId] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [text, setText] = useState(
    "Summarize current demand priority for Product P into Region-West, SLA 72h."
  );
  const [skillId, setSkillId] = useState("");
  const [preview, setPreview] = useState(true);
  const [exchange, setExchange] = useState<A2AExchange | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showRegister, setShowRegister] = useState(false);

  async function load() {
    const next = await getJSON<A2AData>("/api/a2a");
    setData(next);
    setSelectedId((cur) => cur || next.peers[0]?.peerId || "");
    setPersonaId((cur) => cur || next.personas[0]?.id || "");
  }

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, []);

  const selected = useMemo(
    () => data.peers.find((p) => p.peerId === selectedId),
    [data.peers, selectedId]
  );

  // Only an Approved peer can be called at all; preview still needs approval
  // because the policy decision is part of what the preview demonstrates.
  const sendable = Boolean(selected && selected.status === "Approved");

  async function send(event: FormEvent) {
    event.preventDefault();
    setError("");
    setExchange(null);
    setBusy(true);
    try {
      const result = await sendJSON<A2AExchange>("/api/a2a", "POST", {
        op: "send",
        peerId: selectedId,
        personaId,
        text,
        skillId: skillId || undefined,
        preview,
      });
      setExchange(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discover(peerId: string) {
    setError("");
    setBusy(true);
    try {
      await sendJSON("/api/a2a", "POST", { op: "discover", peerId });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(peer: PeerView, status: RecordStatus) {
    setError("");
    setBusy(true);
    try {
      await sendJSON("/api/a2a", "PATCH", { peerId: peer.peerId, status });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const nextStatuses: Record<RecordStatus, RecordStatus[]> = {
    Draft: ["Pending approval"],
    "Pending approval": ["Approved", "Rejected"],
    Approved: ["Deprecated"],
    Rejected: ["Draft"],
    Deprecated: [],
  };

  return (
    <>
      <PageHeader
        title="A2A Peers"
        subtitle="Register peer agents, discover their Agent Cards, and send governed agent-to-agent messages under Cedar policy."
        action={
          <button type="button" className="btn-primary" onClick={() => setShowRegister(true)}>
            Register peer
          </button>
        }
      />

      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {data.peers.length === 0 ? (
          <EmptyState text="No A2A peers registered yet." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
            {/* ---- peer list ---- */}
            <div className="space-y-3">
              {data.peers.map((p) => (
                <button
                  key={p.peerId}
                  type="button"
                  onClick={() => {
                    setSelectedId(p.peerId);
                    setExchange(null);
                  }}
                  className={`card w-full p-4 text-left transition ${
                    p.peerId === selectedId
                      ? "border-brand-500 ring-1 ring-brand-500"
                      : "hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-slate-900">{p.displayName}</span>
                    <Pill status={p.status} />
                  </div>
                  <div className="mono mt-1 text-xs text-slate-400">{p.peerId}</div>
                  <p className="mt-1 text-xs text-slate-500">{p.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span
                      className={`badge ${
                        p.callable
                          ? "bg-green-50 text-green-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {p.callable ? "endpoint configured" : "preview only"}
                    </span>
                    {p.card && (
                      <span className="badge bg-slate-100 text-slate-600">
                        {p.card.skills.length} skill(s)
                      </span>
                    )}
                    {p.peerScopedPolicy && (
                      <span className="badge bg-blue-50 text-blue-700">peer policy</span>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {/* ---- selected peer ---- */}
            <div className="space-y-4">
              {selected && (
                <>
                  <section className="card p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-base font-semibold">{selected.displayName}</h2>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy}
                          onClick={() => discover(selected.peerId)}
                        >
                          {selected.card ? "Re-discover card" : "Discover card"}
                        </button>
                        {nextStatuses[selected.status].map((s) => (
                          <button
                            key={s}
                            type="button"
                            className="btn-ghost"
                            disabled={busy}
                            onClick={() => changeStatus(selected, s)}
                          >
                            {s === "Approved" ? "Approve" : s}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-4 grid grid-cols-1 gap-y-4 sm:grid-cols-2">
                      <Detail label="Peer id" value={selected.peerId} mono />
                      <Detail label="Tenant" value={selected.tenantId} />
                      <Detail label="Endpoint" value={selected.endpoint} mono />
                      <Detail
                        label="Allowed hosts"
                        value={selected.allowedHosts.join(", ") || "— (none pinned)"}
                        mono
                      />
                      <Detail label="Auth" value={selected.auth.kind} />
                      <Detail
                        label="Auth reference"
                        value={selected.auth.authEnvVar || selected.auth.roleArn || "—"}
                        mono
                      />
                    </div>
                    {!selected.callable && (
                      <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-800">
                        This peer&apos;s endpoint is a placeholder or is not in its allowlist, so
                        live sends are refused. Routing preview still works and shows the exact
                        JSON-RPC envelope plus the policy decision.
                      </p>
                    )}
                  </section>

                  {selected.card && <CardPanel card={selected.card} />}

                  {/* ---- send ---- */}
                  <section className="card p-5">
                    <h2 className="text-base font-semibold">Send an A2A message</h2>
                    <p className="mt-0.5 text-sm text-slate-500">
                      The call is evaluated against{" "}
                      <span className="mono">{data.policy.action}</span> at two granularities:
                      the perimeter (<span className="mono">{data.policy.perimeterTool}</span>) and,
                      when a policy names it, the peer itself (
                      <span className="mono">a2a:{selected.peerId}</span>).
                    </p>
                    <form className="mt-4 space-y-3" onSubmit={send}>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Caller persona">
                          <select
                            className="input"
                            value={personaId}
                            onChange={(e) => setPersonaId(e.target.value)}
                          >
                            {data.personas.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} ({p.groups.join(", ")})
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field
                          label="Skill (optional)"
                          hint={
                            selected.card
                              ? "From the discovered Agent Card."
                              : "Discover the Agent Card to list skills."
                          }
                        >
                          <select
                            className="input"
                            value={skillId}
                            onChange={(e) => setSkillId(e.target.value)}
                          >
                            <option value="">(none)</option>
                            {(selected.card?.skills ?? []).map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <Field label="Message">
                        <textarea
                          className="input h-24"
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                        />
                      </Field>
                      <div className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-sm text-slate-600">
                          <input
                            type="checkbox"
                            checked={preview}
                            onChange={(e) => setPreview(e.target.checked)}
                          />
                          Routing preview (no egress)
                        </label>
                        <button className="btn-primary" disabled={busy || !sendable}>
                          {busy ? "Working…" : preview ? "Preview call" : "Send"}
                        </button>
                        {!sendable && (
                          <span className="text-xs text-amber-700">
                            Peer must be Approved before it can be called.
                          </span>
                        )}
                      </div>
                    </form>
                  </section>

                  {exchange && <ExchangePanel exchange={exchange} />}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {showRegister && (
        <RegisterPeerModal
          tenants={data.tenants}
          onClose={() => setShowRegister(false)}
          onCreated={async () => {
            setShowRegister(false);
            await load();
          }}
        />
      )}
    </>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-400">{label}</div>
      <div className={`mt-1 break-all text-sm text-slate-800 ${mono ? "mono" : ""}`}>{value}</div>
    </div>
  );
}

function CardPanel({ card }: { card: A2AAgentCard }) {
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Agent Card</h2>
        <span className="badge bg-slate-100 text-slate-600">v{card.version}</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">{card.description}</p>
      <div className="mt-3 grid grid-cols-1 gap-y-4 sm:grid-cols-2">
        <Detail label="Declared name" value={card.name} />
        <Detail label="Declared URL" value={card.url || "—"} mono />
        <Detail
          label="Capabilities"
          value={[
            card.capabilities.streaming ? "streaming" : null,
            card.capabilities.pushNotifications ? "pushNotifications" : null,
          ]
            .filter(Boolean)
            .join(", ") || "none advertised"}
        />
        <Detail
          label="Modes"
          value={`in: ${card.defaultInputModes.join(", ") || "—"} · out: ${
            card.defaultOutputModes.join(", ") || "—"
          }`}
        />
      </div>
      <div className="mt-4">
        <div className="text-xs font-medium text-slate-400">Skills</div>
        {card.skills.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">No skills advertised.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {card.skills.map((s) => (
              <li key={s.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800">{s.name}</span>
                  <span className="mono text-xs text-slate-400">{s.id}</span>
                  {s.tags.map((t) => (
                    <span key={t} className="badge bg-slate-100 text-slate-600">
                      {t}
                    </span>
                  ))}
                </div>
                {s.description && (
                  <p className="mt-1 text-xs text-slate-500">{s.description}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Fetched from <span className="mono">{card.fetchedFrom}</span> at{" "}
        {new Date(card.fetchedAt).toLocaleString()}
      </p>
    </section>
  );
}

function ExchangePanel({ exchange }: { exchange: A2AExchange }) {
  const { authorization: a } = exchange;
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Exchange trace</h2>
        <div className="flex gap-2">
          <span
            className={`badge ${
              exchange.mode === "live"
                ? "bg-green-50 text-green-700"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {exchange.mode}
          </span>
          {exchange.latencyMs !== null && (
            <span className="badge bg-slate-100 text-slate-600">{exchange.latencyMs}ms</span>
          )}
        </div>
      </div>

      {/* authorization */}
      <div className="mt-4 space-y-2">
        <Stage
          label="1. Perimeter — Cedar callAgent on Tool::&quot;a2a&quot;"
          ok={a.perimeter.allowed}
          detail={a.perimeter.reason}
        />
        <Stage
          label="2. Peer-scoped — who may call whom"
          ok={a.peerScoped.evaluated ? a.peerScoped.allowed : null}
          detail={a.peerScoped.reason}
        />
      </div>

      {exchange.error && (
        <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {exchange.error}
        </div>
      )}

      {exchange.reply && (
        <div className="mt-4">
          <div className="text-xs font-medium text-slate-400">Reply</div>
          <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
            {exchange.reply.text || "(no text parts in the response)"}
          </pre>
          <div className="mt-2 flex flex-wrap gap-2">
            {exchange.reply.state && (
              <span className="badge bg-slate-100 text-slate-600">
                state: {exchange.reply.state}
              </span>
            )}
            {exchange.reply.taskId && (
              <span className="badge bg-slate-100 text-slate-600 mono">
                task: {exchange.reply.taskId}
              </span>
            )}
            {exchange.reply.droppedParts > 0 && (
              <span className="badge bg-amber-50 text-amber-700">
                {exchange.reply.droppedParts} non-text part(s) not rendered
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="text-xs font-medium text-slate-400">
          JSON-RPC request {exchange.mode === "preview" ? "(not sent)" : "(sent)"}
        </div>
        <pre className="mono mt-1 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          {JSON.stringify(exchange.request, null, 2)}
        </pre>
      </div>
    </section>
  );
}

function Stage({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean | null;
  detail: string;
}) {
  const tone =
    ok === null
      ? "border-slate-200 bg-slate-50 text-slate-600"
      : ok
        ? "border-green-200 bg-green-50 text-green-800"
        : "border-red-200 bg-red-50 text-red-800";
  const mark = ok === null ? "—" : ok ? "ALLOW" : "DENY";
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className="badge bg-white/70">{mark}</span>
      </div>
      <p className="mt-1 text-xs opacity-90">{detail}</p>
    </div>
  );
}

function RegisterPeerModal({
  tenants,
  onClose,
  onCreated,
}: {
  tenants: { id: string; tenantName: string }[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [peerId, setPeerId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? "");
  const [endpoint, setEndpoint] = useState("");
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [authKind, setAuthKind] = useState<"none" | "bearer-env" | "iam-role">("none");
  const [authEnvVar, setAuthEnvVar] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function register() {
    setError("");
    setBusy(true);
    try {
      await sendJSON("/api/a2a", "POST", {
        op: "register",
        peerId: peerId.trim(),
        displayName: displayName.trim(),
        description: description.trim(),
        tenantId,
        endpoint: endpoint.trim(),
        allowedHosts: allowedHostsText
          .split(/[\s,]+/)
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean),
        auth: {
          kind: authKind,
          ...(authKind === "bearer-env" ? { authEnvVar: authEnvVar.trim() } : {}),
          ...(authKind === "iam-role" ? { roleArn: roleArn.trim() } : {}),
        },
      });
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Register A2A peer"
      subtitle="The peer starts as Draft and must be approved before any message can be sent to it."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={register} disabled={busy}>
            {busy ? "Registering…" : "Register"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Peer id" required hint="lowercase, hyphens, 2-63 chars">
            <input
              className="input"
              value={peerId}
              onChange={(e) => setPeerId(e.target.value)}
              placeholder="supply-chain-agent"
            />
          </Field>
          <Field label="Display name" required>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Supply Chain Agent"
            />
          </Field>
        </div>
        <Field label="Description">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this peer does and who owns it"
          />
        </Field>
        <Field label="Owning tenant" required>
          <select className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.tenantName}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="A2A endpoint"
          required
          hint="HTTPS base URL. The Agent Card is read from /.well-known/agent-card.json (or agent.json). A REPLACE-ME placeholder registers in preview-only mode."
        >
          <input
            className="input"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://supply-chain-agent.internal.example.com"
          />
        </Field>
        <Field
          label="Allowed hosts"
          hint="Required for a live endpoint — the hostname must match. Comma or space separated."
        >
          <input
            className="input"
            value={allowedHostsText}
            onChange={(e) => setAllowedHostsText(e.target.value)}
            placeholder="internal.example.com"
          />
        </Field>

        <div>
          <span className="label">Outbound auth</span>
          <div className="grid gap-2 sm:grid-cols-3">
            <RadioCard
              selected={authKind === "none"}
              onClick={() => setAuthKind("none")}
              title="None"
              description="Unauthenticated peer (lab / internal mesh)."
            />
            <RadioCard
              selected={authKind === "bearer-env"}
              onClick={() => setAuthKind("bearer-env")}
              title="Bearer (env var)"
              description="Token read server-side at call time. Never stored."
            />
            <RadioCard
              selected={authKind === "iam-role"}
              onClick={() => setAuthKind("iam-role")}
              title="IAM role"
              description="Role reference for SigV4. Signing is a production step."
            />
          </div>
        </div>

        {authKind === "bearer-env" && (
          <Field
            label="Auth env var name"
            required
            hint="Only the NAME is stored. The value is resolved from the server environment."
          >
            <input
              className="input"
              value={authEnvVar}
              onChange={(e) => setAuthEnvVar(e.target.value)}
              placeholder="SUPPLY_CHAIN_AGENT_TOKEN"
            />
          </Field>
        )}
        {authKind === "iam-role" && (
          <Field label="Role ARN">
            <input
              className="input"
              value={roleArn}
              onChange={(e) => setRoleArn(e.target.value)}
              placeholder="arn:aws:iam::123456789012:role/A2ACaller"
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
