"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/api";

interface AwsStatus {
  ok: boolean;
  mode: "local" | "aws";
  region: string | null;
  identity?: { account: string } | null;
}

// A tiny, link-styled badge that shows whether the app is running against live
// AWS or the local in-memory store. It links to the full /aws-resources page.
// Safe to drop into any page header; fails closed to "local" on error.
export function AwsModeBadge() {
  const [status, setStatus] = useState<AwsStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJSON<AwsStatus>("/api/aws/status")
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled)
          setStatus({ mode: "local", region: null, ok: false, identity: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mode = status?.mode ?? "local";
  const isAws = mode === "aws";
  const label = isAws ? "AWS" : "Local";
  const title = isAws
    ? `Live AWS${status?.region ? ` · ${status.region}` : ""}${
        status?.identity?.account ? ` · ${status.identity.account}` : ""
      }`
    : "Local in-memory store (no AWS calls)";

  return (
    <Link
      href="/aws-resources"
      title={title}
      className={`badge ${
        isAws ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isAws ? "bg-green-500" : "bg-slate-400"
        }`}
      />
      {label}
    </Link>
  );
}
