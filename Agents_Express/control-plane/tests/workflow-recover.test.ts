// Offline tests for interrupted workflow runs.
//
// Durability made the run RECORDS survive a restart, which exposed the next
// problem: a run is advanced by an in-process promise (`void advance(run, wf)`)
// and that promise survives nothing. A restart mid-run left `status: "running"`
// in the store with nothing left to move it — a permanent zombie, which the
// console then polled forever because its poller only stops on a terminal
// status.
//
// The decisions this file pins down:
//
//   - a `paused` run is NOT interrupted. It is waiting on a human at a review
//     gate and the decision op resumes it. Treating it as an incident would
//     turn every pending approval into one on each restart.
//   - an interrupted run is NOT auto-resumed. The step was already dispatched
//     to a model and possibly a tool, and the record cannot say whether that
//     call completed — the output is written only after it returns. Re-running
//     blindly double-charges at best, and repeats a side effect at worst.
//   - resuming re-runs ONLY the interrupted step. Earlier steps completed and
//     their output is real; discarding it would spend tokens to reproduce work
//     that was already paid for.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  needsRecovery,
  planResume,
  recoverInterruptedRuns,
} from "../src/lib/workflow/recover.ts";
import type { StepRun, WorkflowRun } from "../src/lib/types.ts";

const NOW = "2026-10-23T12:00:00.000Z";

function step(over: Partial<StepRun> = {}): StepRun {
  return {
    stepId: "s1", name: "Step 1", status: "pending", output: "",
    modelId: "", usage: null, latencyMs: null, costUsd: null,
    reviewGate: false,
    ...over,
  };
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1", workflowId: "wf-1", workflowName: "Test WF", tenantId: "t1",
    status: "running", input: "hi", steps: [step()], currentStep: 0,
    totalCostUsd: 0, totalTokens: 0,
    createdAt: NOW, updatedAt: NOW,
    ...over,
  } as WorkflowRun;
}

// --------------------------------------------------------------------------- //
// What counts as interrupted
// --------------------------------------------------------------------------- //
test("only a running run needs recovery", () => {
  assert.equal(needsRecovery(run({ status: "running" })), true);
  for (const status of ["completed", "error", "denied", "paused", "interrupted"] as const) {
    assert.equal(needsRecovery(run({ status })), false, `${status} must be left alone`);
  }
});

test("a paused run is never converted into an incident", () => {
  // Every pending approval would become one on each restart otherwise.
  const paused = run({
    status: "paused",
    steps: [step({ status: "awaiting-review", output: "needs a human" })],
  });
  const report = recoverInterruptedRuns([paused], NOW);
  assert.equal(report.interrupted.length, 0);
  assert.equal(paused.status, "paused");
  assert.equal(paused.steps[0].status, "awaiting-review");
  assert.equal(paused.steps[0].output, "needs a human", "and its output is untouched");
});

test("a mid-flight run becomes interrupted, and says it may have executed", () => {
  const r = run({
    status: "running",
    currentStep: 1,
    steps: [
      step({ stepId: "s1", name: "First", status: "done", output: "real output" }),
      step({ stepId: "s2", name: "Second", status: "running" }),
      step({ stepId: "s3", name: "Third", status: "pending" }),
    ],
  });
  const report = recoverInterruptedRuns([r], NOW);

  assert.equal(r.status, "interrupted");
  assert.equal(r.steps[1].status, "interrupted");
  assert.equal(r.currentStep, 1);
  assert.equal(report.interrupted[0].mayHaveExecuted, true,
    "a step caught mid-run may already have been billed");
  assert.match(r.steps[1].error ?? "", /not known whether the model call completed/);

  // Completed work is preserved. Re-running it would spend tokens to
  // reproduce an answer that is already correct.
  assert.equal(r.steps[0].status, "done");
  assert.equal(r.steps[0].output, "real output");
  assert.equal(r.steps[2].status, "pending");
});

test("a crash BETWEEN steps is interrupted but did not execute", () => {
  const r = run({
    status: "running",
    steps: [
      step({ stepId: "s1", status: "done", output: "a" }),
      step({ stepId: "s2", name: "Next", status: "pending" }),
    ],
  });
  const report = recoverInterruptedRuns([r], NOW);
  assert.equal(r.status, "interrupted");
  assert.equal(report.interrupted[0].mayHaveExecuted, false,
    "no step was running, so nothing was in flight");
  assert.equal(r.steps[1].status, "pending",
    "a step that never started stays pending — it has no uncertainty to record");
  assert.equal(report.interrupted[0].stepIndex, 1);
});

