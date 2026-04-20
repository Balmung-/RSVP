/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  poweredByHeader: false,
  experimental: {
    // Next 14 requires this flag for src/instrumentation.ts register()
    // to be invoked on server start. Without it the boot-time runtime
    // guard is silently skipped and a misconfigured prod deploy boots
    // into the silent-503 state the guard is meant to prevent.
    // Stable (default-on) in Next 15; required in 14.x.
    instrumentationHook: true,
    serverActions: {
      bodySizeLimit: "4mb",
      allowedOrigins: allowedOrigins.length ? allowedOrigins : undefined,
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
module.exports = nextConfig;
