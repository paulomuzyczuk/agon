/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-hosting decision (CLAUDE.md): a lean, self-contained server bundle
  // for the multi-stage Docker image — `node .next/standalone/server.js`
  // needs no separate `node_modules` copy in the runtime image.
  output: 'standalone',
};

export default nextConfig;
