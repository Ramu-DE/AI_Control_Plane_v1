import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { planeMismatch } from "@/lib/plane";
import { getTierConfig, planLabel } from "@/lib/tiers";
import { resourceAvailableToTenant } from "@/lib/tenancy";
import { AgentConfig } from "@/lib/types";
import { defaultAgentCompute, isAgentCompute } from "@/lib/runtimes";
import type { InferenceProvider } from "@/lib/types";


export async function GET() {
  return NextResponse.json(store.agents);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<AgentConfig>;
  if (!body.name || !body.modelId) {
    return NextResponse.json(
      { error: "name and modelId are required" },
      { status: 400 }
    );
  }

  // Tenant context is required; enforce the tenant's tier limits.
  const tenantId = body.tenantId;
  const tenant = store.tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return NextResponse.json(
      { error: "a valid tenantId is required" },
      { status: 400 }
    );
  }
  const tier = getTierConfig(tenant.tier);
  const existing = store.agents.filter((a) => a.tenantId === tenant.id).length;
  if (existing >= tier.maxAgents) {
    return NextResponse.json(
      {
        // Same vocabulary as the console. The console no longer shows the
        // raw `basic`/`pro` keys, so an error that did would send an operator
        // hunting for a word that appears nowhere in the UI.
        error: `Plan limit reached: '${tenant.tenantName}' is on the ${planLabel(tenant.tier)} plan, which allows ${tier.maxAgents} agent(s). The ${planLabel("pro")} plan allows up to ${getTierConfig("pro").maxAgents}.`,
        upgrade: { currentTier: tenant.tier, requiredTier: "pro" },
      },
      { status: 403 }
    );
  }

  // The model must exist in the platform catalog (Settings → Models).
  const catalogModel = store.models.find((m) => m.id === body.modelId);
  if (!catalogModel) {
    return NextResponse.json(
      { error: "modelId must reference a model in the catalog" },
      { status: 400 }
    );
  }

  // Only APPROVED registry records can be wired into an agent, and no more
  // than the tier's maxToolsPerAgent.
  const toolRefs = body.toolRefs ?? [];
  if (toolRefs.length > tier.maxToolsPerAgent) {
    return NextResponse.json(
      {
        error: `Plan limit: '${tenant.tenantName}' is on the ${planLabel(tenant.tier)} plan, which allows ${tier.maxToolsPerAgent} tool(s) per agent.`,
      },
      { status: 403 }
    );
  }
  const notApproved = toolRefs.filter((id) => {
    const rec = store.records.find((r) => r.id === id);
    return !rec || rec.status !== "Approved";
  });
  if (notApproved.length > 0) {
    return NextResponse.json(
      {
        error:
          "Only approved registry records can be attached. Not approved: " +
          notApproved.join(", "),
      },
      { status: 400 }
    );
  }

  // TENANT OWNERSHIP, checked for every kind of attachment below.
  //
  // Approval governs WHAT exists; it said nothing about WHOSE it is. With the
  // registry now carrying a tenant, a platform-provided record stays available
  // to everyone and an ancestor's record is inherited, but a SIBLING BU's
  // record is refused — the case nothing previously prevented.
  const crossTenant = (ids: string[], kind: string) => {
    for (const id of ids) {
      const rec = store.records.find((r) => r.id === id);
      if (!rec) continue; // already reported as not-approved above
      const verdict = resourceAvailableToTenant(rec.tenantId, tenant.id, store.tenants);
      if (!verdict.allowed) {
        return (
          `${kind} '${rec.name}' is not available to '${tenant.tenantName}': ` +
          verdict.reason
        );
      }
    }
    return null;
  };
  const toolOwnership = crossTenant(toolRefs, "Tool");
  if (toolOwnership) {
    return NextResponse.json({ error: toolOwnership }, { status: 403 });
  }

  // Knowledge Bases: approved-only + tier limit (maxKnowledgeBases).
  const knowledgeRefs = body.knowledgeRefs ?? [];
  if (knowledgeRefs.length > tier.maxKnowledgeBases) {
    return NextResponse.json(
      {
        error: `Plan limit: '${tenant.tenantName}' is on the ${planLabel(tenant.tier)} plan, which allows ${tier.maxKnowledgeBases} knowledge base(s) per agent.`,
      },
      { status: 403 }
    );
  }
  // Memory: approved-only + tier limit. Recall is a capability that must be
  // granted through the same review as a tool or a knowledge base — a memory
  // holds personal data and shapes every future session, so an unapproved one
  // must not be attachable.
  const memoryRefs = body.memoryRefs ?? [];
  if (memoryRefs.length > tier.maxMemories) {
    return NextResponse.json(
      {
        error: `Plan limit: '${tenant.tenantName}' is on the ${planLabel(tenant.tier)} plan, which allows ${tier.maxMemories} memory/memories per agent.`,
      },
      { status: 403 }
    );
  }
  const memNotApproved = memoryRefs.filter((id) => {
    const rec = store.records.find((r) => r.id === id);
    return !rec || rec.type !== "Memory" || rec.status !== "Approved";
  });
  if (memNotApproved.length > 0) {
    return NextResponse.json(
      {
        error:
          "Only approved Memory records can be attached. Invalid: " +
          memNotApproved.join(", "),
      },
      { status: 400 }
    );
  }

  const kbOwnership = crossTenant(knowledgeRefs, "Knowledge base");
  if (kbOwnership) {
    return NextResponse.json({ error: kbOwnership }, { status: 403 });
  }
  const memOwnership = crossTenant(memoryRefs, "Memory");
  if (memOwnership) {
    return NextResponse.json({ error: memOwnership }, { status: 403 });
  }

  const kbNotApproved = knowledgeRefs.filter((id) => {
    const rec = store.records.find((r) => r.id === id);
    return !rec || rec.type !== "Knowledge Base" || rec.status !== "Approved";
  });
  if (kbNotApproved.length > 0) {
    return NextResponse.json(
      {
        error:
          "Only approved Knowledge Base records can be attached. Invalid: " +
          kbNotApproved.join(", "),
      },
      { status: 400 }
    );
  }

  const compute =
    body.compute === undefined ? defaultAgentCompute() : body.compute;
  if (!isAgentCompute(compute)) {
    return NextResponse.json(
      {
        error:
          "compute must contain a valid agentRuntimeId and modelRuntimeId from /api/runtimes",
      },
      { status: 400 }
    );
  }

  // The selected model runtime must agree with where the model is actually
  // served, otherwise the field is decorative: picking a Databricks runtime for
  // a Bedrock model (or vice versa) would silently execute somewhere else.
  // SHARED rule — the same one the resolver enforces. The previous local copy
  // covered only Bedrock and Databricks, so an OpenAI- or Anthropic-served
  // model with a databricks-* runtime was accepted here and refused later at
  // workflow-bind time.
  const mismatch = planeMismatch(
    compute.modelRuntimeId,
    catalogModel.inferenceProvider
  );
  if (mismatch) {
    return NextResponse.json({ error: mismatch }, { status: 400 });
  }

  const agent: AgentConfig = {
    id: newId("agent"),
    name: body.name,
    description: body.description ?? "",
    tenantId: tenant.id,
    modelId: body.modelId,
    systemPrompt: body.systemPrompt ?? "",
    toolRefs,
    knowledgeRefs,
    memoryRefs,
    compute,
    visibility: body.visibility ?? "private",
    status: body.status ?? "draft",
    createdAt: new Date().toISOString(),
  };
  store.agents.unshift(agent);
  logAudit({
    category: "agent",
    action: "create",
    actor: "console-user",
    tenantId: tenant.id,
    detail: `Created agent '${agent.name}' in ${tenant.tenantName} (${agent.visibility})`,
  });
  return NextResponse.json(agent, { status: 201 });
}

