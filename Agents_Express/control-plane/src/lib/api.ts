// Tiny typed fetch helpers for client components.
// Prefix API calls with the base path so they work both directly and when the
// app is served behind a path prefix (e.g. code-server's /proxy/3000).
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function withBase(url: string): string {
  if (url.startsWith("http")) return url;
  return `${BASE}${url}`;
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(withBase(url), { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
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
    throw new Error(err.error ?? `${method} ${url} failed: ${res.status}`);
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
  return { ok: res.ok, status: res.status, body: body as T & { error?: string } };
}
