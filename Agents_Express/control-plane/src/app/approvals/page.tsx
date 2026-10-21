"use client";

import { useEffect, useState } from "react";
import { PageHeader, Pill, EmptyState } from "@/components/ui";
import { getJSON, sendJSON } from "@/lib/api";

interface ApprovalItem {
  id: string;
  kind: "registry-record" | "library-policy";
  name: string;
  detail: string;
  status: string;
  owner: string;
  createdAt: string;
}

export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const d = await getJSON<{ items: ApprovalItem[] }>("/api/approvals");
    setItems(d.items);
  }
  useEffect(() => {
    load();
  }, []);

  // Advance an item one step toward approval, or approve/reject outright.
  async function act(item: ApprovalItem, action: "submit" | "approve" | "reject") {
    setBusy(item.id);
    setError(null);
    try {
      if (item.kind === "registry-record") {
        // Draft -> Pending approval -> Approved | Rejected
        if (action === "submit") {
          await sendJSON("/api/registry", "PATCH", {
            id: item.id,
            status: "Pending approval",
          });
        } else if (action === "approve") {
          if (item.status === "Draft") {
            await sendJSON("/api/registry", "PATCH", {
              id: item.id,
              status: "Pending approval",
            });
          }
          await sendJSON("/api/registry", "PATCH", {
            id: item.id,
            status: "Approved",
          });
        } else {
          if (item.status === "Draft") {
            await sendJSON("/api/registry", "PATCH", {
              id: item.id,
              status: "Pending approval",
            });
          }
          await sendJSON("/api/registry", "PATCH", {
            id: item.id,
            status: "Rejected",
          });
        }
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

  return (
    <>
      <PageHeader
        title="Approval Inbox"
        subtitle="Everything awaiting review in one place — registry records and policies. Approve, reject, or submit for review."
      />
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            ["Pending total", items.length],
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
                        {it.kind === "registry-record" ? "Registry" : "Policy"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Pill status={it.status} />
                    </td>
                    <td className="px-4 py-3 text-slate-600">{it.owner}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busy === it.id}
                          onClick={() => act(it, "approve")}
                        >
                          Approve
                        </button>
                        {it.kind === "registry-record" && (
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy === it.id}
                            onClick={() => act(it, "reject")}
                          >
                            Reject
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
