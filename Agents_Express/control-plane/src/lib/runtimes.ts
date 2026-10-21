// Runtime catalog for the two compute planes shown in the AI/ML ecosystem:
//  1. Agentic workload services run the agent process/server.
//  2. Model inference and fine-tuning services run or customize models.
//
// Runtime releases and accelerator SKUs change frequently, so this catalog
// models durable service/family choices rather than pinning transient versions.

export type RuntimePlane = "agentic-workload" | "model-inference";
export type RuntimeProvider = "AWS" | "Databricks";

export interface RuntimeOptionDefinition {
  id: string;
  plane: RuntimePlane;
  provider: RuntimeProvider;
  family: string;
  label: string;
  description: string;
  capabilities: readonly string[];
  recommended?: boolean;
}

export const RUNTIME_OPTIONS = [
  // Agentic Workload Services — AWS options mirror the supplied diagram.
  {
    id: "aws-agentcore-runtime",
    plane: "agentic-workload",
    provider: "AWS",
    family: "Managed agents",
    label: "Bedrock AgentCore Runtime",
    description: "Managed agent hosting with session isolation, scaling, identity, and tool execution.",
    capabilities: ["Managed", "Session isolation", "Autoscaling"],
    recommended: true,
  },
  {
    id: "aws-lambda",
    plane: "agentic-workload",
    provider: "AWS",
    family: "Serverless functions",
    label: "AWS Lambda",
    description: "Event-driven agent or tool execution for short-lived, stateless workloads.",
    capabilities: ["Serverless", "Event driven", "Scale to zero"],
  },
  {
    id: "aws-ecs",
    plane: "agentic-workload",
    provider: "AWS",
    family: "Containers",
    label: "Amazon ECS",
    description: "Containerized agents with managed scheduling on Fargate or EC2 capacity.",
    capabilities: ["Containers", "Fargate or EC2", "Long running"],
  },
  {
    id: "aws-eks",
    plane: "agentic-workload",
    provider: "AWS",
    family: "Kubernetes",
    label: "Amazon EKS",
    description: "Kubernetes-native agent services with portable orchestration and custom infrastructure controls.",
    capabilities: ["Kubernetes", "Portable", "Custom orchestration"],
  },

  // Agentic Workload Services — Databricks deployment surfaces.
  {
    id: "databricks-agent-runtime",
    plane: "agentic-workload",
    provider: "Databricks",
    family: "Managed agents",
    label: "Agent Runtime on Databricks Apps",
    description: "Recommended managed compute for production agents, including hosting, identity, and scaling.",
    capabilities: ["Managed", "Durable agent server", "Autoscaling"],
    recommended: true,
  },
  {
    id: "databricks-apps-custom",
    plane: "agentic-workload",
    provider: "Databricks",
    family: "Application hosting",
    label: "Databricks Apps — Custom Agent Server",
    description: "App-hosted agent with control over framework, server implementation, and deployment workflow.",
    capabilities: ["Custom server", "Git deployment", "Interactive APIs"],
  },
  {
    id: "databricks-lakeflow-jobs-agent",
    plane: "agentic-workload",
    provider: "Databricks",
    family: "Batch and scheduled",
    label: "Lakeflow Jobs",
    description: "Scheduled or event-triggered batch agent workflows integrated with workspace data and governance.",
    capabilities: ["Scheduled", "Batch", "Workflow orchestration"],
  },

  // Model Inference and Fine-Tuning Services — AWS options mirror the diagram.
  {
    id: "aws-bedrock",
    plane: "model-inference",
    provider: "AWS",
    family: "Managed foundation models",
    label: "Amazon Bedrock",
    description: "Serverless access to managed foundation models and model customization capabilities.",
    capabilities: ["Managed models", "Serverless inference", "Guardrails"],
    recommended: true,
  },
  {
    id: "aws-sagemaker-ai",
    plane: "model-inference",
    provider: "AWS",
    family: "Managed ML platform",
    label: "Amazon SageMaker AI",
    description: "Managed training, fine-tuning, endpoints, and MLOps for custom machine learning models.",
    capabilities: ["Training", "Fine-tuning", "Managed endpoints"],
  },
  {
    id: "aws-eks-models",
    plane: "model-inference",
    provider: "AWS",
    family: "Kubernetes model compute",
    label: "Amazon EKS",
    description: "Kubernetes-based inference and distributed training using custom model servers and accelerators.",
    capabilities: ["Kubernetes", "GPU and accelerators", "Custom serving"],
  },

  // Databricks managed inference.
  {
    id: "databricks-fm-api-pay-per-token",
    plane: "model-inference",
    provider: "Databricks",
    family: "Managed model serving",
    label: "Foundation Model APIs — Pay per token",
    description: "Ready-to-query foundation models with usage-based pricing and no endpoint capacity management.",
    capabilities: ["Serverless", "Foundation models", "Pay per token"],
    recommended: true,
  },
  {
    id: "databricks-fm-api-provisioned",
    plane: "model-inference",
    provider: "Databricks",
    family: "Managed model serving",
    label: "Foundation Model APIs — Provisioned throughput",
    description: "Dedicated production throughput for supported foundation models and predictable workloads.",
    capabilities: ["Dedicated capacity", "Foundation models", "Production SLA"],
  },
  {
    id: "databricks-custom-serving-cpu",
    plane: "model-inference",
    provider: "Databricks",
    family: "Managed model serving",
    label: "Custom Model Serving — CPU",
    description: "Managed real-time endpoints for MLflow models and CPU-oriented custom inference workloads.",
    capabilities: ["MLflow", "Custom models", "CPU"],
  },
  {
    id: "databricks-custom-serving-gpu",
    plane: "model-inference",
    provider: "Databricks",
    family: "Managed model serving",
    label: "Custom Model Serving — GPU",
    description: "Managed GPU endpoints for custom LLMs and other accelerator-backed inference workloads.",
    capabilities: ["Custom LLMs", "GPU", "Real-time inference"],
  },

  // Databricks serverless GPU training and fine-tuning.
  {
    id: "databricks-ai-runtime-standard",
    plane: "model-inference",
    provider: "Databricks",
    family: "AI Runtime — Serverless GPU",
    label: "AI Runtime — Standard environment",
    description: "Minimal serverless GPU environment for maximum dependency flexibility in deep-learning workloads.",
    capabilities: ["Serverless GPU", "Custom dependencies", "Training and fine-tuning"],
  },
  {
    id: "databricks-ai-runtime-ai",
    plane: "model-inference",
    provider: "Databricks",
    family: "AI Runtime — Serverless GPU",
    label: "AI Runtime — AI environment",
    description: "Full-featured serverless GPU environment preloaded with popular ML and deep-learning frameworks.",
    capabilities: ["Serverless GPU", "Preloaded frameworks", "Distributed training"],
    recommended: true,
  },

  // Databricks classic compute for ML/DL workloads.
  {
    id: "databricks-runtime-ml-cpu",
    plane: "model-inference",
    provider: "Databricks",
    family: "Databricks Runtime ML — Classic",
    label: "Runtime ML — CPU",
    description: "Classic compute with prebuilt machine-learning libraries for CPU-based training and batch inference.",
    capabilities: ["Classic compute", "Prebuilt ML libraries", "CPU"],
  },
  {
    id: "databricks-runtime-ml-gpu",
    plane: "model-inference",
    provider: "Databricks",
    family: "Databricks Runtime ML — Classic",
    label: "Runtime ML — GPU",
    description: "Classic GPU compute for ML and deep-learning workloads that are not yet using serverless AI Runtime.",
    capabilities: ["Classic compute", "GPU", "ML and DL libraries"],
  },
  {
    id: "databricks-runtime-ml-photon",
    plane: "model-inference",
    provider: "Databricks",
    family: "Databricks Runtime ML — Classic",
    label: "Runtime ML — Photon enabled",
    description: "Runtime ML with Photon acceleration for SQL, DataFrames, and feature-engineering-heavy pipelines.",
    capabilities: ["Photon", "Feature engineering", "Spark SQL"],
  },
  {
    id: "databricks-runtime-ml-lts",
    plane: "model-inference",
    provider: "Databricks",
    family: "Databricks Runtime ML — Classic",
    label: "Runtime ML — LTS",
    description: "Long-term-support Runtime ML line for stable, governed production ML workloads.",
    capabilities: ["Long-term support", "Classic compute", "Production stability"],
  },

  // General Databricks runtimes used around model data and feature pipelines.
  {
    id: "databricks-runtime-standard",
    plane: "model-inference",
    provider: "Databricks",
    family: "Data and feature engineering",
    label: "Databricks Runtime — Standard",
    description: "General Spark runtime for preparing model data, features, and batch inference pipelines.",
    capabilities: ["Apache Spark", "Data engineering", "Batch inference"],
  },
  {
    id: "databricks-runtime-photon",
    plane: "model-inference",
    provider: "Databricks",
    family: "Data and feature engineering",
    label: "Databricks Runtime — Photon enabled",
    description: "Photon-accelerated runtime for SQL and DataFrame-heavy feature and inference pipelines.",
    capabilities: ["Photon", "Spark SQL", "Feature pipelines"],
  },
  {
    id: "databricks-runtime-lts",
    plane: "model-inference",
    provider: "Databricks",
    family: "Data and feature engineering",
    label: "Databricks Runtime — LTS",
    description: "Long-term-support general runtime for stable production data and feature workloads.",
    capabilities: ["Long-term support", "Apache Spark", "Production stability"],
  },
] as const satisfies readonly RuntimeOptionDefinition[];

