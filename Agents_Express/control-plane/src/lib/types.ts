// Shared domain types for the AgentExpress control plane.
// These model the entities from both AWS workshops:
//  - Part 1 Registry (agents/tools/MCP servers)
//  - Part 2 Agents (declarative config)
//  - Part 3 Policies (Cedar, two-layer)
//  - Part 4 Playground (persona simulation)
//  - Part 5 Model Governance (providers, LLM gateway routes)
//  - plus an Audit trail.

export type ID = string;

// ---------- Part 1: AWS Agent Registry ----------
// Mirrors the real workshop model:
//  - Registries are top-level CONTAINERS (catalogs) created in an account.
//  - Registry RECORDS are metadata for resources published into a registry.

// A registry is a catalog scoped to a team/environment/resource type.
export interface Registry {
  id: ID;
  name: string;
  description: string;
  // autoApproval:false (default) is what makes records start in Draft and
  // walk the governance lifecycle.
  autoApproval: boolean;
  createdAt: string;
}

// How the record definition is provided.
export type RecordSource = "synchronize-from-endpoint" | "define-manually";

// What kind of resource is being published.
export type RecordType = "MCP" | "Agent" | "Agent skills" | "Custom";

// Credential type used to reach the resource.
export type CredentialType = "No authorization" | "IAM Role" | "OAuth client";

// Governance lifecycle: Draft -> Pending approval -> Approved/Rejected -> Deprecated.
export type RecordStatus =
  | "Draft"
  | "Pending approval"
  | "Approved"
  | "Rejected"
  | "Deprecated";

// One callable operation within an MCP schema.
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// The MCP schema document carried by a record (esp. Custom/Lambda records).
export interface McpSchema {
  name: string;
  version: string;
  // Present for Custom records backed by a Lambda.
  lambdaArn?: string;
  toolSchema: ToolSchema[];
}

export interface RegistryRecord {
  id: ID;
  registryId: ID; // the container this record belongs to
  name: string;
  description: string;
  recordSource: RecordSource;
  type: RecordType;
  credentialType: CredentialType;
  status: RecordStatus;
  // For synchronize-from-endpoint records.
  endpoint?: string;
  // For define-manually (and after endpoint sync completes) — the schema.
  mcpSchema?: McpSchema;
  // Convenience: the flat list of tool names exposed by this record.
  tools: string[];
  owner: string;
  createdAt: string;
}

// ---------- Part 2: Agents ----------
// Who can see/use the agent. Default is private to the creator; the workshop
// sets the Expense Assistant to public so the Playground (Parts 4-5) can reach it.
export type AgentVisibility = "private" | "public";

export interface AgentConfig {
  id: ID;
  name: string;
  description: string;
  // References a CatalogModel (Settings → Models catalog).
  modelId: ID;
  systemPrompt: string;
  // Registry record ids whose tools this agent may use (approved records only).
  toolRefs: ID[];
  // Compute is informational: the agent runs on Bedrock AgentCore Runtime.
  compute: {
    runtime: string; // e.g. "Bedrock AgentCore"
  };
  visibility: AgentVisibility;
  status: "draft" | "ready";
  createdAt: string;
}

// The platform model catalog (Settings → Models). Admins curate; agent
// developers consume. Distinct from the Part 5 LLM-gateway routes/providers.
export type InferenceProvider = "Amazon Bedrock" | "Anthropic" | "OpenAI";

export interface CatalogModel {
  id: ID;
  // Friendly catalog name, e.g. "Claude Opus 4.6".
  name: string;
  // Model vendor, e.g. "Anthropic".
  modelProvider: string;
  // Upstream model id, e.g. "global.anthropic.claude-opus-4-6-v1:0".
  modelId: string;
  // Where inference is served, e.g. "Amazon Bedrock".
  inferenceProvider: InferenceProvider;
  createdAt: string;
}

// ---------- Part 3: Policies (Cedar, two layers) ----------
// Layer 1: AgentCore Policy at the gateway (perimeter / MCP boundary).
// Layer 2: Amazon Verified Permissions (AVP) inside the tool (e.g. Lambda).
export type PolicyLayer = "gateway" | "avp";

export type PolicyEffect = "permit" | "forbid";

export interface Policy {
  id: ID;
  name: string;
  layer: PolicyLayer;
  description: string;
  // Raw Cedar policy text.
  cedar: string;
  enabled: boolean;
  createdAt: string;
}