/**
 * DELETE /api/agents?id=<id>
 *
 * There was no way to remove an agent at all — the route was GET + POST only,
 * so a mistyped agent was permanent. That was tolerable while the store was
 * wiped on every restart and became a real gap once it was not.
 *
 * REFUSES if a workflow step is bound to the agent. Deleting it would leave
 * `step.agentId` pointing at nothing, and `resolveStep` fails that with
 * "references agent X, which does not exist" at RUN time — far from the
 * deletion that caused it. Better to say so here.
 */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const index = store.agents.findIndex((a) => a.id === id);
  if (index < 0) {
    return NextResponse.json({ error: `unknown agent '${id}'` }, { status: 404 });
  }
  const agent = store.agents[index];

  const boundSteps = store.workflows.flatMap((w) =>
    w.steps
      .filter((s) => s.agentId === agent.id)
      .map((s) => `${w.name} / ${s.name}`)
  );
  if (boundSteps.length > 0) {
    return NextResponse.json(
      {
        error:
          `'${agent.name}' is bound to ${boundSteps.length} workflow step(s): ` +
          `${boundSteps.join(", ")}. Unbind or delete those first.`,
        boundSteps,
      },
      { status: 409 }
    );
  }

  store.agents.splice(index, 1);
  logAudit({
    category: "agent",
    action: "delete",
    actor: "console-user",
    tenantId: agent.tenantId,
    detail: `Deleted agent '${agent.name}'`,
  });
  return NextResponse.json({ deleted: agent.id, name: agent.name });
}