export type RuntimeOption = (typeof RUNTIME_OPTIONS)[number];
export type RuntimeOptionId = RuntimeOption["id"];
export type AgentRuntimeId = Extract<
  RuntimeOption,
  { plane: "agentic-workload" }
>["id"];
export type ModelRuntimeId = Extract<
  RuntimeOption,
  { plane: "model-inference" }
>["id"];

export interface AgentCompute {
  agentRuntimeId: AgentRuntimeId;
  modelRuntimeId: ModelRuntimeId;
}

export const DEFAULT_AGENT_RUNTIME_ID: AgentRuntimeId = "aws-agentcore-runtime";
export const DEFAULT_MODEL_RUNTIME_ID: ModelRuntimeId = "aws-bedrock";

export function defaultAgentCompute(): AgentCompute {
  return {
    agentRuntimeId: DEFAULT_AGENT_RUNTIME_ID,
    modelRuntimeId: DEFAULT_MODEL_RUNTIME_ID,
  };
}

export function getRuntimeOption(id: string | undefined): RuntimeOption | undefined {
  return RUNTIME_OPTIONS.find((option) => option.id === id);
}

export function runtimeOptionsForPlane(plane: RuntimePlane): RuntimeOption[] {
  return RUNTIME_OPTIONS.filter((option) => option.plane === plane);
}

