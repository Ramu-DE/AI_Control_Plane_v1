import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { runStepOnBedrock, newStepRun } from "@/lib/bedrock";
import { runStepOnDatabricks, runStepOnDatabricksWithTools } from "@/lib/databricks";
import type { Workflow, WorkflowRun, WorkflowStep } from "@/lib/types";
import {
  StepResolutionError,
  hasAgentBoundStep,
  resolveStep,
} from "@/lib/workflow/resolve";
import {
  StepDeniedError,
  authorizeAgentStep,
  groundStep,
} from "@/lib/workflow/govern";

/**
 * Resolve, authorize, ground and execute one step.
 *
 * An agent-bound step inherits the agent's model, system prompt, tools and
 * knowledge bases; is Cedar-checked as that agent; and is grounded on the
 * agent's Knowledge Base before the model is called. A plain (model-only) step
 * behaves exactly as before, so existing workflows are unaffected.
 */
async function runStep(
  step: WorkflowStep,
  task: string,
  prior: { name: string; output: string }[],
  run: WorkflowRun
) {
  const resolved = resolveStep(step, {
    agents: store.agents,
    models: store.models,
    records: store.records,
    tenants: store.tenants,
    workflowTenantId: run.tenantId,
  });
  const notes = [...resolved.notes];

  // Governance: a step running AS a governed agent needs an attributable caller.
  if (resolved.agent) {
    if (!run.personaId) {
      throw new StepDeniedError(
        `step '${step.name}' runs as agent '${resolved.agent.name}', which requires a ` +
          `personaId on the run so the Cedar runAgent check has a principal`
      );
    }
    const authz = authorizeAgentStep(resolved.agent.id, run.personaId);
    if (!authz.allowed) {
      throw new StepDeniedError(
        `Cedar denied running step '${step.name}' as agent '${resolved.agent.name}': ` +
          (authz.agentScoped.evaluated && !authz.agentScoped.allowed
            ? authz.agentScoped.reason
            : authz.perimeter.reason)
      );
    }
  }

  // RAG: finally READ the agent's knowledgeRefs at execution time.
  let promptPrefix = "";
  let grounding = null;
  if (resolved.knowledgeRefs.length > 0 && run.personaId) {
    const out = await groundStep(resolved.knowledgeRefs, run.personaId, task);
    promptPrefix = out.context;
    grounding = out.grounding;
    notes.push(...out.notes);
  } else if (resolved.knowledgeRefs.length > 0) {
    notes.push("knowledge bases are attached but no personaId was supplied — not grounded");
  }

  const effective: WorkflowStep & { modelId: string } = {
    ...resolved.step,
    prompt: promptPrefix ? `${promptPrefix}${resolved.step.prompt}` : resolved.step.prompt,
  };

  // Real tool calling is only available on the Databricks plane today (verified:
  // the FM endpoints return finish_reason "tool_calls"). A Bedrock step with
  // executable tools still runs, but without them — and says so.
  let result;
  if (resolved.executor === "databricks" && resolved.executableTools.length > 0) {
    result = await runStepOnDatabricksWithTools(
      effective,
      task,
      prior,
      resolved.executableTools
    );
  } else if (resolved.executor === "databricks") {
    result = await runStepOnDatabricks(effective, task, prior);
  } else {
    if (resolved.executableTools.length > 0) {
      notes.push(
        `${resolved.executableTools.length} executable tool(s) were not offered: tool calling ` +
          `is implemented for the Databricks plane only`
      );
    }
    result = await runStepOnBedrock(effective, task, prior);
  }

  return {
    ...result,
    notes: [...notes, ...(("notes" in result && result.notes) || [])],
    toolCalls: ("toolCalls" in result && result.toolCalls) || undefined,
    grounding,
    provenance: {
      ...(resolved.agent
        ? {
            agentId: resolved.agent.id,
            agentName: resolved.agent.name,
            agentRuntimeId: resolved.agent.compute.agentRuntimeId,
            modelRuntimeId: resolved.agent.compute.modelRuntimeId,
          }
        : {}),
      catalogModelId: resolved.catalogModel.id,
      executor: resolved.executor,
      ...(resolved.resolvedTools.length > 0
        ? { resolvedTools: resolved.resolvedTools }
        : {}),
    },
  };
}