test("step statuses outrank a stale currentStep", () => {
  // A crash between setting `currentStep` and the step status would leave the
  // index pointing at the wrong place, and the statuses are what the UI shows.
  const r = run({
    status: "running",
    currentStep: 0,                       // stale
    steps: [
      step({ stepId: "s1", status: "done", output: "a" }),
      step({ stepId: "s2", name: "Really running", status: "running" }),
    ],
  });
  recoverInterruptedRuns([r], NOW);
  assert.equal(r.currentStep, 1, "corrected from the step statuses");
  assert.equal(r.steps[1].status, "interrupted");
});

test("recovery is idempotent", () => {
  // It runs at every boot; a second pass must not re-mark or re-stamp.
  const r = run({
    status: "running",
    steps: [step({ status: "running" })],
  });
  recoverInterruptedRuns([r], NOW);
  const after = JSON.parse(JSON.stringify(r));
  const second = recoverInterruptedRuns([r], "2099-01-01T00:00:00.000Z");
  assert.equal(second.interrupted.length, 0, "nothing left to recover");
  assert.deepEqual(JSON.parse(JSON.stringify(r)), after, "and nothing changed");
});

test("many runs are recovered in one pass, terminal ones counted", () => {
  const runs = [
    run({ id: "a", status: "running", steps: [step({ status: "running" })] }),
    run({ id: "b", status: "completed" }),
    run({ id: "c", status: "running", steps: [step({ status: "running" })] }),
    run({ id: "d", status: "paused", steps: [step({ status: "awaiting-review" })] }),
    run({ id: "e", status: "error" }),
  ];
  const report = recoverInterruptedRuns(runs, NOW);
  assert.deepEqual(report.interrupted.map((r) => r.runId), ["a", "c"]);
  assert.equal(report.untouched, 3);
});

// --------------------------------------------------------------------------- //
// Resuming
// --------------------------------------------------------------------------- //
test("resume targets the interrupted step, not the start", () => {
  const r = run({
    status: "interrupted",
    steps: [
      step({ stepId: "s1", status: "done", output: "keep me" }),
      step({ stepId: "s2", name: "Second", status: "interrupted" }),
      step({ stepId: "s3", status: "pending" }),
    ],
  });
  const plan = planResume(r);
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.fromStep, 1);
  assert.match(plan.reason, /step 2/);
});

test("resume is refused for runs whose remedy is a different verb", () => {
  // Collapsing paused / error / interrupted into one "resume" would hide which
  // question is being answered.
  for (const [status, expect] of [
    ["paused", /review decision/],
    ["error", /rerun/],
    ["completed", /not 'interrupted'/],
    ["denied", /not 'interrupted'/],
  ] as const) {
    const plan = planResume(run({ status }));
    assert.equal(plan.ok, false, `${status} must not be resumable`);
    assert.match(plan.reason, expect, `${status}: ${plan.reason}`);
  }
});

test("an interrupted run with nothing unfinished is not resumable", () => {
  const r = run({
    status: "interrupted",
    steps: [step({ status: "done", output: "a" })],
  });
  const plan = planResume(r);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /rerun from a chosen step/);
});

test("a pending step is a valid resume point after a between-steps crash", () => {
  const r = run({
    status: "interrupted",
    steps: [
      step({ stepId: "s1", status: "done", output: "a" }),
      step({ stepId: "s2", name: "Pending one", status: "pending" }),
    ],
  });
  const plan = planResume(r);
  assert.equal(plan.ok, true);
  assert.equal(plan.fromStep, 1);
});

// --------------------------------------------------------------------------- //
// Against the real store
// --------------------------------------------------------------------------- //
test("the seeded store has no interrupted runs to recover", async () => {
  // A fresh seed must boot clean; if it did not, every start-up would report
  // phantom incidents.
  const { store } = await import("../src/lib/store.ts");
  const report = recoverInterruptedRuns(
    JSON.parse(JSON.stringify(store.workflowRuns)), NOW);
  assert.equal(report.interrupted.length, 0,
    `seed must not contain running runs, got ${JSON.stringify(report.interrupted)}`);
});
