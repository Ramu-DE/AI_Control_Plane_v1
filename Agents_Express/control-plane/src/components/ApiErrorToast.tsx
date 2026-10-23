"use client";

import { useEffect, useState } from "react";
import { onApiFailure, type ApiFailure } from "@/lib/api";

/**
 * The floor for API failure reporting.
 *
 * Mounted once in the root layout, so a refused request is always visible even
 * on a page whose handler forgot to catch. Eleven write handlers across six
 * pages had no try/catch at all, which is how "the Create button doesn't work"
 * happened: the request was sent, the server refused it, and the rejection had
 * nowhere to go — no message, no state change, modal still open.
 *
 * It does NOT replace page-level error handling. A page that shows the error
 * inline next to the field it belongs to is better, and those keep working;
 * this catches everything else.
 *
 * Deliberately not auto-dismissing on a timer. These are governance refusals —
 * a plan limit, a cross-tenant tool, a model not on the allowlist — and the
 * message names what to change. Reading it is the point.
 */
export function ApiErrorToast() {
  const [failures, setFailures] = useState<ApiFailure[]>([]);

  useEffect(() => onApiFailure((f) => {
    setFailures((prev) => {
      // Collapse an identical repeat: a poll that fails every two seconds
      // should not stack forty copies of the same message.
      if (prev.some((p) => p.message === f.message && f.at - p.at < 10_000)) {
        return prev;
      }
      return [...prev.slice(-2), f];
    });
  }), []);

  if (failures.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-md flex-col gap-2">
      {failures.map((f) => (
        <div
          key={`${f.at}-${f.url}`}
          className="pointer-events-auto rounded-xl border border-rose-300 bg-white p-3 shadow-lg"
          role="alert"
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 text-rose-600">⚠</span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-rose-900">
                Request refused — {f.status}
              </div>
              <p className="mt-1 break-words text-xs leading-relaxed text-slate-700">
                {f.message}
              </p>
              <div className="mono mt-1 text-[10px] text-slate-400">
                {f.method} {f.url}
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 text-slate-400 hover:text-slate-700"
              aria-label="Dismiss"
              onClick={() =>
                setFailures((prev) => prev.filter((p) => p.at !== f.at))
              }
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
