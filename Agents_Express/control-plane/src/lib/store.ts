// In-memory data store for the control plane.
// Runs locally with no AWS dependency. A module-level singleton persists
// across requests within a single `next dev` / `next start` process.
//
// To wire to real AgentCore later, replace these arrays with calls to the
// AgentCore control APIs (list-gateways, list-agent-runtimes, Verified
// Permissions, etc.) behind the same function signatures.

// Type-only import: these are all interfaces/aliases, so importing them as
// types keeps the module loadable by Node's strip-only TypeScript loader (used
// by `npm test`) as well as by the Next.js build.
import type {
  AgentConfig,
  AuditEvent,
  CatalogModel,
  CognitoGroup,
  InferenceTarget,
  LibraryPolicy,
  ModelProvider,
  ModelRoute,
  Persona,
  Policy,
  PolicyEngine,
  PolicyStore,
  RateLimit,
  Registry,
  RegistryRecord,
  Tenant,
  TenantNodeType,
  TenantTier,
  Workflow,
  WorkflowRun,
} from "./types";
import { normalizeAgentCompute } from "./runtimes";
import { recoverInterruptedRuns } from "./workflow/recover";
import {
  SCHEMA_VERSION,
  capLog,
  createPersister,
  flushOnExit,
  loadSnapshot,
  storePath,
  trackChanges,
  type Persister,
} from "./persist";

export interface Store {
  tenants: Tenant[];
  registries: Registry[];
  records: RegistryRecord[];
  models: CatalogModel[];
  inferenceTargets: InferenceTarget[];
  rateLimits: RateLimit[];
  agents: AgentConfig[];
  policies: Policy[];
  personas: Persona[];
  cognitoGroups: CognitoGroup[];
  libraryPolicies: LibraryPolicy[];
  policyEngines: PolicyEngine[];
  policyStores: PolicyStore[];
  providers: ModelProvider[];
  routes: ModelRoute[];
  workflows: Workflow[];
  workflowRuns: WorkflowRun[];
  audit: AuditEvent[];
}

