"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PageHeader,
  DetailHeader,
  Field,
  Modal,
  RadioCard,
  Toggle,
  Pill,
  EmptyState,
} from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import {
  CredentialType,
  KbProvider,
  KnowledgeConfig,
  McpSchema,
  Registry,
  RegistryRecord,
  RecordSource,
  RecordStatus,
  RecordType,
} from "@/lib/types";

// Parse the free-text connection box into provider-specific connection fields.
function parseKbConnection(
  provider: KbProvider,
  text: string
): KnowledgeConfig["connection"] {
  const v = text.trim();
  switch (provider) {
    case "Bedrock Knowledge Base":
      return { knowledgeBaseId: v, region: "us-east-1" };
    case "Databricks Vector Search":
      return { endpoint: v, indexName: v };
    case "MongoDB Atlas Vector Search":
      return { clusterUri: v };
    case "Qdrant":
      // v is the cluster URL; collection is captured separately in the form.
      return { qdrantUrl: v };
    case "OpenSearch":
      return { openSearchEndpoint: v };
    default:
      return { indexOrNamespace: v };
  }
}

interface RegistryData {
  registries: Registry[];
  records: RegistryRecord[];
}

type View =
  | { kind: "list" }
  | { kind: "registry"; registryId: string }
  | { kind: "create-record"; registryId: string }
  | { kind: "record"; recordId: string };

