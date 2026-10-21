/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.LEGENDS_NEXT_DIST_DIR || ".next",
  images: { remotePatterns: [{ protocol: "https", hostname: "i.ebayimg.com" }] },
  // Runtime-local seller evidence must never be traced into a deployment bundle.
  outputFileTracingExcludes: { "/*": ["./artifacts/**", "./outputs/**", "./*.zip"] },
};

module.exports = nextConfig;
