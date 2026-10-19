// Shared domain types for the AgentExpress control plane.
// These model the entities from both AWS workshops:
//  - Part 1 Registry (agents/tools/MCP servers)
//  - Part 2 Agents (declarative config)
//  - Part 3 Policies (Cedar, two-layer)
//  - Part 4 Playground (persona simulation)
//  - Part 5 Model Governance (providers, LLM gateway routes)
//  - plus an Audit trail.

export type ID = string;

// ---------- SaaS multi-tenancy (replicated from saas-gaming-app/saas-workloads) ----------
// Tenant tiers drive feature gating and isolation strategy.
export type TenantTier = "basic" | "pro";

// Isolation strategy per tier (pool = shared infra, silo = dedicated).
export type IsolationModel = "pool" | "silo";

// Per-tier feature flags + limits (mirrors tierMiddleware.getTierConfig).
export interface TierConfig {
  maxAgents: number;
  maxToolsPerAgent: number;
  maxKnowledgeBases: number;
  monthlyTokenBudget: number | null; // null = unlimited
  enableAnalytics: boolean;
  enableAuditExport: boolean;
  enableCustomPolicies: boolean;
  enableDedicatedGateway: boolean;
  maxModelsInCatalog: number;
}

// Node type in the org hierarchy.
export type TenantNodeType = "org" | "bu" | "function" | "subunit";

export interface Tenant {
  id: ID;
  tenantId: string; // slug, e.g. "takeda-rnd-001"
  tenantName: string; // display, e.g. "Takeda R&D"
  // Hierarchy: null for the root org; otherwise the parent tenant id.
  parentId: ID | null;
  type: TenantNodeType;
  tier: TenantTier;
  isolation: IsolationModel;
  // Data-plane routing hint (pool = shared resource, silo = dedicated).
  resourcePool: string;
  createdAt: string;
  updatedAt: string;
}

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
export type RecordType = "MCP" | "Agent" | "Agent skills" | "Custom" | "Knowledge Base";

// Credential type used to reach the resource.
export type CredentialType =
  | "No authorization"
  | "IAM Role"
  | "OAuth client"
  | "API key";

// ---------- Knowledge Bases (vector / retrieval sources) ----------
// A KB is a governed retrieval source referenced by agents for RAG. The
// provider adapter normalizes retrieval to retrieve(query, topK, filters).
export type KbProvider =
  | "Bedrock Knowledge Base"
  | "Databricks Vector Search"
  | "MongoDB Atlas Vector Search"
  | "OpenSearch"
  | "Other Vector Store";

export type RetrievalMode = "semantic" | "hybrid" | "keyword";

export interface KnowledgeConfig {
  provider: KbProvider;
  // Provider-specific connection hints (only the relevant ones are set).
  connection: {
    // Bedrock KB
    knowledgeBaseId?: string;
    region?: string;
    // Databricks Vector Search
    endpoint?: string;
    indexName?: string;
    unityCatalog?: string; // catalog.schema
    // MongoDB Atlas
    clusterUri?: string;
    database?: string;
    collection?: string;
    vectorIndex?: string;
    // OpenSearch / generic
    openSearchEndpoint?: string;
    indexOrNamespace?: string;
  };
  // Default retrieval settings (overridable per agent reference).
  retrieval: {
    topK: number;
    scoreThreshold: number;
    mode: RetrievalMode;
    citations: boolean;
  };
  // Residency hint for regulated data (EU/JP/US).
  residencyRegion?: string;
}

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
  // For Knowledge Base records — provider + connection + retrieval config.
  knowledgeConfig?: KnowledgeConfig;
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
  // Owning tenant (BU) — scopes the agent and drives tier-limit enforcement.
  tenantId: ID;
  // References a CatalogModel (Settings → Models catalog).
  modelId: ID;
  systemPrompt: string;
  // Registry record ids whose tools this agent may use (approved records only).
  toolRefs: ID[];
  // Approved Knowledge Base record ids this agent may retrieve from (RAG).
  knowledgeRefs: ID[];
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
export type InferenceProvider = "Amazon Bedrock" | "Anthropic" | "OpenAI" | "AgentCore Gateway";

export type InferenceApi = "Responses API (/v1/responses)" | "Chat Completions (/v1/chat/completions)";

