/** @type {import('next').NextConfig} */
// BASE_PATH lets the app run behind a path prefix if ever needed. Leave unset
// for direct access and for the VS Code / code-server Ports-panel forwarding,
// which handles asset paths and auth natively (the reliable way in).
const basePath = process.env.BASE_PATH || "";

const nextConfig = {
  reactStrictMode: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
