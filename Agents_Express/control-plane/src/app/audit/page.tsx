"use client";

import { useEffect, useState } from "react";
import { PageHeader, EmptyState } from "@/components/ui";
import { getJSON } from "@/lib/api";
import { AuditEvent, AuditCategory } from "@/lib/types";

const CATEGORIES: (AuditCategory | "all")[] = [
  "all",
  "registry",
  "agent",
  "policy",
  "playground",
  "model",
  "graph",
  "a2a",
];

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [filter, setFilter] = useState<AuditCategory | "all">("all");

  useEffect(() => {
    getJSON<AuditEvent[]>("/api/audit").then(setEvents);
  }, []);

  const shown =
    filter === "all" ? events : events.filter((e) => e.category === filter);

  return (
    <>
      <PageHeader
        title="Audit Trail"
        subtitle="Every control-plane action is attributable and reviewable — the governance backbone."
      />
      <div className="p-8">
        <div className="mb-5 flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`badge border px-3 py-1 capitalize ${
                filter === c
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-slate-300 bg-white text-slate-600"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <EmptyState text="No audit events for this filter." />
        ) : (
          <div className="card divide-y divide-slate-100">
            {shown.map((e) => (
              <div key={e.id} className="flex items-start gap-4 px-5 py-3">
                <span className="badge mt-0.5 bg-slate-100 text-slate-600 capitalize">
                  {e.category}
                </span>
                <div className="flex-1">
                  <div className="text-sm text-slate-800">{e.detail}</div>
                  <div className="text-xs text-slate-400">
                    <span className="font-medium text-slate-500">{e.action}</span>{" "}
                    · {e.actor} · {new Date(e.at).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
