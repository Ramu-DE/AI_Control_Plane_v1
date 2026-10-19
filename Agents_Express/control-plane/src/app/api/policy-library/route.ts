import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { LibraryPolicy, LibraryPolicyStatus } from "@/lib/types";

export async function GET() {
  return NextResponse.json({
    policies: store.libraryPolicies,
    groups: store.cognitoGroups,
  });
}

// POST → create a new policy (initial Draft, version 1).
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    name?: string;
    description?: string;
    nl?: string;
    cedar?: string;
    message?: string;
  };
  if (!body.name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const policy: LibraryPolicy = {
    id: newId("lib"),
    name: body.name,
    description: body.description ?? "",
    status: "Draft",
    effect: /^\s*forbid/.test(body.cedar ?? "") ? "forbid" : "permit",
    creator: "admin@workshop.local",
    createdAt: now,
    updatedAt: now,
    versions: [
      {
        version: 1,
        nl: body.nl ?? "",
        cedar: body.cedar ?? "",
        message: body.message ?? "Policy created as initial draft",
        author: "Workshop Admin",
        at: now,
      },
    ],
    activity: [
      {
        kind: "created",
        message: "Policy created as initial draft",
        author: "Workshop Admin",
        at: now,
      },
    ],
  };
  store.libraryPolicies.unshift(policy);
  logAudit({
    category: "policy",
    action: "create-policy",
    actor: "Workshop Admin",
    detail: `Created policy '${policy.name}'`,
  });
  return NextResponse.json(policy, { status: 201 });
}

const STATUS_TRANSITIONS: Record<LibraryPolicyStatus, LibraryPolicyStatus[]> = {
  Draft: ["In Review", "Published"],
  "In Review": ["Published", "Draft"],
  Published: ["Archived"],
  Archived: ["Draft"],
};

// PATCH → add a new version OR change status.
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as
    | { id: string; op: "version"; nl: string; cedar: string; message: string }
    | { id: string; op: "status"; status: LibraryPolicyStatus };

  const policy = store.libraryPolicies.find((p) => p.id === body.id);
  if (!policy) {
    return NextResponse.json({ error: "policy not found" }, { status: 404 });
  }

  if (body.op === "version") {
    const version = policy.versions.length + 1;
    const now = new Date().toISOString();
    policy.versions.push({
      version,
      nl: body.nl,
      cedar: body.cedar,
      message: body.message,
      author: "Workshop Admin",
      at: now,
    });
    policy.activity.unshift({
      kind: "version",
      version,
      message: body.message,
      author: "Workshop Admin",
      at: now,
    });
    policy.updatedAt = now;
    policy.effect = /^\s*forbid/.test(body.cedar) ? "forbid" : "permit";
    logAudit({
      category: "policy",
      action: "new-version",
      actor: "Workshop Admin",
      detail: `${policy.name} → v${version}: ${body.message}`,
    });
    return NextResponse.json(policy);
  }

  if (body.op === "status") {
    const allowed = STATUS_TRANSITIONS[policy.status] ?? [];
    if (!allowed.includes(body.status)) {
      return NextResponse.json(
        {
          error: `Invalid transition ${policy.status} → ${body.status}. Allowed: ${
            allowed.join(", ") || "none"
          }`,
        },
        { status: 400 }
      );
    }
    const from = policy.status;
    policy.status = body.status;
    policy.updatedAt = new Date().toISOString();
    logAudit({
      category: "policy",
      action: "status-change",
      actor: "Workshop Admin",
      detail: `${policy.name}: ${from} → ${body.status}`,
    });
    return NextResponse.json(policy);
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
