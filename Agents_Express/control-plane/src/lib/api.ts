// Tiny typed fetch helpers for client components.
// Prefix API calls with the base path so they work both directly and when the
// app is served behind a path prefix (e.g. code-server's /proxy/3000).
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

// --------------------------------------------------------------------------- //
// Failure reporting
// --------------------------------------------------------------------------- //
//
// WHY THIS IS HERE AND NOT IN EACH PAGE.
//
// Eleven write handlers across six pages called `sendJSON` with no try/catch.
// The promise rejected, nothing caught it, and the UI did precisely nothing —
// no message, no spinner change, modal still open. That is what "the Create
// button doesn't work" was: the request WAS sent and refused, and the refusal
// had nowhere to go.
//
// Patching eleven handlers would fix eleven handlers. Reporting from the
// helper fixes every caller, including ones written later that forget again —
// the same reasoning as the model broker and the store's change tracking.
// A page that handles its own errors still does; this is the floor, not a
// replacement.

export interface ApiFailure {
  method: string;
  url: string;
  status: number;
  message: string;
  at: number;
}

type FailureListener = (failure: ApiFailure) => void;
const listeners = new Set<FailureListener>();

/** Subscribe to API failures. Returns an unsubscribe function. */
export function onApiFailure(listener: FailureListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function reportFailure(f: ApiFailure): void {
  // Never let a reporting bug mask the original error.
  for (const l of [...listeners]) {
    try {
      l(f);
    } catch {
      /* ignore */
    }
  }
}

export function withBase(url: string): string {
  if (url.startsWith("http")) return url;
  return `${BASE}${url}`;
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(withBase(url), { cache: "no-store" });
  if (!res.ok) {
    const message = `GET ${url} failed: ${res.status}`;
    reportFailure({ method: "GET", url, status: res.status, message, at: Date.now() });
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function sendJSON<T>(
  url: string,
  method: "POST" | "PATCH",
  body: unknown
): Promise<T> {
  const res = await fetch(withBase(url), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = err.error ?? `${method} ${url} failed: ${res.status}`;
    reportFailure({ method, url, status: res.status, message, at: Date.now() });
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/**
 * DELETE that returns the body on both success and failure.
 *
 * `sendJSON` throws on a non-2xx, which loses the response. That matters here:
 * a refused removal answers 409 WITH the list of things still referencing the
 * record, and that list is the only actionable part of the message.
 */
export async function deleteJSON<T>(
  url: string
): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const res = await fetch(withBase(url), { method: "DELETE" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    reportFailure({
      method: "DELETE", url, status: res.status,
      message: (body as { error?: string }).error ?? `DELETE ${url} failed: ${res.status}`,
      at: Date.now(),
    });
  }
  return { ok: res.ok, status: res.status, body: body as T & { error?: string } };
}
