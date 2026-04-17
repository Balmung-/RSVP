/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output is used by the Dockerfile / self-host targets.
  // Vercel ignores this and uses its own adapter — so it's safe for both.
  output: "standalone",
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
};
module.exports = nextConfig;
