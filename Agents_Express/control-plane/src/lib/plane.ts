// Execution-plane agreement — ONE rule, used everywhere it matters.
//
// An agent declares a model runtime (`compute.modelRuntimeId`) and points at a
// catalog model. Those two must agree about which plane actually runs the
// inference, or the runtime field is decorative.
//
// This module exists because they did NOT agree. The resolver enforced the
// rule completely and symmetrically; the agent-create route had its own copy
// that covered only two of the five providers:
//
//     if (provider === "Databricks Model Serving" && !isDatabricksRuntime) …
//     if (provider === "Amazon Bedrock" && isDatabricksRuntime) …
//
// So an OpenAI-served model with a `databricks-*` runtime passed creation
// silently and then failed when a workflow tried to bind the agent — far from
// the form that accepted it, and reported as a workflow problem rather than an
// agent one. Late, incomplete validation of exactly the kind that costs an
// afternoon.
//
// Pure, and free of server-only imports, so a client form can use it too.

import type { CatalogModel, InferenceProvider } from "./types";

export type Executor = "bedrock" | "databricks";

/** Which plane really serves this model. */
export function executorFor(model: Pick<CatalogModel, "inferenceProvider">): Executor {
  return model.inferenceProvider === "Databricks Model Serving"
    ? "databricks"
    : "bedrock";
}

/** Does this runtime id name the Databricks plane? */
export function isDatabricksRuntime(modelRuntimeId: string): boolean {
  return (modelRuntimeId ?? "").startsWith("databricks-");
}

/**
 * Why a runtime and a model disagree, or null when they agree.
 *
 * Stated SYMMETRICALLY over the plane rather than per-provider, which is what
 * makes it complete: a Databricks runtime requires a Databricks-served model,
 * and any other runtime requires a model NOT served by Databricks. Adding a
 * sixth inference provider cannot open a new hole, because the rule never
 * enumerates providers.
 */
export function planeMismatch(
  modelRuntimeId: string,
  provider: InferenceProvider
): string | null {
  const wantsDatabricks = isDatabricksRuntime(modelRuntimeId);
  const servedBy = executorFor({ inferenceProvider: provider });

  if (wantsDatabricks && servedBy !== "databricks") {
    return (
      `model runtime '${modelRuntimeId}' is a Databricks plane runtime, but the ` +
      `model is served by '${provider}'. Either pick a model whose Inference ` +
      `Provider is 'Databricks Model Serving', or choose an aws-* runtime.`
    );
  }
  if (!wantsDatabricks && servedBy === "databricks") {
    return (
      `model runtime '${modelRuntimeId}' is not a Databricks runtime, but the ` +
      `model is served by Databricks Model Serving. Either pick a databricks-* ` +
      `runtime, or a model served elsewhere.`
    );
  }
  return null;
}

/**
 * Catalog models an agent with this runtime may legitimately use.
 *
 * Offered so a form can narrow its own picker instead of accepting a
 * combination the server will later refuse — the failure the shared rule is
 * meant to make impossible.
 */
export function modelsForRuntime<T extends Pick<CatalogModel, "inferenceProvider">>(
  models: T[],
  modelRuntimeId: string
): T[] {
  const wantsDatabricks = isDatabricksRuntime(modelRuntimeId);
  return models.filter(
    (m) => (executorFor(m) === "databricks") === wantsDatabricks
  );
}
