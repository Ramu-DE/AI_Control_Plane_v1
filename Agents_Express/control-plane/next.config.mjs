/** @type {import('next').NextConfig} */
// BASE_PATH lets the app run behind a path prefix if ever needed. Leave unset
// for direct access and for the VS Code / code-server Ports-panel forwarding,
// which handles asset paths and auth natively (the reliable way in).
const basePath = process.env.BASE_PATH || "";

const nextConfig = {
  reactStrictMode: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
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
