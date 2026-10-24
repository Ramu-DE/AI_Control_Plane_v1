"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, Pill, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";
import { ActingAsSelect, useActingPersona } from "@/components/ActingAs";

interface ApprovalItem {
  id: string;
  kind: "registry-record" | "library-policy" | "document" | "document-exception" | "corpus";
  name: string;
  detail: string;
  status: string;
  owner: string;
  createdAt: string;
  submittedBy?: string;
  tenantId?: string;
}

const KIND_LABEL: Record<ApprovalItem["kind"], string> = {
  document: "Document",
  "document-exception": "Exception",
  corpus: "RAG corpus",
  "registry-record": "Registry",
  "library-policy": "Policy",
};

function openHref(it: ApprovalItem): string | null {
  if (it.kind === "document" || it.kind === "document-exception") return `/documents?doc=${encodeURIComponent(it.id)}`;
  if (it.kind === "corpus") return `/rag?corpus=${encodeURIComponent(it.id)}`;
  return null;
}

export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acting = useActingPersona();

  async function load() {
    const q = acting.personaId ? `?personaId=${encodeURIComponent(acting.personaId)}` : "";
    const d = await getJSON<{ items: ApprovalItem[] }>(`/api/approvals${q}`);
    setItems(d.items);
  }
  useEffect(() => {
    load();
  }, [acting.personaId]);

  // Advance an item one step toward approval, or approve/reject outright.
  async function act(item: ApprovalItem, action: "submit" | "approve" | "reject") {
    setBusy(item.id);
    setError(null);
    try {
      if (item.kind === "document" || item.kind === "corpus") {
        // Same governed endpoints as the module pages: approver+ in the
        // item's tenant, never the submitter, GxP / residency apply.
        if (!acting.personaId) throw new Error("Choose who is acting first.");
        let note = "";
        if (action === "reject") {
          note = window.prompt(item.kind === "document"
            ? "Why send it back? (shown to the submitter)" : "Why reject this corpus?") ?? "";
          if (item.kind === "document" && !note.trim()) throw new Error("Sending back needs a note.");
        }
        if (item.kind === "document") {
          await sendJSON("/api/docintel", "POST", {
            op: action === "reject" ? "sendBack" : "finalize", documentId: item.id, personaId: acting.personaId, note,
          });
        } else {
          await sendJSON("/api/ragfactory", "POST", {
            op: action === "reject" ? "reject" : "approve", corpusId: item.id, personaId: acting.personaId, note,
          });
        }
      } else if (item.kind === "registry-record") {
        // Maker-checker (lib/approvals.ts): a named submitter, then a DIFFERENT
        // approver. Approving straight from Draft would be one person doing
        // both, so a Draft is only ever submitted here.
        if (!acting.personaId) {
          throw new Error("Choose who is acting first: submitting needs analyst+, deciding needs approver+ in the record's tenant.");
        }
        if (action !== "submit" && item.status === "Draft") {
          throw new Error("Submit it for approval first. A different approver then decides (four-eyes rule).");
        }
        await sendJSON("/api/registry", "PATCH", {
          id: item.id,
          status: action === "submit" ? "Pending approval" : action === "approve" ? "Approved" : "Rejected",
          personaId: acting.personaId,
        });
      } else {
        // library policy: Draft -> In Review -> Published
        if (action === "submit") {
          await sendJSON("/api/policy-library", "PATCH", {
            id: item.id,
            op: "status",
            status: "In Review",
          });
        } else if (action === "approve") {
          if (item.status === "Draft") {
            await sendJSON("/api/policy-library", "PATCH", {
              id: item.id,
              op: "status",
              status: "In Review",
            });
          }
          await sendJSON("/api/policy-library", "PATCH", {
            id: item.id,
            op: "status",
            status: "Published",
          });
        }
      }
      await load();
    } catch (e) {
      setError((e as Error).message || "Action failed. Please retry.");
    } finally {
      setBusy(null);
    }
  }

  const registry = items.filter((i) => i.kind === "registry-record");
  const policy = items.filter((i) => i.kind === "library-policy");
  const docs = items.filter((i) => i.kind === "document" || i.kind === "document-exception" || i.kind === "corpus");

  return (
    <>
      <PageHeader
        title="Approval Inbox"
        subtitle="Everything awaiting review in one place: documents to finalize, RAG corpora, registry records and policies. Choose who you are acting as to see what you can decide."
      />
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="mb-4">
          <ActingAsSelect {...acting} />
        </div>
        <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-4">
          {[
            ["Pending total", items.length],
            ["Documents & corpora", docs.length],
            ["Registry records", registry.length],
            ["Policies", policy.length],
          ].map(([l, v]) => (
            <div key={l} className="card p-4">
              <div className="text-xs font-medium text-slate-400">{l}</div>
              <div className="mt-1 text-2xl font-semibold">{v}</div>
            </div>
          ))}
        </div>

        {items.length === 0 ? (
          <EmptyState text="Nothing awaiting approval. 🎉" />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{it.name}</div>
                      <div className="text-xs text-slate-500">{it.detail}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="badge bg-slate-100 text-slate-600">
                        {KIND_LABEL[it.kind]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Pill status={it.status} />
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {it.owner}
                      {it.submittedBy && it.submittedBy === acting.personaId && (
                        <div className="text-xs text-amber-700">you submitted this; another approver decides</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {openHref(it) && (
                          <Link className="btn-ghost" href={openHref(it)!}>Open</Link>
                        )}
                        {it.kind !== "document-exception" && <button
                          type="button"
                          className="btn-primary"
                          disabled={busy === it.id || (!!it.submittedBy && it.submittedBy === acting.personaId)}
                          onClick={() => act(it, "approve")}
                        >
                          {it.kind === "document" ? "Finalize" : it.kind === "corpus" ? "Approve & build" : "Approve"}
                        </button>}
                        {it.kind !== "library-policy" && it.kind !== "document-exception" && (
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy === it.id}
                            onClick={() => act(it, "reject")}
                          >
                            {it.kind === "document" ? "Send back" : "Reject"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
