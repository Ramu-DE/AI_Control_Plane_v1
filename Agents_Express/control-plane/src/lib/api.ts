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