export function isRuntimeIdForPlane(
  value: unknown,
  plane: RuntimePlane
): boolean {
  return (
    typeof value === "string" &&
    RUNTIME_OPTIONS.some((option) => option.id === value && option.plane === plane)
  );
}

export function isAgentCompute(value: unknown): value is AgentCompute {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isRuntimeIdForPlane(candidate.agentRuntimeId, "agentic-workload") &&
    isRuntimeIdForPlane(candidate.modelRuntimeId, "model-inference")
  );
}

/** Normalize data retained by a dev hot-reload from the legacy {runtime} shape. */
export function normalizeAgentCompute(value: unknown): AgentCompute {
  if (isAgentCompute(value)) {
    return {
      agentRuntimeId: value.agentRuntimeId,
      modelRuntimeId: value.modelRuntimeId,
    };
  }
  return defaultAgentCompute();
}

export interface RuntimeGroup {
  key: string;
  provider: RuntimeProvider;
  family: string;
  options: RuntimeOption[];
}

export function groupRuntimeOptions(plane: RuntimePlane): RuntimeGroup[] {
  const groups: RuntimeGroup[] = [];
  for (const option of runtimeOptionsForPlane(plane)) {
    const key = `${option.provider}:${option.family}`;
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = {
        key,
        provider: option.provider,
        family: option.family,
        options: [],
      };
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}
