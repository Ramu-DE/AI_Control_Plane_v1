import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUNTIME_OPTIONS,
  defaultAgentCompute,
  getRuntimeOption,
  groupRuntimeOptions,
  isAgentCompute,
  runtimeOptionsForPlane,
} from "../src/lib/runtimes.ts";

const ids = (plane: "agentic-workload" | "model-inference") =>
  runtimeOptionsForPlane(plane).map((option) => option.id);

test("AWS agentic workload runtimes mirror the ecosystem diagram", () => {
  assert.deepEqual(
    ids("agentic-workload").filter((id) => id.startsWith("aws-")),
    ["aws-agentcore-runtime", "aws-lambda", "aws-ecs", "aws-eks"]
  );
});

test("AWS model runtimes mirror the ecosystem diagram", () => {
  assert.deepEqual(
    ids("model-inference").filter((id) => id.startsWith("aws-")),
    ["aws-bedrock", "aws-sagemaker-ai", "aws-eks-models"]
  );
});

test("Databricks model runtimes are organized into distinct families", () => {
  const groups = groupRuntimeOptions("model-inference").filter(
    (group) => group.provider === "Databricks"
  );
  assert.deepEqual(
    groups.map((group) => group.family),
    [
      "Managed model serving",
      "AI Runtime — Serverless GPU",
      "Databricks Runtime ML — Classic",
      "Data and feature engineering",
    ]
  );
  assert.ok(groups.every((group) => group.options.length >= 2));
});

test("Databricks agent choices include managed, custom app, and batch families", () => {
  const groups = groupRuntimeOptions("agentic-workload").filter(
    (group) => group.provider === "Databricks"
  );
  assert.deepEqual(groups.map((group) => group.family), [
    "Managed agents",
    "Application hosting",
    "Batch and scheduled",
  ]);
});

test("runtime ids are unique and every option has capabilities", () => {
  const allIds = RUNTIME_OPTIONS.map((option) => option.id);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.ok(RUNTIME_OPTIONS.every((option) => option.capabilities.length > 0));
});

test("default compute selects one valid runtime from each plane", () => {
  const compute = defaultAgentCompute();
  assert.equal(isAgentCompute(compute), true);
  assert.equal(getRuntimeOption(compute.agentRuntimeId)?.plane, "agentic-workload");
  assert.equal(getRuntimeOption(compute.modelRuntimeId)?.plane, "model-inference");
});

test("validation rejects swapped planes and unknown runtime ids", () => {
  assert.equal(
    isAgentCompute({ agentRuntimeId: "aws-bedrock", modelRuntimeId: "aws-eks" }),
    false
  );
  assert.equal(
    isAgentCompute({ agentRuntimeId: "unknown", modelRuntimeId: "aws-bedrock" }),
    false
  );
});