export interface CatalogModel {
  id: ID;
  // Friendly catalog name, e.g. "Claude Opus 4.6".
  name: string;
  // Model vendor, e.g. "Anthropic" / "Custom: OpenAI".
  modelProvider: string;
  // Upstream / routed model id. For gateway models this is the
  // target-qualified id, e.g. "bedrock-mantle/openai.gpt-oss-120b".
  modelId: string;
  // Where inference is served.
  inferenceProvider: InferenceProvider;
  // --- Part 5: gateway-routed model fields (only when inferenceProvider === "AgentCore Gateway") ---
  // The inference target this model routes to (derived from the modelId prefix).
  targetName?: string;
  // The LLM gateway's /inference/v1 base URL.
  gatewayBaseUrl?: string;
  // Which inference API the target accepts.
  inferenceApi?: InferenceApi;
  createdAt: string;
}

// ---------- Part 5: Model Governance (LLM gateway) ----------
// An inference target is a model provider the LLM gateway routes to.
export type TargetSource = "Connector" | "Custom";
export type TargetStatus = "READY" | "CREATING" | "FAILED";
export type OutboundAuth = "IAM Role" | "API key" | "OAuth";

export interface InferenceTarget {
  id: ID;
  name: string; // e.g. "bedrock-mantle", "fast-tier"
  description: string;
  status: TargetStatus;
  source: TargetSource;
  // Connector name when source=Connector (e.g. "Bedrock Mantle").
  connector?: string;
  // Custom target config.
  endpoint?: string; // e.g. https://bedrock-mantle.us-east-1.api.aws
  apiPath?: string; // e.g. /v1/responses
  models?: string[]; // allowlist, e.g. ["openai.gpt-oss-20b"]
  passthrough: boolean;
  outboundAuth: OutboundAuth;
  createdAt: string;
}

// Rate limits: dimensions (ordered) + entries (per-dimension values + metrics).
export type DimensionType =
  | "Target"
  | "Tool"
  | "Model"
  | "OAuth Claim"
  | "IAM Principal ARN"
  | "IAM source Identity";

export type MetricPeriod = "Second" | "Minute";

export interface RateLimitDimension {
  type: DimensionType;
  // For OAuth Claim, the claim key (e.g. "sub").
  oauthKey?: string;
}

// A per-dimension condition value in an entry: either a specific value or the
// per- wildcard (All).
export interface EntryCondition {
  // undefined = wildcard (All).
  value?: string;
}

export interface RateLimitEntry {
  id: ID;
  // One condition per dimension (ordered to match the limit's dimensions).
  conditions: EntryCondition[];
  // Metrics (null = not set). Request applies to all; Token = inference only
  // (per-minute); Connection per-second.
  requestRate: number | null;
  requestPeriod: MetricPeriod;
  tokenRate: number | null; // per minute
  connectionRate: number | null; // per second
}

export interface RateLimit {
  id: ID;
  name: string;
  description: string;
  dimensions: RateLimitDimension[];
  entries: RateLimitEntry[];
  createdAt: string;
  updatedAt: string;
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


// ---------- Multi-Agent Workflows (real execution on Bedrock) ----------
// A workflow is an ordered set of steps; each step is an agent (prompt + model)
// that runs on Bedrock, optionally gated by human review.

export interface WorkflowStep {
  id: ID;
  name: string; // e.g. "Researcher"
  modelId: ID; // catalog model id to run this step with
  prompt: string; // the step's instruction/system prompt
  toolRefs: ID[];
  knowledgeRefs: ID[];
  reviewGate: boolean; // pause after this step for human approve/revise/deny
}

export interface Workflow {
  id: ID;
  name: string;
  description: string;
  tenantId: ID;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export type StepRunStatus =
  | "pending"
  | "running"
  | "awaiting-review"
  | "approved"
  | "revised"
  | "denied"
  | "done"
  | "error";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface StepRun {
  stepId: ID;
  name: string;
  status: StepRunStatus;
  output: string; // actual Bedrock text, possibly human-revised
  modelId: string; // resolved upstream model id actually invoked
  usage: TokenUsage | null;
  latencyMs: number | null;
  costUsd: number | null;
  reviewGate: boolean;
  reviewer?: string;
  reviewNote?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export type WorkflowRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "denied"
  | "error";

export interface WorkflowRun {
  id: ID;
  workflowId: ID;
  workflowName: string;
  tenantId: ID;
  status: WorkflowRunStatus;
  input: string;
  steps: StepRun[];
  currentStep: number;
  totalCostUsd: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
}
