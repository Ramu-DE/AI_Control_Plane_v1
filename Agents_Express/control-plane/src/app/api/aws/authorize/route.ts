import { NextRequest } from "next/server";
import { handle } from "@/lib/aws/http";
import { isAuthorized } from "@/lib/aws/discovery";

export const dynamic = "force-dynamic";

// Verified Permissions IsAuthorized adapter — a read-only authorization check
// with minimal, validated identifiers. No policy or resource is created or
// mutated. Missing fields yield a clear 4xx via the discovery validation.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await isAuthorized({
      policyStoreId: String(body.policyStoreId ?? ""),
      principalType: String(body.principalType ?? ""),
      principalId: String(body.principalId ?? ""),
      actionType: String(body.actionType ?? ""),
      actionId: String(body.actionId ?? ""),
      resourceType: String(body.resourceType ?? ""),
      resourceId: String(body.resourceId ?? ""),
    });
    return { result };
  });
}