function iso(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

// Builds the real Takeda organizational hierarchy as a tenant tree.
// Root org → Business Units + Functions → sub-units. Tier/isolation reflect
// sensitivity: regulated/clinical BUs lean Pro/silo; shared functions Basic/pool.
function takedaOrgTree(): Tenant[] {
  const out: Tenant[] = [];
  const mk = (
    id: string,
    tenantName: string,
    type: TenantNodeType,
    parentId: string | null,
    tier: TenantTier
  ): void => {
    out.push({
      id,
      tenantId: id,
      tenantName,
      parentId,
      type,
      tier,
      isolation: tier === "pro" ? "silo" : "pool",
      resourcePool: tier === "pro" ? `dedicated-${id}` : "shared-pool-01",
      createdAt: iso(6),
      updatedAt: iso(1),
    });
  };

  // Root
  mk("takeda", "Takeda", "org", null, "pro");

  // ---- Business Units ----
  mk("bu-us", "U.S. Business Unit", "bu", "takeda", "pro");
  mk("bu-us-hr", "U.S. Human Resources", "subunit", "bu-us", "basic");

  mk("bu-intl", "International Business Unit", "bu", "takeda", "pro");

  mk("bu-japan", "Japan Pharma Business Unit", "bu", "takeda", "pro");
  mk("bu-japan-hr", "Human Resources", "subunit", "bu-japan", "basic");
  mk("bu-japan-ddt", "DD&T", "subunit", "bu-japan", "pro");

  mk("bu-oncology", "Oncology Business Unit", "bu", "takeda", "pro");
  mk("bu-onc-us", "US Oncology BU", "subunit", "bu-oncology", "pro");
  mk("bu-onc-eucan", "EUCAN Oncology BU", "subunit", "bu-oncology", "pro");
  mk("bu-onc-japan", "Japan Oncology BU", "subunit", "bu-oncology", "pro");

  mk("bu-plasma", "Plasma-Derived Therapies Business Unit", "bu", "takeda", "pro");
  mk("bu-plasma-biolife", "BioLife", "subunit", "bu-plasma", "pro");
  mk("bu-plasma-opu", "Plasma OpU", "subunit", "bu-plasma", "basic");

  // ---- Global Functions ----
  mk("fn-rnd", "Research & Development", "function", "takeda", "pro");
  mk("fn-rnd-research", "Research", "subunit", "fn-rnd", "pro");
  mk("fn-rnd-spd", "Strategy & Portfolio Development", "subunit", "fn-rnd", "basic");

  mk("fn-medical", "Global Medical", "function", "takeda", "pro");
  mk("fn-supply", "Global Supply & Quality", "function", "takeda", "pro");

  mk("fn-ddt", "Data, Digital & Technology", "function", "takeda", "pro");
  mk("fn-ddt-bf", "DD&T Business Facing & Partners", "subunit", "fn-ddt", "pro");

  mk("fn-finance", "Global Finance", "function", "takeda", "basic");
  mk("fn-procurement", "Global Procurement", "subunit", "fn-finance", "basic");
  mk("fn-realestate", "Global Real Estate and Facilities", "subunit", "fn-finance", "basic");

  mk("fn-hr", "Global Human Resources", "function", "takeda", "basic");
  mk("fn-hr-support", "mySupportHub", "subunit", "fn-hr", "basic");
  mk("fn-hr-rewards", "Total Rewards: Pay & Benefits", "subunit", "fn-hr", "basic");

  mk("fn-legal", "Global Legal, Ethics & Compliance", "function", "takeda", "pro");
  mk("fn-comms", "Global Communications & Governance", "function", "takeda", "basic");
  mk("fn-comms-communications", "Global Communications", "subunit", "fn-comms", "basic");
  mk("fn-comms-governance", "Governance", "subunit", "fn-comms", "basic");

  mk("fn-transformation", "Transformation Office", "function", "takeda", "basic");

  return out;
}

function seed(): Store {
  return {
    tenants: takedaOrgTree(),
    registries: [
      {
        id: "registry-anycompany",
        name: "AnyCompany_Registry",
        description:
          "Catalog of agents, MCP servers, and tools approved for production use in AnyCompany",
        autoApproval: false,
        createdAt: iso(4),
      },
    ],
    records: [
      {
        id: "rec-aws-knowledge-mcp",
        registryId: "registry-anycompany",
        name: "AWSKnowledgeMCP",
        description: "AWS knowledge MCP server",
        recordSource: "synchronize-from-endpoint",
        type: "MCP",
        credentialType: "No authorization",
        // Ends the workshop in Draft (only expense_tool is approved).
        status: "Draft",
        endpoint: "https://knowledge-mcp.global.api.aws",
        // Auto-discovered from the live endpoint over MCP.
        tools: [
          "aws___search_documentation",
          "aws___read_documentation",
          "aws___recommend",
        ],
        owner: "platform-team",
        createdAt: iso(4),
      },
      {
        id: "rec-expense-tool",
        registryId: "registry-anycompany",
        name: "expense_tool",
        description: "AnyCompany Expense Tool",
        recordSource: "define-manually",
        type: "Custom",
        credentialType: "IAM Role",
        status: "Approved",
        mcpSchema: {
          name: "ExpenseTools",
          version: "1.0.0",
          lambdaArn:
            "arn:aws:lambda:us-east-1:899561148374:function:AgenticAiWorkshop-ExpenseToolsFn",
          toolSchema: [
            {
              name: "submitExpense",
              description:
                "Submit a new expense report on behalf of the calling employee. The caller's identity is injected by the gateway and does not need to be provided by the agent.",
              inputSchema: {
                type: "object",
                required: ["amount", "category", "description"],
                properties: {
                  amount: { type: "number", description: "Amount in USD. Must be a positive number." },
                  category: { type: "string", description: "Expense category, e.g. travel, meals, supplies." },
                  description: { type: "string", description: "Brief description of the expense." },
                },
              },
            },
            {
              name: "listMyExpenses",
              description:
                "List all expenses submitted by the calling employee, most recent first. Caller identity is injected by the gateway.",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "listTeamExpenses",
              description:
                "List all expenses across the team, most recent first. Authorization to view team-wide data is enforced upstream — typically restricted to managers and finance.",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "approveExpense",
              description:
                "Approve a pending expense report by ID. The Lambda evaluates an Amazon Verified Permissions policy before approving — the caller's group membership and the expense's amount and submitter are passed to AVP for the decision.",
              inputSchema: {
                type: "object",
                required: ["expenseId"],
                properties: {
                  expenseId: { type: "string", description: "The expense ID to approve, e.g. exp_001." },
                },
              },
            },
            {
              name: "rejectExpense",
              description:
                "Reject a pending expense report with a reason. Used when an expense does not meet policy.",
              inputSchema: {
                type: "object",
                required: ["expenseId", "reason"],
                properties: {
                  expenseId: { type: "string", description: "The expense ID to reject, e.g. exp_001." },
                  reason: { type: "string", description: "Free-text reason explaining why the expense is being rejected." },
                },
              },
            },
          ],
        },
        tools: [
          "submitExpense",
          "listMyExpenses",
          "listTeamExpenses",
          "approveExpense",
          "rejectExpense",
        ],
        owner: "finance-platform",
        createdAt: iso(4),
      },
      {
        id: "rec-kb-bedrock-policies",
        registryId: "registry-anycompany",
        name: "CorporatePolicies_KB",
        description: "Corporate expense & travel policies (Bedrock Knowledge Base).",
        recordSource: "define-manually",
        type: "Knowledge Base",
        credentialType: "IAM Role",
        status: "Approved",
        knowledgeConfig: {
          provider: "Bedrock Knowledge Base",
          connection: { knowledgeBaseId: "KB1A2B3C4D", region: "us-east-1" },
          retrieval: { topK: 5, scoreThreshold: 0.4, mode: "hybrid", citations: true },
          residencyRegion: "us-east-1",
        },
        tools: [],
        owner: "platform-team",
        createdAt: iso(3),
      },
      {
        id: "rec-kb-databricks-clinical",
        registryId: "registry-anycompany",
        name: "ClinicalTrials_VectorSearch",
        description:
          "Clinical trial documents via Databricks Vector Search (Unity Catalog governed).",
        recordSource: "define-manually",
        type: "Knowledge Base",
        credentialType: "OAuth client",
        // Draft on purpose — demonstrates approved-only gating for KBs too.
        status: "Draft",
        knowledgeConfig: {
          provider: "Databricks Vector Search",
          connection: {
            endpoint: "https://dbc-xxxx.cloud.databricks.com",
            indexName: "clinical.docs_index",
            unityCatalog: "rnd.clinical",
          },
          retrieval: { topK: 8, scoreThreshold: 0.5, mode: "semantic", citations: true },
          residencyRegion: "eu-west-1",
        },
        tools: [],
        owner: "fn-rnd",
        createdAt: iso(2),
      },
    ],
    models: [
      {
        id: "model-claude-opus-46",
        name: "Claude Opus 4.6",
        modelProvider: "Anthropic",
        modelId: "global.anthropic.claude-opus-4-6-v1:0",
        inferenceProvider: "Amazon Bedrock",
        createdAt: iso(3),
      },
      {
        id: "model-gpt-oss-120b",
        name: "GPT-OSS 120B",
        modelProvider: "Custom: OpenAI",
        modelId: "bedrock-mantle/openai.gpt-oss-120b",
        inferenceProvider: "AgentCore Gateway",
        targetName: "bedrock-mantle",
        gatewayBaseUrl:
          "https://llm-gateway-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
        inferenceApi: "Responses API (/v1/responses)",
        createdAt: iso(1),
      },
      {
        id: "model-gpt-oss-20b",
        name: "GPT-OSS 20B",
        modelProvider: "Custom: OpenAI",
        modelId: "fast-tier/openai.gpt-oss-20b",
        inferenceProvider: "AgentCore Gateway",
        targetName: "fast-tier",
        gatewayBaseUrl:
          "https://llm-gateway-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
        inferenceApi: "Responses API (/v1/responses)",
        createdAt: iso(1),
      },
      {
        // The one catalog model in this seed that REALLY EXECUTES. The Bedrock
        // and AgentCore Gateway entries above are illustrative: their model
        // identifiers are not provisioned in every account, so an agent bound
        // to them fails with "The provided model identifier is invalid."
        //
        // This endpoint is a Databricks Foundation Model API, verified live in
        // this workspace. It exists in the seed because the store is in-memory:
        // a restart wipes anything created through the console, and a demo that
        // has to be hand-rebuilt after every restart is not a demo.
        id: "model-dbx-llama-70b",
        name: "Llama 3.3 70B Instruct (Databricks)",
        modelProvider: "Custom: Meta",
        modelId: "databricks-meta-llama-3-3-70b-instruct",
        inferenceProvider: "Databricks Model Serving",
        createdAt: iso(1),
      },
    ],
    inferenceTargets: [
      {
        id: "target-bedrock-mantle",
        name: "bedrock-mantle",
        description: "Pre-deployed broad connector — every model Bedrock Mantle serves.",
        status: "READY",
        source: "Connector",
        connector: "Bedrock Mantle",
        passthrough: false,
        outboundAuth: "IAM Role",
        createdAt: iso(3),
      },
      {
        id: "target-fast-tier",
        name: "fast-tier",
        description: "Low-cost tier, allowlisted to one model",
        status: "READY",
        source: "Custom",
        endpoint: "https://bedrock-mantle.us-east-1.api.aws",
        apiPath: "/v1/responses",
        models: ["openai.gpt-oss-20b"],
        passthrough: false,
        outboundAuth: "IAM Role",
        createdAt: iso(1),
      },
    ],
    rateLimits: [],
    agents: [
      {
        id: "agent-expense-assistant",
        name: "Expense Assistant",
        description: "AnyCompany internal expense assistant",
        tenantId: "fn-finance",
        modelId: "model-claude-opus-46",
        systemPrompt:
          "You are the AnyCompany Expense Assistant. Help employees submit, list, approve, and reject expense reports using the available tools. \n\nIf a tool returns a \"forbidden\" or denial response, explain plainly that the caller does not have permission.",
        // Only the APPROVED expense_tool record is attachable; AWSKnowledgeMCP
        // stayed in Draft so it cannot be wired into the agent.
        memoryRefs: [],
        toolRefs: ["rec-expense-tool"],
        knowledgeRefs: ["rec-kb-bedrock-policies"],
        compute: {
          agentRuntimeId: "aws-agentcore-runtime",
          modelRuntimeId: "aws-bedrock",
        },
        visibility: "public",
        status: "ready",
        createdAt: iso(3),
      },
      // ----------------------------------------------------------------- //
      // The Sales ⇄ Supply Chain scenario, seeded so it survives a restart.
      //
      // Both are `ready`, which is what makes them ADDRESSABLE over inbound
      // A2A: lib/a2a/server.ts advertises only ready agents as skills, and
      // the skill id is the agent id. Both run on Databricks against the one
      // model identifier in this catalog that is really provisioned.
      //
      // They are deliberately on DIFFERENT tenants — Commercial and Global
      // Supply & Quality — because a cross-tenant hand-off is the only version
      // of this scenario where the governance does any work. Same-tenant
      // agents calling each other would pass every check trivially.
      // ----------------------------------------------------------------- //
      {
        id: "agent-sales-demand",
        name: "Sales Agent",
        description:
          "Commercial demand-and-supply agent. Owns order commitments, customer " +
          "promise dates, and demand signals; asks Supply Chain for feasibility.",
        tenantId: "bu-us",
        modelId: "model-dbx-llama-70b",
        systemPrompt:
          "You are the Sales Agent for the U.S. Business Unit. You own customer " +
          "orders, promised dates, and demand signals.\n\n" +
          "You do NOT own inventory, production capacity, or logistics — when an " +
          "answer depends on those, say so explicitly and state what you need " +
          "from the Supply Chain Agent rather than estimating it yourself.\n\n" +
          "Be concrete and short. Quote order ids and dates exactly as given. " +
          "Never invent an inventory level, a lead time, or a shipment status.",
        memoryRefs: [],
        toolRefs: [],
        knowledgeRefs: [],
        compute: {
          agentRuntimeId: "databricks-agent-runtime",
          modelRuntimeId: "databricks-fm-api-pay-per-token",
        },
        visibility: "public",
        status: "ready",
        createdAt: iso(1),
      },
      {
        id: "agent-supply-chain",
        name: "Supply Chain Agent",
        description:
          "Global Supply & Quality agent. Owns inventory positions, production " +
          "capacity, lead times and logistics feasibility for a requested date.",
        tenantId: "fn-supply",
        modelId: "model-dbx-llama-70b",
        systemPrompt:
          "You are the Supply Chain Agent for Global Supply & Quality. You own " +
          "inventory positions, production capacity, lead times and logistics.\n\n" +
          "When asked whether a date can be met, answer in this order: (1) the " +
          "verdict — feasible, feasible with a caveat, or not feasible; (2) the " +
          "constraint that decides it; (3) the earliest date you can commit to.\n\n" +
          "You do NOT own the customer relationship or the commercial decision — " +
          "do not promise anything to a customer. If you have not been given a " +
          "figure, say it is missing instead of assuming one.",
        memoryRefs: [],
        toolRefs: [],
        knowledgeRefs: [],
        compute: {
          agentRuntimeId: "databricks-agent-runtime",
          modelRuntimeId: "databricks-fm-api-pay-per-token",
        },
        visibility: "public",
        status: "ready",
        createdAt: iso(1),
      },
    ],
    policies: [
      {
        id: "pol-gw-query-graph",
        name: "Gateway: authenticated personas may query graph sources",
        layer: "gateway",
        description:
          "Demo perimeter policy for the OMDA router. Production scopes this by tenant, BU, and graph source.",
        enabled: true,
        createdAt: iso(0),
        cedar: `permit(
  principal,
  action == Action::"queryGraphSource",
  resource == Tool::"omda"
);`,
      },
      {
        id: "pol-gw-kg-build-perimeter",
        name: "Gateway: authenticated personas may build knowledge graphs",
        layer: "gateway",
        description:
          "Knowledge-graph WRITE perimeter. The only write path in the platform (lib/kg/materialize.ts) \u2014 the query path stays read-only. Scope one source by adding a policy naming Tool::\"kg:<graphSourceId>\".",
        enabled: true,
        createdAt: iso(0),
        cedar: `permit(
  principal,
  action == Action::"buildKnowledgeGraph",
  resource == Tool::"kg"
);`,
      },
      {
        id: "pol-gw-run-agent-perimeter",
        name: "Gateway: authenticated personas may run agents in workflows",
        layer: "gateway",
        description:
          "Workflow perimeter. Stage 1 of the two-stage check in lib/workflow/govern.ts — grants the right to execute a workflow step AS a registered agent. Scope a single agent by adding a policy naming Tool::\"workflow:<agentId>\".",
        enabled: true,
        createdAt: iso(0),
        cedar: `permit(
  principal,
  action == Action::"runAgent",
  resource == Tool::"workflow"
);`,
      },
      {
        id: "pol-gw-kb-perimeter",
        name: "Gateway: authenticated personas may query knowledge bases",
        layer: "gateway",
        description:
          "RAG perimeter. Stage 1 of the two-stage check in lib/kb/service.ts — grants use of the retrieval path, not access to any particular KB. Scope a single KB by adding a policy naming Tool::\"kb:<recordId>\".",
        enabled: true,
        createdAt: iso(0),
        cedar: `permit(
  principal,
  action == Action::"queryKnowledgeBase",
  resource == Tool::"kb"
);`,
      },
      {
        id: "pol-gw-memory-perimeter",
        name: "Gateway: authenticated personas may use agent memory",
        layer: "gateway",
        description:
          "Memory perimeter. Stage 1 of the two-stage check in lib/memory/logic.ts — grants use of the recall path, not access to any particular memory. Scope one memory by adding a policy naming Tool::\"memory:<recordId>\". Note that the namespace, not this policy, is what isolates one tenant's records from another's: the policy decides whether recall may happen at all.",
        enabled: true,
        createdAt: iso(0),
        cedar: `permit(
  principal,
  action == Action::"useMemory",
  resource == Tool::"memory"
);`,
      },
      {
        id: "pol-gw-a2a-perimeter",
        name: "Gateway: authenticated personas may use A2A",
        layer: "gateway",
        description:
          "A2A perimeter. Stage 1 of the two-stage check in lib/a2a/logic.ts — grants access to the A2A client itself, not to any particular peer.",
        enabled: true,
        createdAt: iso(0),
        cedar: `permit(
  principal,
  action == Action::"callAgent",
  resource == Tool::"a2a"
);`,
      },
      {
        id: "pol-gw-a2a-sales-mgr",
        name: "Gateway: Managers may call the Sales peer agent",
        layer: "gateway",
        description:
          "Peer-scoped 'who may call whom'. Naming Tool::\"a2a:sales-agent\" makes this peer's rules authoritative, so a persona without a matching permit is denied even though the perimeter allowed it.",
        enabled: true,
        createdAt: iso(0),
        cedar: `permit(
  principal,
  action == Action::"callAgent",
  resource == Tool::"a2a:sales-agent"
) when { principal.role == "manager" };`,
      },
      {
        id: "pol-gw-a2a-sales-dir",
        name: "Gateway: Directors may call the Sales peer agent",
        layer: "gateway",
        description:
          "Companion to the Manager rule — the evaluator ANDs conditions within one policy, so each role is granted by its own policy.",
        enabled: true,
        createdAt: iso(0),
        cedar: `permit(
  principal,
  action == Action::"callAgent",
  resource == Tool::"a2a:sales-agent"
) when { principal.role == "director" };`,
      },
      {
        id: "pol-gw-allow-ic-list",
        name: "Gateway: ICs may list/submit own expenses",
        layer: "gateway",
        description:
          "expense_ic — at the gateway, permit listMyExpenses for Individual Contributors.",
        enabled: true,
        createdAt: iso(2),
        cedar: `permit(
  principal,
  action == Action::"invokeTool",
  resource == Tool::"listMyExpenses"
) when { principal.role == "ic" };`,
      },
      {
        id: "pol-gw-allow-ic-submit",
        name: "Gateway: ICs may submit expenses",
        layer: "gateway",
        description:
          "expense_ic — at the gateway, permit submitExpense for Individual Contributors.",
        enabled: true,
        createdAt: iso(2),
        cedar: `permit(
  principal,
  action == Action::"invokeTool",
  resource == Tool::"submitExpense"
) when { principal.role == "ic" };`,
      },
      {
        id: "pol-gw-allow-mgr-approve",
        name: "Gateway: Managers may approve",
        layer: "gateway",
        description:
          "expense_above_manager — permit approveExpense for Managers (amount checked by AVP).",
        enabled: true,
        createdAt: iso(1),
        cedar: `permit(
  principal,
  action == Action::"invokeTool",
  resource == Tool::"approveExpense"
) when { principal.role == "manager" };`,
      },
      {
        id: "pol-gw-allow-dir-approve",
        name: "Gateway: Directors may approve",
        layer: "gateway",
        description:
          "expense_above_manager — permit approveExpense for Directors.",
        enabled: true,
        createdAt: iso(1),
        cedar: `permit(
  principal,
  action == Action::"invokeTool",
  resource == Tool::"approveExpense"
) when { principal.role == "director" };`,
      },
      {
        id: "pol-avp-mgr-budget",
        name: "AVP: approve_manager (≤ $5,000)",
        layer: "avp",
        description:
          "Inside the Lambda, Managers may approve only when amount <= 5000.",
        enabled: true,
        createdAt: iso(1),
        cedar: `permit(
  principal,
  action == Action::"approveExpense",
  resource
) when { principal.role == "manager" && resource.amount <= principal.approvalLimit };`,
      },
      {
        id: "pol-avp-dir-any",
        name: "AVP: approve_director (any amount)",
        layer: "avp",
        description: "Inside the Lambda, Directors may approve any amount.",
        enabled: true,
        createdAt: iso(1),
        cedar: `permit(
  principal,
  action == Action::"approveExpense",
  resource
) when { principal.role == "director" };`,
      },
    ],
    personas: [
      {
        id: "persona-john",
        name: "John Stiles",
        sub: "64287468-d091-70d4-4901-2b9f0a1b2c3d",
        email: "john_stiles@anycompany.com",
        provider: "AWS Cognito",
        groups: ["seniority_manager"],
        attributes: {
          group: "seniority_manager",
          role: "manager",
          approvalLimit: "5000",
        },
      },
      {
        id: "persona-mary",
        name: "Mary Major",
        sub: "74f864b8-5051-70d8-1d2e-3f4a5b6c7d8e",
        email: "mary_major@anycompany.com",
        provider: "AWS Cognito",
        groups: ["seniority_director"],
        attributes: {
          group: "seniority_director",
          role: "director",
          approvalLimit: "Infinity",
        },
      },
    ],
    cognitoGroups: [
      { name: "seniority_ic", description: "AnyCompany Individual Contributors" },
      { name: "seniority_manager", description: "AnyCompany Managers" },
      { name: "seniority_director", description: "AnyCompany Directors" },
    ],
    libraryPolicies: [
      {
        id: "lib-expense-ic",
        name: "expense_ic",
        description: "Expense Policy for Individual Contributors in AnyCompany",
        status: "Published",
        effect: "permit",
        creator: "admin@workshop.local",
        createdAt: iso(2),
        updatedAt: iso(1),
        versions: [
          {
            version: 1,
            nl: "Allow seniority_ic to perform listMyExpenses (Tool) at agent-platform-gateway (Gateway)",
            message: "Allow list my expense tool to individual contributors",
            author: "Workshop Admin",
            at: iso(2),
            cedar: `permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"expense-tool___listMyExpenses",
  resource == AgentCore::Gateway::"agent-platform-gateway"
)
when {
  principal.hasTag("cognito:groups") &&
  principal.getTag("cognito:groups") like "*seniority_ic*"
};`,
          },
          {
            version: 2,
            nl: "Allow seniority_ic to perform listMyExpenses (Tool) and submitExpense (Tool) at agent-platform-gateway (Gateway)",
            message: "Added submit expense tool to individual contributors",
            author: "Workshop Admin",
            at: iso(1),
            cedar: `permit(
  principal is AgentCore::OAuthUser,
  action in [
    AgentCore::Action::"expense-tool___listMyExpenses",
    AgentCore::Action::"expense-tool___submitExpense"
  ],
  resource == AgentCore::Gateway::"agent-platform-gateway"
)
when {
  principal.hasTag("cognito:groups") &&
  principal.getTag("cognito:groups") like "*seniority_ic*"
};`,
          },
        ],
        activity: [
          {
            kind: "version",
            version: 2,
            message: "Added submit expense tool to individual contributors",
            author: "Workshop Admin",
            at: iso(1),
          },
          {
            kind: "version",
            version: 1,
            message: "Allow list my expense tool to individual contributors",
            author: "Workshop Admin",
            at: iso(2),
          },
          {
            kind: "created",
            message: "Policy created as initial draft",
            author: "Workshop Admin",
            at: iso(2),
          },
        ],
      },
      {
        id: "lib-expense-above-manager",
        name: "expense_above_manager",
        description: "Expense Policy for Managers and Directors in AnyCompany",
        status: "Published",
        effect: "permit",
        creator: "admin@workshop.local",
        createdAt: iso(1),
        updatedAt: iso(1),
        versions: [
          {
            version: 1,
            nl: "Allow seniority_manager and seniority_director to perform submitExpense (Tool), listMyExpenses (Tool), listTeamExpenses (Tool), approveExpense (Tool), rejectExpense (Tool) at agent-platform-gateway (Gateway)",
            message: "Grant full access of expense tool for managers and directors",
            author: "Workshop Admin",
            at: iso(1),
            cedar: `permit(
  principal is AgentCore::OAuthUser,
  action in [
    AgentCore::Action::"expense-tool___submitExpense",
    AgentCore::Action::"expense-tool___listMyExpenses",
    AgentCore::Action::"expense-tool___listTeamExpenses",
    AgentCore::Action::"expense-tool___approveExpense",
    AgentCore::Action::"expense-tool___rejectExpense"
  ],
  resource == AgentCore::Gateway::"agent-platform-gateway"
)
when {
  principal.hasTag("cognito:groups") &&
  (
    principal.getTag("cognito:groups") like "*seniority_manager*" ||
    principal.getTag("cognito:groups") like "*seniority_director*"
  )
};`,
          },
        ],
        activity: [
          {
            kind: "version",
            version: 1,
            message: "Grant full access of expense tool for managers and directors",
            author: "Workshop Admin",
            at: iso(1),
          },
          {
            kind: "created",
            message: "Policy created as initial draft",
            author: "Workshop Admin",
            at: iso(1),
          },
        ],
      },
    ],
    policyEngines: [
      {
        id: "engine-anycompany",
        name: "anycompany_policy_engine",
        description: "Policy engine for AnyCompany internal tools",
        status: "Active",
        region: "us-east-1",
        awsEngineId: "anycompany_policy_engine-A1b2C3",
        awsEngineArn:
          "arn:aws:bedrock-agentcore:us-east-1:899561148374:policy-engine/anycompany_policy_engine-A1b2C3",
        importedPolicies: [
          {
            policyId: "lib-expense-ic",
            name: "expense_ic",
            type: "permit",
            synced: true,
            lastSynced: iso(0),
          },
          {
            policyId: "lib-expense-above-manager",
            name: "expense_above_manager",
            type: "permit",
            synced: true,
            lastSynced: iso(0),
          },
        ],
        gateways: [
          {
            gatewayId: "agent-platform-gateway",
            name: "agent-platform-gateway",
            mode: "Enforce",
          },
        ],
        syncHistory: [
          {
            id: "sync-1",
            scope: "Engine",
            action: "policy_sync",
            target: "—",
            result: "Success",
            actor: "Workshop Admin",
            at: iso(0),
          },
          {
            id: "sync-2",
            scope: "Gateway",
            action: "gateway_attach",
            target: "—",
            result: "Success",
            actor: "Workshop Admin",
            at: iso(0),
          },
          {
            id: "sync-3",
            scope: "Engine",
            action: "engine_create",
            target: "—",
            result: "Success",
            actor: "Workshop Admin",
            at: iso(0),
          },
        ],
        createdAt: iso(1),
        updatedAt: iso(0),
      },
    ],
    policyStores: [
      {
        id: "store-anycompany",
        name: "anycompany_agent_policy",
        description: "AnyCompany's agent policy store",
        status: "Active",
        region: "us-east-1",
        namespace: "AnyCompany",
        policyStoreId: "LDb1ABC2def3GHI4jkl",
        schema: `{
  "AnyCompany": {
    "actions": {
      "approveExpense": {
        "appliesTo": {
          "resourceTypes": ["Expense"],
          "principalTypes": ["User"]
        }
      }
    },
    "entityTypes": {
      "User": { "memberOfTypes": ["Group"] },
      "Group": {},
      "Expense": {
        "shape": {
          "type": "Record",
          "attributes": {
            "amount": { "type": "Long" },
            "status": { "type": "String" },
            "submitterEmail": { "type": "String" }
          }
        }
      }
    }
  }
}`,
        policies: [
          {
            id: "store-approve-director",
            name: "approve_director",
            type: "permit",
            status: "Published",
            cedar: `permit (
  principal in AnyCompany::Group::"seniority_director",
  action == AnyCompany::Action::"approveExpense",
  resource
);`,
          },
          {
            id: "store-approve-manager",
            name: "approve_manager",
            type: "permit",
            status: "Published",
            cedar: `permit (
  principal in AnyCompany::Group::"seniority_manager",
  action == AnyCompany::Action::"approveExpense",
  resource
)
when {
  resource.amount <= 5000
};`,
          },
        ],
        syncHistory: [
          {
            id: "avp-sync-1",
            scope: "Schema",
            action: "schema_sync",
            target: "AnyCompany",
            result: "Success",
            actor: "seed",
            at: iso(2),
          },
          {
            id: "avp-sync-2",
            scope: "Policy",
            action: "policy_sync",
            target: "approve_director",
            result: "Success",
            actor: "seed",
            at: iso(2),
          },
          {
            id: "avp-sync-3",
            scope: "Policy",
            action: "policy_sync",
            target: "approve_manager",
            result: "Success",
            actor: "seed",
            at: iso(2),
          },
        ],
      },
    ],
    providers: [
      {
        id: "prov-bedrock",
        name: "Amazon Bedrock",
        kind: "bedrock",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        rateLimitRpm: 600,
        enabled: true,
      },
      {
        id: "prov-openai",
        name: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        rateLimitRpm: 200,
        enabled: false,
      },
    ],
    routes: [
      {
        id: "route-claude-opus",
        alias: "claude-opus",
        providerId: "prov-bedrock",
        upstreamModelId: "us.anthropic.claude-opus-4-1-20250805-v1:0",
        monthlyTokenBudget: 5_000_000,
        enabled: true,
      },
      {
        id: "route-claude-haiku",
        alias: "claude-haiku",
        providerId: "prov-bedrock",
        upstreamModelId: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
        monthlyTokenBudget: null,
        enabled: true,
      },
    ],
    workflows: [],
    workflowRuns: [],
    audit: [
      {
        id: "evt-1",
        category: "registry",
        action: "approve",
        actor: "platform-team",
        detail: "Approved record 'expense_tool' in AnyCompany_Registry",
        at: iso(4),
      },
      {
        id: "evt-2",
        category: "agent",
        action: "create",
        actor: "admin@workshop.local",
        detail: "Created agent 'Expense Assistant'",
        at: iso(3),
      },
      {
        id: "evt-3",
        category: "policy",
        action: "publish",
        actor: "Workshop Admin",
        detail: "Published policy 'expense_ic' (v2) to anycompany_policy_engine",
        at: iso(1),
      },
      {
        id: "evt-4",
        category: "policy",
        action: "gateway-attach",
        actor: "Workshop Admin",
        detail: "Attached agent-platform-gateway (Enforce) to anycompany_policy_engine",
        at: iso(0),
      },
    ],
  };
}

// --------------------------------------------------------------------------- //
// The singleton, now DURABLE
// --------------------------------------------------------------------------- //
//
// Three layers, in order:
//   1. globalThis — survives `next dev` hot-reloads within one process
//   2. a JSON snapshot on disk — survives a restart
//   3. seed() — a genuinely fresh install, or a snapshot we refuse to trust
//
// Reads stay synchronous and every existing mutation site is untouched: the
// store is wrapped in a change-tracking Proxy, so `store.agents.unshift(a)`
// and `record.status = "Approved"` mark it dirty by themselves. See
// lib/persist.ts for why that is a Proxy rather than ~40 `persist()` calls.
const globalForStore = globalThis as unknown as {
  __cpStore?: Store;
  __cpPersister?: Persister;
};

/** Audit entries kept. Unbounded growth was a leak before persistence, and
 *  with it, an ever-growing file. Truncation is RECORDED, never silent. */
const MAX_AUDIT_ENTRIES = Number(process.env.CONTROL_PLANE_MAX_AUDIT || 5000);

function bootStore(): { state: Store; note: string } {
  const loaded = loadSnapshot<Store>();
  if (!loaded.state) return { state: seed(), note: loaded.reason };
  // A snapshot that parsed but is missing a collection this build expects
  // would throw on first access somewhere far away. Fill gaps from the seed
  // rather than trusting an under-specified file.
  const fresh = seed();
  const merged = { ...fresh, ...loaded.state } as Store;
  const restored: string[] = [];
  for (const key of Object.keys(fresh) as (keyof Store)[]) {
    if (!Array.isArray(merged[key])) {
      (merged[key] as unknown) = fresh[key];
      restored.push(key);
    }
  }
  const note = restored.length
    ? `${loaded.reason}; re-seeded missing collection(s): ${restored.join(", ")}`
    : loaded.reason;
  return { state: merged, note };
}

let bootNote = "";
if (!globalForStore.__cpStore) {
  const booted = bootStore();
  bootNote = booted.note;
  // Runs that were in flight when the process stopped have no promise left to
  // advance them. Marked here, on the RAW state before tracking starts, so
  // recovery itself does not count as a user mutation. Only restored state can
  // contain them — a fresh seed has no running runs.
  const recovery = recoverInterruptedRuns(booted.state.workflowRuns);
  if (recovery.interrupted.length > 0) {
    bootNote +=
      `; recovered ${recovery.interrupted.length} interrupted run(s): ` +
      recovery.interrupted
        .map((r) => `${r.workflowName}@step${r.stepIndex + 1}` +
          (r.mayHaveExecuted ? " (may have executed)" : ""))
        .join(", ");
  }
  globalForStore.__cpStore = booted.state;
}

const rawStore: Store = globalForStore.__cpStore!;

if (!globalForStore.__cpPersister) {
  const persister = createPersister<Store>({
    getState: () => rawStore,
    onEvent: (m) => console.warn(`[store] ${m}`),
  });
  flushOnExit(persister, (m) => console.log(`[store] ${m}`));
  globalForStore.__cpPersister = persister;
  console.log(`[store] ${bootNote}`);
}

const persister = globalForStore.__cpPersister!;

export const store: Store = trackChanges(rawStore, persister.markDirty);

/** Write any pending changes immediately. For shutdown paths and tests. */
export function flushStore(): void {
  persister.flush();
}

/** Snapshot diagnostics, surfaced by /api/governance. */
export function storeDurability() {
  const s = persister.stats();
  return {
    path: storePath(),
    schemaVersion: SCHEMA_VERSION,
    writes: s.writes,
    failures: s.failures,
    pendingWrite: s.dirty,
    bootNote,
  };
}

// Normalize agents retained across next dev hot-reloads from the legacy
// { runtime: "Bedrock AgentCore" } compute shape into the two-plane model.
for (const agent of store.agents) {
  agent.compute = normalizeAgentCompute(agent.compute);
}

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function logAudit(
  event: Omit<AuditEvent, "id" | "at">
): AuditEvent {
  // `tenantId` rides along when the caller knows it. Not required: a policy
  // edit or a catalog change is genuinely platform-level.
  const evt: AuditEvent = { ...event, id: newId("evt"), at: new Date().toISOString() };
  store.audit.unshift(evt);
  const dropped = capLog(store.audit, MAX_AUDIT_ENTRIES);
  if (dropped > 0) {
    // Dropping governance records silently would be the wrong kind of quiet.
    // One entry records the loss, so the log always accounts for itself.
    store.audit.unshift({
      id: newId("evt"),
      category: "policy",
      action: "audit-truncated",
      actor: "platform",
      detail:
        `Audit log reached ${MAX_AUDIT_ENTRIES} entries; dropped the ` +
        `${dropped} oldest. Raise CONTROL_PLANE_MAX_AUDIT to retain more.`,
      at: new Date().toISOString(),
    });
  }
  return evt;
}
