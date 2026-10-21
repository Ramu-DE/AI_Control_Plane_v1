// Shared helpers for the /api/aws/* route handlers. Centralizes the honest
// mapping of execution-mode / configuration / AWS SDK errors into stable JSON
// responses, so each route stays small and consistent.
//
// IMPORTANT: never include credentials or raw secrets in responses or logs.
// We only surface error *names* and SDK-provided messages (which do not carry
// secret material).

import { NextResponse } from "next/server";
import { AwsConfigError } from "@/lib/aws/config";
import { classifyAwsError } from "@/lib/aws/normalize";

export function configErrorResponse(err: AwsConfigError) {
  // MODE_LOCAL is an expected, non-error state (412 Precondition) — the UI uses
  // it to render the "local mode" story rather than a failure.
  const status = err.code === "MODE_LOCAL" ? 412 : 400;
  return NextResponse.json(
    { ok: false, code: err.code, error: err.message },
    { status }
  );
}

export function awsErrorResponse(err: unknown) {
  const c = classifyAwsError(err);
  const status =
    c.kind === "access-denied"
      ? 403
      : c.kind === "not-found"
        ? 404
        : c.kind === "throttling"
          ? 429
          : 500;
  return NextResponse.json(
    { ok: false, code: c.kind, errorName: c.name, error: c.message },
    { status }
  );
}

// Run an async AWS handler with uniform error mapping. Config errors and AWS
// SDK errors are translated to honest responses; anything else is a 500.
export async function handle(
  fn: () => Promise<unknown>
): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (err) {
    if (err instanceof AwsConfigError) return configErrorResponse(err);
    return awsErrorResponse(err);
  }
}
