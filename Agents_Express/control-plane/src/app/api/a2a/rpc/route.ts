// A2A inbound RPC — JSON-RPC 2.0 `message/send`.
//
// This is the governed entry point an external agent uses to invoke one of this
// platform's agents. The order fails closed at every step:
//
//   1. bearer token must match A2A_INBOUND_TOKEN (absent ⇒ feature disabled)
//   2. the request must be a well-formed message/send with text
//   3. the addressed skill must be a READY agent
//   4. Cedar must permit runAgent for the configured service persona
//   5. the agent executes with its own model, prompt and approved tools
//   6. the call is audited either way
//
// An external caller cannot choose the persona, the model, or the tools. It
// chooses a skill; everything else is the platform's decision.

import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import {
  A2AServerError,
  INBOUND_PERSONA_VAR,
  auditInbound,
  authenticateInbound,
  errorEnvelope,
  parseSendRequest,
  peekRequestId,
  resolveTargetAgent,
  successEnvelope,
} from "@/lib/a2a/server";
import { authorizeAgentStep } from "@/lib/workflow/govern";
import { resolveStep } from "@/lib/workflow/resolve";
// Provider calls go through the broker, so an inbound A2A call is subject to
// the same model allowlist as a workflow step. An external caller choosing a
// skill must not be a way around a tenant's model policy.
import { ModelAccessDenied, invokeStep } from "@/lib/modelBroker";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  let rpcId: string | number | null = null;
  try {
    const { personaId } = authenticateInbound(req.headers.get("authorization"));

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new A2AServerError("invalid JSON body", 400, -32700);
    }
    // Echo the id even when the rest of the request is rejected, so a caller
    // can match the failure to the call it made.
    rpcId = peekRequestId(body);
    const parsed = parseSendRequest(body);
    rpcId = parsed.id;

    const agent = resolveTargetAgent(parsed.skillId);

    // Same Cedar gate as a workflow step. An inbound call is not privileged.
    const authz = authorizeAgentStep(agent.id, personaId);
    if (!authz.allowed) {
      auditInbound({
        outcome: "refused",
        actor: personaId,
        detail:
          `DENY inbound A2A call to agent '${agent.name}' — ` +
          `${authz.agentScoped.evaluated ? authz.agentScoped.reason : authz.perimeter.reason}`,
      });
      return NextResponse.json(
        errorEnvelope(rpcId, -32000, `not authorized to invoke '${agent.name}'`),
        { status: 403 }
      );
    }

    // Resolve exactly as a workflow step does, so an inbound call cannot reach
    // a tool or model the agent is not entitled to.
    const resolved = resolveStep(
      {
        id: `a2a-${Date.now().toString(36)}`,
        name: agent.name,
        agentId: agent.id,
        prompt: "",
        toolRefs: [],
        knowledgeRefs: [],
        reviewGate: false,
      },
      {
        agents: store.agents,
        models: store.models,
        records: store.records,
        tenants: store.tenants,
        workflowTenantId: agent.tenantId,
      }
    );

    // `resolved.step` already carries the composed prompt and the resolved
    // model — reuse it rather than rebuilding, so an inbound call runs exactly
    // what a workflow step would.
    const step = resolved.step;

    let output = "";
    let toolCallCount = 0;
    let totalTokens = 0;
    try {
      const r = await invokeStep(
        step, parsed.text, [], resolved.executableTools,
        {
          tenantId: agent.tenantId,
          personaId,
          origin: "a2a-inbound",
          agentId: agent.id,
          modelRuntimeId: agent.compute.modelRuntimeId,
        }
      );
      output = r.output;
      toolCallCount = r.toolCallCount;
      totalTokens = r.totalTokens;
    } catch (e) {
      if (e instanceof ModelAccessDenied) {
        auditInbound({
          outcome: "refused",
          actor: personaId,
          detail: `DENY inbound A2A call to '${agent.name}' — ${e.message}`,
        });
        return NextResponse.json(
          errorEnvelope(rpcId, -32000,
            `not authorized to invoke '${agent.name}': ${e.message}`),
          { status: 403 }
        );
      }
      throw e;
    }

    const text = output.trim();
    auditInbound({
      outcome: "accepted",
      actor: personaId,
      detail:
        `Inbound A2A call invoked agent '${agent.name}' on ${resolved.executor}: ` +
        `${toolCallCount} tool call(s), ${totalTokens} token(s), ` +
        `${text.length} char(s) returned`,
    });

    if (!text) {
      // Returning an empty success would make the caller believe the agent had
      // nothing to say, rather than that something went wrong here.
      return NextResponse.json(
        errorEnvelope(rpcId, -32000, "the agent produced no output"),
        { status: 502 }
      );
    }
    return NextResponse.json(successEnvelope(parsed.id, text, parsed.contextId));
  } catch (e) {
    if (e instanceof A2AServerError) {
      // A 503 means not configured, which is not worth auditing on every probe.
      if (e.status !== 503) {
        auditInbound({
          outcome: "refused",
          actor: process.env[INBOUND_PERSONA_VAR] ?? "unknown",
          detail: `Inbound A2A refused (${e.status}): ${e.message}`,
        });
      }
      return NextResponse.json(errorEnvelope(rpcId, e.rpcCode, e.message), {
        status: e.status,
      });
    }
    return NextResponse.json(
      errorEnvelope(rpcId, -32603, (e as Error).message),
      { status: 500 }
    );
  }
}