// Needs the Node runtime (AWS SDK + instance-role credentials), not edge.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({
    workflows: store.workflows,
    runs: store.workflowRuns,
    // Everything the Workflows UI needs to BUILD a workflow: ready agents to
    // bind steps to, the model catalog for model-only steps, tenants, and
    // personas (required to run an agent-bound workflow).
    agents: store.agents
      .filter((a) => a.status === "ready")
      .map((a) => ({
        id: a.id,
        name: a.name,
        tenantId: a.tenantId,
        modelId: a.modelId,
        agentRuntimeId: a.compute.agentRuntimeId,
        modelRuntimeId: a.compute.modelRuntimeId,
        toolCount: a.toolRefs.length,
        knowledgeCount: a.knowledgeRefs.length,
      })),
    models: store.models.map((m) => ({
      id: m.id,
      name: m.name,
      inferenceProvider: m.inferenceProvider,
    })),
    // parentId is REQUIRED by the UI: agent eligibility follows the org tree
    // (own tenant or an ancestor), and without the parent link the form could
    // only compare ids for equality — which is why it was hiding agents the
    // server would have accepted.
    tenants: store.tenants.map((t) => ({
      id: t.id,
      tenantName: t.tenantName,
      parentId: t.parentId ?? null,
    })),
    personas: store.personas.map((p) => ({ id: p.id, name: p.name, groups: p.groups })),
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
      const result = await runStep(step, run.input, prior, run);
      sr.output = result.output;
      sr.usage = result.usage;
      sr.latencyMs = result.latencyMs;
      sr.costUsd = result.costUsd;
      sr.modelId = result.resolvedModelId;
      sr.provenance = result.provenance;
      if (result.grounding) sr.grounding = result.grounding;
      if (result.notes.length > 0) sr.notes = result.notes;
      if (result.toolCalls && result.toolCalls.length > 0) sr.toolCalls = result.toolCalls;
      sr.finishedAt = new Date().toISOString();
      run.totalTokens += result.usage.totalTokens;
      // Databricks bills in DBUs, so its executor reports costUsd = null rather
      // than inventing a dollar figure. Tokens still accumulate.
      run.totalCostUsd += result.costUsd ?? 0;

      // A step that produced NO text is not done. It was previously marked
      // "done" and its empty output fed the next step, which then asked for
      // data the earlier step had already fetched — a chain that looks like it
      // ran and silently carried nothing. Fail here instead, where the cause
      // is visible, rather than three steps later where it is not.
      if (!String(sr.output ?? "").trim()) {
        sr.status = "error";
        sr.error =
          "the step produced no output, so there is nothing to pass on. " +
          (result.toolCalls?.length
            ? `${result.toolCalls.length} tool call(s) ran, so the data was ` +
              `fetched but never synthesised.`
            : "no tool calls ran either.");
        run.status = "error";
        run.updatedAt = new Date().toISOString();
        return;
      }

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
    | { op: "start"; workflowId: string; input: string; personaId?: string }
    | { op: "decision"; runId: string; decision: "approve" | "revise" | "deny"; revisedOutput?: string; note?: string }
    | { op: "rerun"; runId: string; stepIndex: number }
    | { op: "create"; name: string; description?: string; tenantId: string; steps?: Workflow["steps"] };

  if (body.op === "create") {
    if (!body.name || !body.tenantId) {
      return NextResponse.json({ error: "name and tenantId required" }, { status: 400 });
    }
    // Validate at CREATE time so a broken workflow cannot be saved and then
    // fail mid-run. resolveStep() is the same check the executor uses.
    for (const step of body.steps ?? []) {
      if (!step.agentId && !step.modelId) {
        return NextResponse.json(
          { error: `step '${step.name || step.id}' needs either an agentId or a modelId` },
          { status: 400 }
        );
      }
      try {
        resolveStep(step, {
          agents: store.agents,
          models: store.models,
          records: store.records,
          tenants: store.tenants,
          workflowTenantId: body.tenantId,
        });
      } catch (e) {
        if (e instanceof StepResolutionError) {
          return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
        }
        throw e;
      }
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

    // Fail BEFORE starting a run rather than erroring on the first step: an
    // agent-bound workflow has no attributable principal without a persona.
    if (hasAgentBoundStep(wf.steps) && !body.personaId) {
      return NextResponse.json(
        {
          error:
            "this workflow has agent-bound step(s); personaId is required so each step can be " +
            "Cedar-checked as that agent",
          code: "PERSONA_REQUIRED",
        },
        { status: 400 }
      );
    }
    if (body.personaId && !store.personas.some((p) => p.id === body.personaId)) {
      return NextResponse.json({ error: "unknown personaId" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: newId("run"),
      workflowId: wf.id,
      workflowName: wf.name,
      tenantId: wf.tenantId,
      status: "running",
      input: body.input || "Process this request.",
      ...(body.personaId ? { personaId: body.personaId } : {}),
      steps: wf.steps.map((s) => newStepRun(s)),
      currentStep: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.workflowRuns.unshift(run);
    logAudit({
      category: "agent",
      action: "workflow-run",
      actor: "console-user",
      detail: `Started run of '${wf.name}' (${wf.steps.length} step(s))`,
    });

    // DO NOT await. A multi-step workflow makes several model calls, each of
    // which may itself loop over tool calls, so a three-step run measured
    // 27-29 seconds and a slower one exceeds the 30-second origin timeout in
    // front of this app — the caller then sees a 504 while the run is in fact
    // progressing fine. Holding an HTTP request open for the length of an
    // agentic workflow is the wrong shape regardless of the limit.
    //
    // The run is already in the store with status "running", so the client gets
    // it immediately and polls. Failures are recorded ON THE RUN by advance()
    // and surface through the same polling; the catch here is only for a throw
    // that escapes it entirely, which must still leave the run in a terminal
    // state rather than "running" forever.
    void advance(run, wf)
      .then(() => {
        logAudit({
          category: "agent",
          action: "workflow-run",
          actor: "console-user",
          detail: `Run of '${wf.name}' finished → ${run.status}`,
        });
      })
      .catch((e: unknown) => {
        run.status = "error";
        run.updatedAt = new Date().toISOString();
        const detail = (e as Error)?.message ?? String(e);
        logAudit({
          category: "agent",
          action: "workflow-run-failed",
          actor: "console-user",
          detail: `Run of '${wf.name}' failed outside step handling: ${detail}`,
        });
      });

    return NextResponse.json(run, { status: 202 });
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
