import { NextRequest, NextResponse } from "next/server";
import { authorizeTransition } from "@/lib/approvals";
import { store, newId, logAudit } from "@/lib/store";
import {
  RegistryValidationError,
  assertName,
  assertRecordNameFree,
  assertRegistryNameFree,
  assertRegistryRemovable,
  decideRecordDeletion,
  findRecordUsage,
} from "@/lib/registry/validate";
import {
  McpSchema,
  Registry,
  RegistryRecord,
  RecordStatus,
} from "@/lib/types";

// GET → both the registries (containers) and their records.
export async function GET() {
  return NextResponse.json({
    registries: store.registries,
    records: store.records,
  });
}

type CreateRegistryBody = { kind: "registry" } & Partial<Registry>;
type CreateRecordBody = { kind: "record" } & Partial<RegistryRecord>;
type Body = CreateRegistryBody | CreateRecordBody;

// Simulate auto-discovery of tools from a live MCP endpoint.
function discoverTools(endpoint: string): string[] {
  if (endpoint.includes("knowledge-mcp")) {
    return [
      "aws___search_documentation",
      "aws___read_documentation",
      "aws___recommend",
    ];
  }
  // Generic fallback for an unknown MCP endpoint.
  return ["list_tools", "call_tool"];
}

/** Map a validation failure onto its status, so a conflict is not a 500. */
function validationResponse(e: unknown): NextResponse {
  if (e instanceof RegistryValidationError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
  return NextResponse.json({ error: (e as Error).message }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Body;

  // ---- CreateRegistry (the top-level container) ----
  if (body.kind === "registry") {
    let registryName: string;
    try {
      registryName = assertName("Registry name", body.name);
      // Two registries with the same name cannot be told apart in a picker, so
      // a reviewer approving a record would not know which container it is in.
      assertRegistryNameFree(registryName, store.registries);
    } catch (e) {
      return validationResponse(e);
    }
    const registry: Registry = {
      id: newId("registry"),
      name: registryName,
      description: body.description ?? "",
      // Default autoApproval:false → records start in Draft.
      autoApproval: body.autoApproval ?? false,
      createdAt: new Date().toISOString(),
    };
    store.registries.unshift(registry);
    logAudit({
      category: "registry",
      action: "create-registry",
      actor: "console-user",
      detail: `Created registry '${registry.name}'`,
    });
    return NextResponse.json(registry, { status: 201 });
  }

  // ---- Create Record (published into a registry, starts as Draft) ----
  if (body.kind === "record") {
    if (!body.registryId || !body.type || !body.recordSource) {
      return NextResponse.json(
        { error: "registryId, type and recordSource are required" },
        { status: 400 }
      );
    }
    if (body.tenantId && !store.tenants.some((t) => t.id === body.tenantId)) {
      return NextResponse.json(
        {
          error:
            `tenantId '${body.tenantId}' is not a known tenant. Omit it for a ` +
            `platform-provided record available to every tenant.`,
        },
        { status: 400 }
      );
    }
    const registry = store.registries.find((r) => r.id === body.registryId);
    if (!registry) {
      return NextResponse.json(
        { error: "registry not found" },
        { status: 404 }
      );
    }

    // Synchronize-from-endpoint records must carry a valid HTTPS endpoint.
    if (body.recordSource === "synchronize-from-endpoint") {
      if (!body.endpoint || !/^https:\/\//i.test(body.endpoint)) {
        return NextResponse.json(
          { error: "A valid HTTPS endpoint is required for synchronize-from-endpoint records." },
          { status: 400 }
        );
      }
    }

    // Derive a record name from the endpoint host if not provided.
    let name = body.name?.trim();
    if (!name) {
      if (body.endpoint) {
        try {
          name = new URL(body.endpoint).hostname.replace(/[^a-zA-Z0-9]+/g, "_");
        } catch {
          name = "record";
        }
      } else {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }
    }

    try {
      name = assertName("Record name", name);
      assertRecordNameFree(name, body.registryId, store.records);
    } catch (e) {
      return validationResponse(e);
    }

    let tools: string[] = [];
    const mcpSchema = body.mcpSchema as McpSchema | undefined;

    if (body.recordSource === "synchronize-from-endpoint") {
      // Auto-discover tools from the live endpoint over MCP.
      tools = body.endpoint ? discoverTools(body.endpoint) : [];
    } else if (mcpSchema?.toolSchema) {
      // Define-manually → tools come from the pasted schema.
      tools = mcpSchema.toolSchema.map((t) => t.name);
    }

    const record: RegistryRecord = {
      id: newId("rec"),
      registryId: body.registryId,
      name,
      description: body.description ?? "",
      recordSource: body.recordSource,
      type: body.type,
      credentialType: body.credentialType ?? "No authorization",
      // autoApproval decides the initial status.
      status: registry.autoApproval ? "Approved" : "Draft",
      endpoint: body.endpoint,
      mcpSchema,
      knowledgeConfig: body.knowledgeConfig,
      // Memory records carry AgentCore identifiers, the namespace template and
      // the scope ceiling. Identifiers and bounds only — never a credential.
      memoryConfig: body.memoryConfig,
      tools,
      owner: body.owner ?? "console-user",
      // Tenant-onboarded when supplied; PLATFORM-PROVIDED when absent, which
      // keeps every existing record available to everyone. Validated so an
      // unknown tenant cannot create a record nobody can ever attach.
      ...(body.tenantId ? { tenantId: body.tenantId } : {}),
      createdAt: new Date().toISOString(),
    };
    store.records.unshift(record);
    logAudit({
      category: "registry",
      action: "create-record",
      actor: record.owner,
      detail: `Created ${record.type} record '${record.name}' (${record.status})`,
    });
    return NextResponse.json(record, { status: 201 });
  }

  return NextResponse.json({ error: "unknown kind" }, { status: 400 });
}

// PATCH → advance a record through its governance lifecycle.
// Draft → Pending approval → Approved | Rejected ; Approved → Deprecated.
const TRANSITIONS: Record<RecordStatus, RecordStatus[]> = {
  Draft: ["Pending approval"],
  "Pending approval": ["Approved", "Rejected"],
  Approved: ["Deprecated"],
  Rejected: ["Draft"],
  Deprecated: [],
};

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    id: string;
    status: RecordStatus;
    /** Who is making this transition: submitter for → Pending, reviewer for decisions. */
    personaId?: string;
    reviewerPersonaId?: string;
    submitterPersonaId?: string;
  };
  const record = store.records.find((r) => r.id === body.id);
  if (!record) {
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  }
  const allowed = TRANSITIONS[record.status] ?? [];
  if (!allowed.includes(body.status)) {
    return NextResponse.json(
      {
        error: `Invalid transition ${record.status} → ${body.status}. Allowed: ${
          allowed.join(", ") || "none"
        }`,
      },
      { status: 400 }
    );
  }
  // Maker-checker: see lib/approvals.ts.
  const who = authorizeTransition({
    next: body.status,
    tenantId: record.tenantId,
    resourceId: record.id,
    submittedByPersonaId: record.submittedByPersonaId,
    personaId: body.reviewerPersonaId ?? body.submitterPersonaId ?? body.personaId,
  });
  if (!who.ok) {
    logAudit({ category: "registry", action: "update-status-denied",
      actor: body.reviewerPersonaId ?? body.submitterPersonaId ?? body.personaId ?? "anonymous",
      ...(record.tenantId ? { tenantId: record.tenantId } : {}),
      detail: `DENY '${record.name}': ${record.status} → ${body.status}: ${who.error}` });
    return NextResponse.json({ error: who.error, code: who.code }, { status: who.status });
  }
  const from = record.status;
  record.status = body.status;
  if (who.role === "submit" && who.persona) record.submittedByPersonaId = who.persona.id;
  if (who.role === "decide" && who.persona) {
    record.decidedBy = who.persona.name;
    record.decidedByPersonaId = who.persona.id;
    record.decidedAt = new Date().toISOString();
  }
  logAudit({
    category: "registry",
    action: "update-status",
    actor: who.persona?.name ?? "console-user",
    ...(record.tenantId ? { tenantId: record.tenantId } : {}),
    detail: `Record '${record.name}': ${from} → ${body.status}` +
      (who.persona ? ` by ${who.persona.name} (${who.persona.id})` : ""),
  });
  return NextResponse.json(record);
}

