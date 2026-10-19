import { NextRequest, NextResponse } from "next/server";
import { store, newId, logAudit } from "@/lib/store";
import { Persona } from "@/lib/types";

export async function GET() {
  return NextResponse.json({
    personas: store.personas,
    groups: store.cognitoGroups,
  });
}

// Map a Cognito group to evaluator attributes used by the playground.
function attrsForGroups(groups: string[]): Record<string, string> {
  if (groups.includes("seniority_director"))
    return { group: "seniority_director", role: "director", approvalLimit: "Infinity" };
  if (groups.includes("seniority_manager"))
    return { group: "seniority_manager", role: "manager", approvalLimit: "5000" };
  return { group: "seniority_ic", role: "ic", approvalLimit: "0" };
}

function randomSub(): string {
  const h = () => Math.random().toString(16).slice(2, 6);
  return `${h()}${h()}-${h()}-70${h().slice(0, 2)}-${h()}-${h()}${h()}${h()}`;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    name?: string;
    email?: string;
    provider?: Persona["provider"];
    groups?: string[];
  };
  if (!body.name || !body.email || !body.groups?.length) {
    return NextResponse.json(
      { error: "name, email and at least one group are required" },
      { status: 400 }
    );
  }
  const persona: Persona = {
    id: newId("persona"),
    name: body.name,
    email: body.email,
    sub: randomSub(),
    provider: body.provider ?? "AWS Cognito",
    groups: body.groups,
    attributes: attrsForGroups(body.groups),
  };
  store.personas.push(persona);
  logAudit({
    category: "policy",
    action: "create-persona",
    actor: "console-user",
    detail: `Created persona '${persona.name}' (${persona.groups.join(", ")})`,
  });
  return NextResponse.json(persona, { status: 201 });
}
