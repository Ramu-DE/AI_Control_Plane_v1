// Workflow runs that were in flight when the process stopped.
//
// Durability made the run RECORDS survive a restart, which exposed the next
// problem: a run is advanced by an in-process promise
// (`void advance(run, wf)`), and that promise does not survive anything. So a
// restart mid-run left `status: "running"` in the store with nothing left to
// move it. The run was a zombie — permanently "running", and the console polled
// it forever because its poller only stops on a terminal status.
//
// WHY THESE RUNS ARE NOT AUTO-RESUMED.
//
// The step that was executing had already been dispatched to a model, and
// possibly to a tool. We cannot tell from the stored record whether that call
// completed: the output is written AFTER the call returns, so an absent output
// means either "never ran" or "ran, was billed, and the answer was lost". Those
// need different handling and only a human can choose.
//
// Re-running blindly would double-charge at best. At worst it repeats a tool
// call with a side effect — and while today's tools are read-only, the registry
// is designed to carry ones that are not. So an interrupted run is marked, with
// the uncertainty stated, and waits for an explicit decision. That is the same
// shape as the review gate the platform already has.
//
// Pure: takes runs, mutates their status fields, returns a report. No I/O, so
// it can run at store boot and be tested without one.

import type { StepRun, WorkflowRun } from "../types";

export interface RecoveryReport {
  /** Runs moved from `running` to `interrupted`. */
  interrupted: {
    runId: string;
    workflowName: string;
    stepIndex: number;
    stepName: string;
    /** True when the step may have executed and been billed. */
    mayHaveExecuted: boolean;
  }[];
  /** Runs left exactly as they were, because they were already terminal. */
  untouched: number;
}

/** Statuses from which nothing further will happen on its own. */
const SETTLED = new Set(["completed", "error", "denied", "interrupted"]);

/**
 * A `paused` run is NOT interrupted.
 *
 * It is waiting on a human at a review gate, and the `decision` op resumes it.
 * Treating it as interrupted would convert every pending approval into an
 * incident on each restart.
 */
export function needsRecovery(run: WorkflowRun): boolean {
  return run.status === "running";
}

/**
 * Mark in-flight runs as interrupted. Call once, at boot, on RESTORED state.
 *
 * `now` is a parameter so the stamps are deterministic in tests.
 */
export function recoverInterruptedRuns(
  runs: WorkflowRun[],
  now: string = new Date().toISOString()
): RecoveryReport {
  const report: RecoveryReport = { interrupted: [], untouched: 0 };

  for (const run of runs) {
    if (!needsRecovery(run)) {
      if (SETTLED.has(run.status) || run.status === "paused") report.untouched += 1;
      continue;
    }

    // The step that was mid-flight. `currentStep` is maintained by advance(),
    // but trust the step statuses over it: a crash between the two would make
    // the index stale, and the statuses are what the UI renders.
    let index = run.steps.findIndex((s) => s.status === "running");
    if (index < 0) {
      // No step claims to be running. Either the crash landed between steps,
      // or `advance` had not started the next one yet. The first unfinished
      // step is where to pick up, and nothing was in flight.
      index = run.steps.findIndex((s) => s.status === "pending");
    }
    const mayHaveExecuted = run.steps.some((s) => s.status === "running");
    // A run with no unfinished step at all was about to be marked completed.
    // Leaving it `interrupted` is still correct — it never was — but there is
    // no step to point at.
    const step: StepRun | undefined = index >= 0 ? run.steps[index] : undefined;

    if (step && step.status === "running") {
      step.status = "interrupted";
      step.finishedAt = now;
      step.error =
        "The platform restarted while this step was executing. It is not " +
        "known whether the model call completed: the output is recorded only " +
        "after it returns, so an empty output here means either it never ran " +
        "or it ran and the answer was lost. Resume to re-run this step, or " +
        "rerun from an earlier one.";
    }

    run.status = "interrupted";
    run.updatedAt = now;
    if (index >= 0) run.currentStep = index;

    report.interrupted.push({
      runId: run.id,
      workflowName: run.workflowName,
      stepIndex: index,
      stepName: step?.name ?? "(none)",
      mayHaveExecuted,
    });
  }

  return report;
}

export interface ResumePlan {
  ok: boolean;
  reason: string;
  /** The step to restart from, when resumable. */
  fromStep: number;
}

/**
 * Where an interrupted run should restart.
 *
 * Only `interrupted` runs are resumable here. A `paused` run goes through the
 * review-gate decision path, an `error` run through `rerun` — each already has
 * its own semantics, and collapsing them into one verb would hide which
 * question is being answered.
 */
export function planResume(run: WorkflowRun): ResumePlan {
  if (run.status !== "interrupted") {
    return {
      ok: false,
      fromStep: -1,
      reason:
        `run is '${run.status}', not 'interrupted'. A paused run resumes ` +
        `through a review decision; a failed run through rerun`,
    };
  }
  const index = run.steps.findIndex(
    (s) => s.status === "interrupted" || s.status === "pending"
  );
  if (index < 0) {
    return {
      ok: false,
      fromStep: -1,
      reason: "no unfinished step to resume from; rerun from a chosen step instead",
    };
  }
  return {
    ok: true,
    fromStep: index,
    reason: `resume from step ${index + 1} ('${run.steps[index].name}')`,
  };
}