// ---------- Part 4: Playground / personas ----------
export interface Persona {
  id: ID;
  name: string;
  // Cognito user sub (identity claim id).
  sub: string;
  email: string;
  provider: "AWS Cognito" | "Entra ID";
  // Cognito group names this persona belongs to (drives cognito:groups claim).
  groups: string[];
  // Attributes the policy evaluator can reason about (role, approvalLimit, etc.).
  attributes: Record<string, string>;
}

// A pre-created Cognito group (seniority level).
export interface CognitoGroup {
  name: string;
  description: string;
}

export interface EvaluationRequest {
  personaId: ID;
  agentId: ID;
  action: string; // e.g. "invokeTool"
  tool: string; // e.g. "expense.submit"
  resource?: string;
  // Optional numeric context for resource-based conditions (e.g. expense amount).
  amount?: string;
}

export interface LayerDecision {
  layer: PolicyLayer;
  decision: PolicyEffect | "default-deny";
  matchedPolicyId?: ID;
  reason: string;
}

export interface EvaluationResult {
  allowed: boolean;
  decisions: LayerDecision[];
  evaluatedAt: string;
}

// ---------- Part 5: Model Governance ----------
export type ProviderKind = "bedrock" | "openai" | "anthropic" | "custom";

export interface ModelProvider {
  id: ID;
  name: string;
  kind: ProviderKind;
  // The LLM gateway fronts providers over the OpenAI wire protocol.
  baseUrl: string;
  // Per-provider rate limit (requests per minute) enforced by the gateway.
  rateLimitRpm: number;
  enabled: boolean;
}

export interface ModelRoute {
  id: ID;
  // Logical model name used by agents, e.g. "claude-opus".
  alias: string;
  providerId: ID;
  // Actual upstream model id, e.g. "us.anthropic.claude-opus-...".
  upstreamModelId: string;
  // Per-team monthly token budget; null = unlimited.
  monthlyTokenBudget: number | null;
  enabled: boolean;
}

// ---------- Audit ----------
export type AuditCategory =
  | "registry"
  | "agent"
  | "policy"
  | "playground"
  | "model";

export interface AuditEvent {
  id: ID;
  category: AuditCategory;
  action: string;
  actor: string;
  detail: string;
  at: string;
}


// ---------- Part 3-1: Policy Library (NL2Cedar + lifecycle) ----------
export type LibraryPolicyStatus =
  | "Draft"
  | "In Review"
  | "Published"
  | "Archived";

export interface PolicyVersion {
  version: number; // 1-based
  cedar: string;
  // Natural-language composer text used to generate the Cedar.
  nl: string;
  message: string; // change note / version message
  author: string;
  at: string;
}

export interface PolicyActivity {
  version?: number;
  message: string;
  author: string;
  at: string;
  kind: "created" | "version";
}

export interface LibraryPolicy {
  id: ID;
  name: string;
  description: string;
  status: LibraryPolicyStatus;
  effect: "permit" | "forbid";
  creator: string;
  createdAt: string;
  updatedAt: string;
  versions: PolicyVersion[];
  activity: PolicyActivity[];
}

// ---------- Part 3-1: Policy Engines (AgentCore Policy) ----------
export type EnforcementMode = "Enforce" | "Log only";

export interface EngineImportedPolicy {
  policyId: ID; // references a LibraryPolicy
  name: string;
  type: "permit" | "forbid";
  synced: boolean;
  lastSynced: string | null;
}

export interface AttachedGateway {
  gatewayId: string;
  name: string;
  mode: EnforcementMode;
}

export interface SyncEntry {
  id: ID;
  scope: string; // "Engine", "Policy", "Schema", etc.
  action: string; // engine_create, gateway_attach, policy_sync…
  target: string;
  result: "Success" | "Failed";
  actor: string;
  at: string;
}

export interface PolicyEngine {
  id: ID;
  name: string;
  description: string;
  status: "Active";
  region: string;
  awsEngineId: string;
  awsEngineArn: string;
  importedPolicies: EngineImportedPolicy[];
  gateways: AttachedGateway[];
  syncHistory: SyncEntry[];
  createdAt: string;
  updatedAt: string;
}

// ---------- Part 3-2: Policy Stores (Amazon Verified Permissions) ----------
export interface StorePolicy {
  id: ID;
  name: string;
  type: "permit" | "forbid";
  status: LibraryPolicyStatus;
  cedar: string;
}

export interface PolicyStore {
  id: ID;
  name: string;
  description: string;
  status: "Active";
  region: string;
  namespace: string; // e.g. "AnyCompany"
  policyStoreId: string; // e.g. LDb1ABC2def3GHI4jkl
  schema: string; // JSON schema text
  policies: StorePolicy[];
  syncHistory: SyncEntry[];
}