export default function RegistryPage() {
  const [data, setData] = useState<RegistryData>({ registries: [], records: [] });
  const [view, setView] = useState<View>({ kind: "list" });
  const [showRegModal, setShowRegModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setData(await getJSON<RegistryData>("/api/registry"));
  }
  useEffect(() => {
    load();
  }, []);

  if (view.kind === "create-record") {
    return (
      <CreateRecord
        registryId={view.registryId}
        onDone={async () => {
          await load();
          setView({ kind: "registry", registryId: view.registryId });
        }}
        onCancel={() =>
          setView({ kind: "registry", registryId: view.registryId })
        }
      />
    );
  }

  if (view.kind === "record") {
    const rec = data.records.find((r) => r.id === view.recordId);
    if (!rec) return null;
    return (
      <RecordDetails
        record={rec}
        onBack={() =>
          setView({ kind: "registry", registryId: rec.registryId })
        }
        onChanged={load}
      />
    );
  }

  const selectedRegistry =
    view.kind === "registry"
      ? data.registries.find((r) => r.id === view.registryId)
      : null;
  const records = selectedRegistry
    ? data.records.filter((r) => r.registryId === selectedRegistry.id)
    : [];

  return (
    <>
      <PageHeader
        title="Tool/Agent Registry"
        subtitle="Manage your registries for organizing agents and tools."
        action={
          <button className="btn-primary" onClick={() => setShowRegModal(true)}>
            + Create Registry
          </button>
        }
      />
      <div className="px-8 pb-10">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {!selectedRegistry ? (
          <>
            <h3 className="mb-3 text-sm font-semibold text-slate-700">
              Registries
            </h3>
            {data.registries.length === 0 ? (
              <EmptyState text="No registries yet. Create one to begin." />
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.registries.map((r) => {
                  const count = data.records.filter(
                    (x) => x.registryId === r.id
                  ).length;
                  return (
                    <button
                      key={r.id}
                      onClick={() =>
                        setView({ kind: "registry", registryId: r.id })
                      }
                      className="card p-5 text-left transition hover:border-slate-300"
                    >
                      <div className="font-semibold">{r.name}</div>
                      <div className="mt-1 line-clamp-2 text-sm text-slate-500">
                        {r.description}
                      </div>
                      <div className="mt-3">
                        <span className="badge bg-slate-100 text-slate-600">
                          {count} record{count === 1 ? "" : "s"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <button
                  onClick={() => setView({ kind: "list" })}
                  className="mb-1 text-sm text-slate-500 hover:text-slate-900"
                >
                  ← Registries
                </button>
                <h3 className="text-lg font-semibold">
                  {selectedRegistry.name}
                </h3>
                <p className="text-sm text-slate-500">
                  {selectedRegistry.description}
                </p>
              </div>
              <button
                className="btn-primary"
                onClick={() =>
                  setView({
                    kind: "create-record",
                    registryId: selectedRegistry.id,
                  })
                }
              >
                + Create Record
              </button>
            </div>

            {records.length === 0 ? (
              <EmptyState text="No records in this registry yet." />
            ) : (
              <div className="card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Tools</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {records.map((rec) => (
                      <tr
                        key={rec.id}
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() =>
                          setView({ kind: "record", recordId: rec.id })
                        }
                      >
                        <td className="px-4 py-3 font-medium">{rec.name}</td>
                        <td className="px-4 py-3">
                          <span className="badge bg-amber-50 font-mono text-amber-700">
                            {rec.type}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Pill status={rec.status} />
                        </td>
                        <td className="px-4 py-3 text-slate-500">
                          {rec.tools.length}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-400">›</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {showRegModal && (
        <CreateRegistryModal
          onClose={() => setShowRegModal(false)}
          onCreated={async (id) => {
            setShowRegModal(false);
            await load();
            setView({ kind: "registry", registryId: id });
          }}
          onError={setError}
        />
      )}
    </>
  );
}

/* ---------- Create New Registry (modal) ---------- */
function CreateRegistryModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [autoApproval, setAutoApproval] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function create() {
    if (submitting) return; // guard against double-submit
    setLocalError(null);
    setSubmitting(true);
    try {
      const reg = await sendJSON<Registry>("/api/registry", "POST", {
        kind: "registry",
        name,
        description,
        autoApproval,
      });
      onCreated(reg.id);
    } catch (e) {
      // Keep the modal OPEN and show the error inline so the create can be
      // retried without losing the typed values (previously the modal closed
      // silently, which looked like "nothing happened").
      const msg = (e as Error).message || "Failed to create registry.";
      setLocalError(msg);
      onError(msg);
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Create New Registry"
      subtitle="Create a new registry to organize and manage your agents and tools."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!name || submitting}
            onClick={create}
          >
            {submitting ? "Creating…" : "Create Registry"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {localError && (
          <div className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
            {localError}
          </div>
        )}
        <Field
          label="Registry Name"
          required
          hint="Must start with a letter and contain only letters, numbers, and underscores"
        >
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="AnyCompany_Registry"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            className="input h-20"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Catalog of agents, MCP servers, and tools approved for production use in AnyCompany"
          />
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Auto-approve records</div>
            <div className="text-xs text-slate-500">
              When enabled, submitted records are approved automatically without
              manual review.
            </div>
          </div>
          <Toggle on={autoApproval} onChange={setAutoApproval} />
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Create Record (radio-card form) ---------- */
function CreateRecord({
  registryId,
  onDone,
  onCancel,
}: {
  registryId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [recordSource, setRecordSource] =
    useState<RecordSource>("synchronize-from-endpoint");
  const [type, setType] = useState<RecordType>("MCP");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credentialType, setCredentialType] =
    useState<CredentialType>("No authorization");
  // Per-credential auth config (shown conditionally).
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthTokenUrl, setOauthTokenUrl] = useState("");
  const [iamRoleArn, setIamRoleArn] = useState("");
  const [apiKeySecretRef, setApiKeySecretRef] = useState("");
  const [schemaText, setSchemaText] = useState("");
  // Knowledge Base fields
  const [kbProvider, setKbProvider] = useState<KbProvider>("Bedrock Knowledge Base");
  const [kbConnection, setKbConnection] = useState("");
  const [kbCollection, setKbCollection] = useState("");
  const [kbTopK, setKbTopK] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isKb = type === "Knowledge Base";
  const needsEndpoint = recordSource === "synchronize-from-endpoint";
  const endpointValid = !needsEndpoint || /^https:\/\/.+/i.test(endpoint.trim());

  // Human-readable reason the form can't be submitted yet (null = ready).
  function validationMessage(): string | null {
    if (needsEndpoint && !endpoint.trim())
      return "Enter an HTTPS endpoint, or switch Record source to “Define manually”.";
    if (needsEndpoint && !endpointValid)
      return "The endpoint must be a valid URL starting with https://";
    if (!needsEndpoint && !isKb && !name.trim())
      return "Enter a Record Name (it can’t be derived without an endpoint).";
    if (isKb && !kbConnection.trim())
      return "Enter the Connection (e.g. the Qdrant cluster URL or Bedrock KB id).";
    return null;
  }

  async function submit(status: "draft" | "submit") {
    setError(null);
    const vmsg = validationMessage();
    if (vmsg) {
      setError(vmsg);
      // Scroll the error into view (the form can be long).
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      let mcpSchema: McpSchema | undefined;
      if (!isKb && recordSource === "define-manually" && schemaText.trim()) {
        mcpSchema = JSON.parse(schemaText) as McpSchema;
      }
      let knowledgeConfig: KnowledgeConfig | undefined;
      if (isKb) {
        const connection = parseKbConnection(kbProvider, kbConnection);
        // Qdrant: attach the collection name alongside the cluster URL.
        if (kbProvider === "Qdrant" && kbCollection.trim()) {
          connection.qdrantCollection = kbCollection.trim();
        }
        knowledgeConfig = {
          provider: kbProvider,
          connection,
          retrieval: { topK: kbTopK, scoreThreshold: 0.4, mode: "hybrid", citations: true },
        };
      }
      const rec = await sendJSON<RegistryRecord>("/api/registry", "POST", {
        kind: "record",
        registryId,
        name: name || undefined,
        description,
        // KBs are always define-manually (no live MCP introspection).
        recordSource: isKb ? "define-manually" : recordSource,
        type,
        credentialType,
        endpoint: endpoint || undefined,
        mcpSchema,
        knowledgeConfig,
      });
      if (status === "submit") {
        await sendJSON("/api/registry", "PATCH", {
          id: rec.id,
          status: "Pending approval" as RecordStatus,
        });
      }
      onDone();
    } catch (e) {
      setError((e as Error).message || "Failed to create record. Please retry.");
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="Create Record" subtitle="Publish a resource into the registry." />
      <div className="space-y-6 px-8 pb-28">
        {error && (
          <div className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Record source */}
        <section className="card p-6">
          <h2 className="text-base font-semibold">Record source</h2>
          <p className="mb-4 text-sm text-slate-500">
            Choose how to provide the record definition.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <RadioCard
              selected={recordSource === "synchronize-from-endpoint"}
              onClick={() => setRecordSource("synchronize-from-endpoint")}
              title="Synchronize from endpoint"
              icon="🔗"
              description="Provide an endpoint URL and authentication details. The Registry auto-detects available tools and metadata."
            />
            <RadioCard
              selected={recordSource === "define-manually"}
              onClick={() => setRecordSource("define-manually")}
              title="Define manually"
              icon="✎"
              description="Manually specify the record definition, schema, and metadata. Use this for records without accessible endpoints."
            />
          </div>
        </section>

        {/* Record details */}
        <section className="card p-6">
          <h2 className="text-base font-semibold">Record details</h2>
          <p className="mb-4 text-sm text-slate-500">
            Specify the record configuration including name, description and
            type.
          </p>

          <div className="mb-2 text-sm font-medium text-slate-700">Type</div>
          <div className="grid gap-4 md:grid-cols-2">
            <RadioCard selected={type === "MCP"} onClick={() => setType("MCP")} title="MCP" icon="⚡"
              description="Protocol designed for AI tool and agent communications." />
            <RadioCard selected={type === "Agent"} onClick={() => setType("Agent")} title="Agent" icon="◈"
              description="Protocol for secure agent-to-agent interactions." />
            <RadioCard selected={type === "Agent skills"} onClick={() => setType("Agent skills")} title="Agent skills" icon="✦"
              description="Register agent skills with markdown documentation and an optional structured definition." />
            <RadioCard selected={type === "Custom"} onClick={() => setType("Custom")} title="Custom" icon="⚙"
              description="Custom protocol implementation. Define your own interface specification and integration requirements." />
            <RadioCard selected={type === "Knowledge Base"} onClick={() => setType("Knowledge Base")} title="Knowledge Base" icon="🧠"
              description="A governed retrieval source (Bedrock KB, Databricks Vector Search, MongoDB Atlas, OpenSearch) agents reference for RAG." />
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Field label="Record Name" hint="Must start with a letter, only letters, numbers, and underscores (max 64 chars).">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave empty to derive from URL" />
            </Field>
            <Field label="Description (optional)" hint="Short, human-readable summary shown in discovery and search results.">
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="AWS knowledge MCP server" />
            </Field>
          </div>

          {needsEndpoint && (
            <div className="mt-4">
              <Field label="Endpoint" required hint="Must be a valid HTTPS URL.">
                <input
                  className={`input ${endpoint && !endpointValid ? "border-red-400 focus:ring-red-100" : ""}`}
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://knowledge-mcp.global.api.aws"
                />
              </Field>
              {endpoint && !endpointValid && (
                <p className="mt-1 text-xs text-red-600">Endpoint must start with https://</p>
              )}
            </div>
          )}

          {recordSource === "define-manually" && !isKb && (
            <div className="mt-4">
              <Field label="MCP schema" hint="JSON with lambdaArn and toolSchema[].">
                <textarea className="input mono h-56" value={schemaText} onChange={(e) => setSchemaText(e.target.value)}
                  placeholder='{"name":"ExpenseTools","version":"1.0.0","lambdaArn":"arn:aws:lambda:…","toolSchema":[…]}' />
              </Field>
            </div>
          )}

          {isKb && (
            <div className="mt-4 space-y-4">
              <Field label="Vector / KB provider">
                <select className="input" value={kbProvider} onChange={(e) => setKbProvider(e.target.value as KbProvider)}>
                  <option>Bedrock Knowledge Base</option>
                  <option>Databricks Vector Search</option>
                  <option>MongoDB Atlas Vector Search</option>
                  <option>Qdrant</option>
                  <option>OpenSearch</option>
                  <option>Other Vector Store</option>
                </select>
              </Field>
              <Field label="Connection" hint={
                kbProvider === "Bedrock Knowledge Base" ? "Knowledge Base ID (e.g. KB1A2B3C4D)"
                : kbProvider === "Databricks Vector Search" ? "Index endpoint / index name (Unity Catalog governed)"
                : kbProvider === "MongoDB Atlas Vector Search" ? "Cluster URI"
                : kbProvider === "Qdrant" ? "Qdrant cluster URL (API key is vended by AgentCore Identity, never stored)"
                : "Endpoint / index"}>
                <input className="input mono" value={kbConnection} onChange={(e) => setKbConnection(e.target.value)}
                  placeholder={
                    kbProvider === "Bedrock Knowledge Base" ? "KB1A2B3C4D"
                    : kbProvider === "Qdrant" ? "https://<cluster-id>.<region>.aws.cloud.qdrant.io"
                    : "https://…"} />
              </Field>
              {kbProvider === "Qdrant" && (
                <Field label="Collection" hint="Qdrant collection name the agent retrieves from.">
                  <input className="input mono" value={kbCollection} onChange={(e) => setKbCollection(e.target.value)}
                    placeholder="my_collection" />
                </Field>
              )}
              <Field label="Top K (chunks)">
                <input type="number" className="input w-32" value={kbTopK} onChange={(e) => setKbTopK(Number(e.target.value))} />
              </Field>
            </div>
          )}
        </section>

        {/* Authentication — ALWAYS shown, consistent across every source/type */}
        <section className="card p-6">
          <h2 className="text-base font-semibold">Authentication</h2>
          <p className="mb-4 text-sm text-slate-500">
            How the gateway authenticates to this resource. The agent never sees
            the credential — it is vended by AgentCore Identity.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <RadioCard selected={credentialType === "IAM Role"} onClick={() => setCredentialType("IAM Role")}
              title="IAM Role" icon="🛡" description="IAM role assumption with SigV4 signing (AWS-native targets)." />
            <RadioCard selected={credentialType === "OAuth client"} onClick={() => setCredentialType("OAuth client")}
              title="OAuth client" icon="🔑" description="OAuth 2.0 client credentials (SaaS / third-party)." />
            <RadioCard selected={credentialType === "API key"} onClick={() => setCredentialType("API key")}
              title="API key" icon="🗝" description="Static key stored in AWS Secrets Manager." />
            <RadioCard selected={credentialType === "No authorization"} onClick={() => setCredentialType("No authorization")}
              title="No authorization" icon="🌐" description="No authorization required. Use for public endpoints." />
          </div>

          {/* Per-credential config */}
          {credentialType === "IAM Role" && (
            <div className="mt-4">
              <Field label="IAM Role ARN (optional — defaults to the gateway execution role)">
                <input className="input mono" value={iamRoleArn} onChange={(e) => setIamRoleArn(e.target.value)}
                  placeholder="arn:aws:iam::123456789012:role/registry-target-role" />
              </Field>
            </div>
          )}
          {credentialType === "OAuth client" && (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Token URL">
                <input className="input" value={oauthTokenUrl} onChange={(e) => setOauthTokenUrl(e.target.value)}
                  placeholder="https://idp.example.com/oauth2/token" />
              </Field>
              <Field label="Client ID">
                <input className="input" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="client-id" />
              </Field>
              <Field label="Client secret (stored in the Token Vault, never exposed to the agent)">
                <input className="input" type="password" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} placeholder="••••••••" />
              </Field>
            </div>
          )}
          {credentialType === "API key" && (
            <div className="mt-4">
              <Field label="Secrets Manager reference" hint="The key is read from Secrets Manager at invocation; it is never stored in the record.">
                <input className="input mono" value={apiKeySecretRef} onChange={(e) => setApiKeySecretRef(e.target.value)}
                  placeholder="arn:aws:secretsmanager:us-east-1:…:secret/registry/my-tool" />
              </Field>
            </div>
          )}
          {credentialType === "No authorization" && (
            <div className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              Public endpoint — no credential is attached. Only use for genuinely
              public resources (e.g. the AWS Knowledge MCP server).
            </div>
          )}
        </section>
      </div>

      {/* Sticky footer actions */}
      <div className="fixed bottom-0 left-64 right-0 flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-8 py-4">
        <div className="text-xs text-slate-500">
          {type} · {recordSource === "synchronize-from-endpoint" ? "Sync from endpoint" : "Define manually"} ·{" "}
          Auth: <span className="font-medium text-slate-700">{credentialType}</span>
          {validationMessage() && (
            <span className="ml-2 text-amber-600">— {validationMessage()}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button className="btn-ghost" onClick={() => submit("draft")} disabled={submitting}>
            {submitting ? "Saving…" : "Create as draft"}
          </button>
          <button className="btn-primary" onClick={() => submit("submit")} disabled={submitting}>
            {submitting ? "Submitting…" : "Create and submit for approval"}
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------- Record Details ---------- */
function RecordDetails({
  record,
  onBack,
  onChanged,
}: {
  record: RegistryRecord;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const nextActions = useMemo(() => {
    const map: Record<RecordStatus, { label: string; to: RecordStatus }[]> = {
      Draft: [{ label: "Submit for Approval", to: "Pending approval" }],
      "Pending approval": [
        { label: "Approve", to: "Approved" },
        { label: "Reject", to: "Rejected" },
      ],
      Approved: [{ label: "Deprecate", to: "Deprecated" }],
      Rejected: [{ label: "Return to Draft", to: "Draft" }],
      Deprecated: [],
    };
    return map[record.status];
  }, [record.status]);

  async function update(to: RecordStatus) {
    await sendJSON("/api/registry", "PATCH", { id: record.id, status: to });
    setMenuOpen(false);
    await onChanged();
  }

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <>
      <DetailHeader
        backHref="#"
        title="Record Details"
        subtitle="View detailed information about this registry record"
        actions={
          <>
            <button className="btn-ghost">✎ Edit</button>
            {record.recordSource === "synchronize-from-endpoint" && (
              <button className="btn-ghost">⟳ Sync</button>
            )}
            <div className="relative">
              <button
                className="btn-primary"
                onClick={() => setMenuOpen((o) => !o)}
                disabled={nextActions.length === 0}
              >
                Update status ▾
              </button>
              {menuOpen && nextActions.length > 0 && (
                <div className="absolute right-0 z-10 mt-1 w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                  {nextActions.map((a) => (
                    <button
                      key={a.to}
                      onClick={() => update(a.to)}
                      className="block w-full px-4 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        }
      />

      {/* allow clicking the inline back button */}
      <div className="px-8 pt-4">
        <button
          onClick={onBack}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          ← Back to registry
        </button>
      </div>

      <div className="space-y-6 px-8 py-4 pb-10">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold">{record.name}</h2>
          <Pill status={record.status} />
        </div>

        {/* Record details grid */}
        <div className="card p-6">
          <h3 className="mb-4 text-base font-semibold">Record details</h3>
          <div className="grid grid-cols-1 gap-y-5 md:grid-cols-3">
            <Detail k="Name" v={record.name} />
            <Detail k="Description" v={record.description || "—"} />
            <Detail
              k="Record ID"
              v={<span className="mono">{record.id}</span>}
            />
            <Detail k="Status" v={<Pill status={record.status} />} />
            <Detail k="Version" v={record.mcpSchema?.version ?? "1.0.0"} />
            <Detail k="Last updated" v={fmt(record.createdAt)} />
            <Detail k="Record type" v={record.type} />
            <Detail k="Created" v={fmt(record.createdAt)} />
          </div>
        </div>

        {/* Endpoint / Lambda */}
        {record.endpoint && (
          <div className="card p-6">
            <h3 className="mb-3 text-base font-semibold">🔗 MCP Endpoint</h3>
            <div className="rounded-lg bg-slate-50 px-4 py-3">
              <span className="mono text-slate-700">{record.endpoint}</span>
            </div>
          </div>
        )}
        {record.mcpSchema?.lambdaArn && (
          <div className="card p-6">
            <h3 className="mb-3 text-base font-semibold">Server Information</h3>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
              <Detail k="Server Name" v={record.mcpSchema.name} />
              <Detail k="Version" v={record.mcpSchema.version} />
              <Detail
                k="Lambda ARN"
                v={<span className="mono text-xs">{record.mcpSchema.lambdaArn}</span>}
              />
            </div>
          </div>
        )}

        {record.knowledgeConfig && (
          <div className="card p-6">
            <h3 className="mb-3 text-base font-semibold">🧠 Knowledge Base</h3>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
              <Detail k="Provider" v={record.knowledgeConfig.provider} />
              <Detail
                k="Retrieval"
                v={`${record.knowledgeConfig.retrieval.mode} · top ${record.knowledgeConfig.retrieval.topK} · citations ${record.knowledgeConfig.retrieval.citations ? "on" : "off"}`}
              />
              <Detail
                k="Residency"
                v={record.knowledgeConfig.residencyRegion ?? "—"}
              />
            </div>
            <div className="mt-3 rounded-lg bg-slate-50 p-3">
              <span className="mono text-xs text-slate-600">
                {JSON.stringify(record.knowledgeConfig.connection)}
              </span>
            </div>
          </div>
        )}

        {/* Tools */}
        <div className="card p-6">
          <h3 className="mb-4 flex items-center gap-2 text-base font-semibold">
            🔧 Tools
            <span className="badge bg-slate-100 text-slate-600">
              {record.tools.length}
            </span>
          </h3>
          <div className="space-y-2">
            {record.tools.map((t) => {
              const schema = record.mcpSchema?.toolSchema.find(
                (s) => s.name === t
              );
              return (
                <div
                  key={t}
                  className="flex items-start justify-between rounded-lg border border-slate-200 p-4"
                >
                  <div>
                    <div className="mono font-medium text-slate-800">{t}</div>
                    {schema?.description && (
                      <div className="mt-1 text-xs text-slate-500">
                        {schema.description}
                      </div>
                    )}
                  </div>
                  <button className="btn-primary shrink-0">▷ Test tool</button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function Detail({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-400">{k}</div>
      <div className="mt-1 text-sm text-slate-800">{v}</div>
    </div>
  );
}
