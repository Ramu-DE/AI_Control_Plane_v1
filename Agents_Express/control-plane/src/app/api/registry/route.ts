import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
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

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Body;

  // ---- CreateRegistry (the top-level container) ----
  if (body.kind === "registry") {
    if (!body.name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const registry: Registry = {
      id: newId("registry"),
      name: body.name,
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
      tools,
      owner: body.owner ?? "console-user",
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
  const body = (await req.json()) as { id: string; status: RecordStatus };
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
  const from = record.status;
  record.status = body.status;
  logAudit({
    category: "registry",
    action: "update-status",
    actor: "workshop-administrator",
    detail: `Record '${record.name}': ${from} → ${body.status}`,
  });
  return NextResponse.json(record);
}
