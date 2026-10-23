/** @type {import('next').NextConfig} */
// BASE_PATH lets the app run behind a path prefix if ever needed. Leave unset
// for direct access and for the VS Code / code-server Ports-panel forwarding,
// which handles asset paths and auth natively (the reliable way in).
const basePath = process.env.BASE_PATH || "";

const nextConfig = {
  reactStrictMode: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // ONE variable drives both the server prefix and the client fetch prefix.
  //
  // `src/lib/api.ts` reads NEXT_PUBLIC_BASE_PATH to prefix every browser
  // fetch. That was a SECOND environment variable which had to agree with
  // BASE_PATH, and when only BASE_PATH was set the result was silent and
  // total: Next served the app under /proxy/3000, the client fetched bare
  // /api/... , every call 404'd, and because most handlers do not catch, the
  // UI simply did nothing. "The Create button doesn't work" was that.
  //
  // Deriving it here means setting BASE_PATH is sufficient, and the two can no
  // longer drift. An explicitly-set NEXT_PUBLIC_BASE_PATH still wins, for a
  // deployment where the client prefix genuinely differs from the server's.
  env: {
    NEXT_PUBLIC_BASE_PATH:
      process.env.NEXT_PUBLIC_BASE_PATH ?? basePath,
  },
  async rewrites() {
    return [
      // The A2A spec fixes the card at this path. A route folder literally
      // named `.well-known` is treated as hidden and never routed, so the
      // handler lives at /api/a2a/card and this rewrite serves it where the
      // protocol expects. Both spellings are rewritten because a client may
      // try either.
      { source: "/.well-known/agent-card.json", destination: "/api/a2a/card" },
      { source: "/.well-known/agent.json", destination: "/api/a2a/card" },
    ];
  },
};

export default nextConfig;
