import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { runStepOnBedrock, newStepRun } from "@/lib/bedrock";
import { Workflow, WorkflowRun } from "@/lib/types";

// Needs the Node runtime (AWS SDK + instance-role credentials), not edge.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({
    workflows: store.workflows,
    runs: store.workflowRuns,
  });
}

// Advance a run: execute pending steps in order until a review gate pauses it,
// or the workflow completes. Each step is a REAL Bedrock Converse call.
async function advance(run: WorkflowRun, workflow: Workflow): Promise<void> {
  for (let i = run.currentStep; i < run.steps.length; i++) {
    const sr = run.steps[i];
    // Skip steps already resolved.
    if (sr.status === "done" || sr.status === "approved" || sr.status === "revised") {
      continue;
    }
    // If this step is awaiting review, stop — human must decide first.
    if (sr.status === "awaiting-review") {
      run.status = "paused";
      run.currentStep = i;
      return;
    }

    const step = workflow.steps[i];
    sr.status = "running";
    sr.startedAt = new Date().toISOString();
    run.currentStep = i;
    try {
      const prior = run.steps
        .slice(0, i)
        .filter((p) => p.output)
        .map((p) => ({ name: p.name, output: p.output }));
      const result = await runStepOnBedrock(step, run.input, prior);
      sr.output = result.output;
      sr.usage = result.usage;
      sr.latencyMs = result.latencyMs;
      sr.costUsd = result.costUsd;
      sr.modelId = result.resolvedModelId;
      sr.finishedAt = new Date().toISOString();
      run.totalTokens += result.usage.totalTokens;
      run.totalCostUsd += result.costUsd;

      if (step.reviewGate) {
        sr.status = "awaiting-review";
        run.status = "paused";
        run.currentStep = i;
        run.updatedAt = new Date().toISOString();
        return; // pause for human
      }
      sr.status = "done";
    } catch (e) {
      sr.status = "error";
      sr.error = (e as Error).message;
      run.status = "error";
      run.updatedAt = new Date().toISOString();
      return;
    }
  }
  run.status = "completed";
  run.currentStep = run.steps.length;
  run.updatedAt = new Date().toISOString();
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as
    | { op: "start"; workflowId: string; input: string }
    | { op: "decision"; runId: string; decision: "approve" | "revise" | "deny"; revisedOutput?: string; note?: string }
    | { op: "rerun"; runId: string; stepIndex: number }
    | { op: "create"; name: string; description?: string; tenantId: string; steps?: Workflow["steps"] };

  if (body.op === "create") {
    if (!body.name || !body.tenantId) {
      return NextResponse.json({ error: "name and tenantId required" }, { status: 400 });
    }
    const now = new Date().toISOString();
    const wf: Workflow = {
      id: newId("wf"),
      name: body.name,
      description: body.description ?? "",
      tenantId: body.tenantId,
      steps: body.steps ?? [],
      createdAt: now,
      updatedAt: now,
    };
    store.workflows.unshift(wf);
    logAudit({ category: "agent", action: "workflow-create", actor: "console-user", detail: `Created workflow '${wf.name}'` });
    return NextResponse.json(wf, { status: 201 });
  }

  if (body.op === "start") {
    const wf = store.workflows.find((w) => w.id === body.workflowId);
    if (!wf) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: newId("run"),
      workflowId: wf.id,
      workflowName: wf.name,
      tenantId: wf.tenantId,
      status: "running",
      input: body.input || "Process this request.",
      steps: wf.steps.map((s) => newStepRun(s)),
      currentStep: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.workflowRuns.unshift(run);
    await advance(run, wf); // real Bedrock calls
    logAudit({ category: "agent", action: "workflow-run", actor: "console-user", detail: `Started run of '${wf.name}' → ${run.status}` });
    return NextResponse.json(run, { status: 201 });
  }

  if (body.op === "decision") {
    const run = store.workflowRuns.find((r) => r.id === body.runId);
    if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
    const wf = store.workflows.find((w) => w.id === run.workflowId)!;
    const sr = run.steps[run.currentStep];
    if (!sr || sr.status !== "awaiting-review") {
      return NextResponse.json({ error: "no step awaiting review" }, { status: 400 });
    }
    sr.reviewer = "Workshop Admin";
    sr.reviewNote = body.note;
    if (body.decision === "approve") {
      sr.status = "approved";
      run.currentStep += 1;
      run.status = "running";
      await advance(run, wf);
    } else if (body.decision === "revise") {
      sr.output = body.revisedOutput ?? sr.output;
      sr.status = "revised";
      run.currentStep += 1;
      run.status = "running";
      await advance(run, wf);
    } else {
      sr.status = "denied";
      run.status = "denied";
      run.updatedAt = new Date().toISOString();
    }
    logAudit({ category: "agent", action: "workflow-gate", actor: "Workshop Admin", detail: `${body.decision.toUpperCase()} at '${sr.name}' in run of '${run.workflowName}'` });
    return NextResponse.json(run);
  }

  if (body.op === "rerun") {
    const run = store.workflowRuns.find((r) => r.id === body.runId);
    if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
    const wf = store.workflows.find((w) => w.id === run.workflowId)!;
    // Reset from the given step onward and re-execute.
    for (let i = body.stepIndex; i < run.steps.length; i++) {
      run.steps[i] = newStepRun(wf.steps[i]);
    }
    run.currentStep = body.stepIndex;
    run.status = "running";
    await advance(run, wf);
    logAudit({ category: "agent", action: "workflow-rerun", actor: "console-user", detail: `Re-ran from step ${body.stepIndex + 1} in '${run.workflowName}'` });
    return NextResponse.json(run);
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