/**
 * Remove a registry entry.
 *
 *   DELETE /api/registry?recordId=rec-…    one record
 *   DELETE /api/registry?registryId=reg-…  an EMPTY container
 *
 * A record that is still referenced is refused, and the response names what
 * references it so an operator can go and detach it. An Approved record is
 * DEPRECATED rather than deleted: it passed review and the audit trail points
 * at it, so it stops being attachable but stays resolvable. Only a Draft or
 * Rejected record — never in force, nothing looking for it — is actually
 * removed. The outcome is always reported, because "deleted" and "deprecated"
 * mean different things to whoever asked.
 */
export async function DELETE(req: NextRequest) {
  const recordId = req.nextUrl.searchParams.get("recordId");
  const registryId = req.nextUrl.searchParams.get("registryId");

  if (!recordId && !registryId) {
    return NextResponse.json(
      { error: "recordId or registryId is required" },
      { status: 400 }
    );
  }

  if (recordId) {
    const record = store.records.find((r) => r.id === recordId);
    if (!record) {
      return NextResponse.json({ error: "record not found" }, { status: 404 });
    }
    const usage = findRecordUsage(recordId, store.agents, store.workflows);
    const decision = decideRecordDeletion(record, usage);

    if (decision.action === "refuse") {
      logAudit({
        category: "registry",
        action: "delete-refused",
        actor: "console-user",
        detail: `REFUSED removal of record '${record.name}': ${decision.reason}`,
      });
      return NextResponse.json(
        {
          error: decision.reason,
          code: "REGISTRY_IN_USE",
          usage,
        },
        { status: 409 }
      );
    }

    if (decision.action === "deprecate") {
      const from = record.status;
      record.status = "Deprecated";
      logAudit({
        category: "registry",
        action: "deprecate-record",
        actor: "console-user",
        detail:
          `Deprecated record '${record.name}' (was ${from}) instead of ` +
          `deleting it — it passed review and the audit trail refers to it.`,
      });
      return NextResponse.json({
        outcome: "deprecated",
        record,
        reason: decision.reason,
      });
    }

    store.records = store.records.filter((r) => r.id !== recordId);
    logAudit({
      category: "registry",
      action: "delete-record",
      actor: "console-user",
      detail: `Deleted ${record.status} record '${record.name}' (${record.id})`,
    });
    return NextResponse.json({
      outcome: "deleted",
      recordId,
      reason: decision.reason,
    });
  }

  const registry = store.registries.find((r) => r.id === registryId);
  if (!registry) {
    return NextResponse.json({ error: "registry not found" }, { status: 404 });
  }
  try {
    // Never cascade: deleting a container must not quietly delete reviewed
    // records inside it.
    assertRegistryRemovable(registry.id, store.records);
  } catch (e) {
    logAudit({
      category: "registry",
      action: "delete-refused",
      actor: "console-user",
      detail: `REFUSED removal of registry '${registry.name}': not empty`,
    });
    return validationResponse(e);
  }
  store.registries = store.registries.filter((r) => r.id !== registryId);
  logAudit({
    category: "registry",
    action: "delete-registry",
    actor: "console-user",
    detail: `Deleted empty registry '${registry.name}' (${registry.id})`,
  });
  return NextResponse.json({ outcome: "deleted", registryId });
}
