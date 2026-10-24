import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { listJobs } from "@/lib/docintel/service";
import { listCorpora } from "@/lib/ragfactory/service";

// Approval Inbox — aggregates everything in a pending/review state so an
// approver has one place to act, instead of hunting through per-record menus.
//
// Documents awaiting finalization and corpora awaiting approval are listed
// only for `?personaId=` and only where that persona may view them (their
// names can be personal data, e.g. a CV). Deciding still goes through the
// module's own governed endpoint.
export async function GET(req: NextRequest) {
  const personaId = req.nextUrl.searchParams.get("personaId") ?? "";
  const nameOf = (id?: string) => store.personas.find((p) => p.id === id)?.name ?? id ?? "";
  const known = store.personas.some((p) => p.id === personaId);
  const documentPending = known
    ? listJobs(personaId)
        .filter((j) => j.status === "pending-finalization")
        .map((j) => ({
          id: j.documentId,
          kind: "document" as const,
          name: j.fileName,
          detail: `Document in ${j.tenantId}: finalize (approver+, not the submitter)`,
          status: "Pending finalization",
          owner: nameOf(j.submittedBy),
          submittedBy: j.submittedBy,
          tenantId: j.tenantId,
          createdAt: j.submittedAt ?? j.createdAt,
        }))
    : [];
  // Exceptions: documents whose validation failed, worst first. Work for an
  // analyst (fix or justify), so the inbox offers Open, not a decision.
  const documentExceptions = known
    ? listJobs(personaId)
        .filter((j) => j.route === "exception" && ["extracted", "in-review"].includes(j.status))
        .map((j) => {
          const issues = j.validation?.issues ?? [];
          const blocking = issues.filter((i) => i.severity === "block").length;
          return {
            id: j.documentId,
            kind: "document-exception" as const,
            name: j.fileName,
            detail: `${j.tenantId}: ${blocking} blocking, ${issues.length - blocking} warning(s)` +
              (issues[0] ? ` (${issues[0].message.slice(0, 90)})` : ""),
            status: "Needs review",
            owner: nameOf(j.createdBy),
            tenantId: j.tenantId,
            createdAt: j.updatedAt,
            blocking,
          };
        })
        .sort((a, b) => b.blocking - a.blocking)
    : [];
  const corpusPending = known
    ? listCorpora(personaId)
        .filter((c) => c.status === "Pending approval")
        .map((c) => ({
          id: c.corpusId,
          kind: "corpus" as const,
          name: c.name,
          detail: `RAG corpus in ${c.tenantId}: ${c.members.length} document(s), pattern ${c.patternId}`,
          status: c.status,
          owner: nameOf(c.submittedBy),
          submittedBy: c.submittedBy,
          tenantId: c.tenantId,
          createdAt: c.submittedAt ?? c.createdAt,
        }))
    : [];

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
    items: [...documentPending, ...documentExceptions, ...corpusPending, ...registryPending, ...policyReview],
    counts: {
      total: documentPending.length + documentExceptions.length + corpusPending.length + registryPending.length + policyReview.length,
      registry: registryPending.length,
      policy: policyReview.length,
      documents: documentPending.length,
      exceptions: documentExceptions.length,
      corpora: corpusPending.length,
    },
  });
}
