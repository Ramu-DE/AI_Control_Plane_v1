import { NextResponse } from "next/server";
import { store } from "@/lib/store";

// Approval Inbox — aggregates everything in a pending/review state so an
// approver has one place to act, instead of hunting through per-record menus.
export async function GET() {
  const registryPending = store.records
    .filter((r) => r.status === "Draft" || r.status === "Pending approval")
    .map((r) => ({
      id: r.id,
      kind: "registry-record" as const,
      name: r.name,
      detail: `${r.type} record in registry`,
      status: r.status,
      owner: r.owner,
      createdAt: r.createdAt,
    }));

  const policyReview = store.libraryPolicies
    .filter((p) => p.status === "Draft" || p.status === "In Review")
    .map((p) => ({
      id: p.id,
      kind: "library-policy" as const,
      name: p.name,
      detail: `Cedar policy (${p.effect})`,
      status: p.status,
      owner: p.creator,
      createdAt: p.createdAt,
    }));

  return NextResponse.json({
    items: [...registryPending, ...policyReview],
    counts: {
      total: registryPending.length + policyReview.length,
      registry: registryPending.length,
      policy: policyReview.length,
    },
  });
}
