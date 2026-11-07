require('./lib/card-processing-v2-runtime-root.cjs').assertV2RuntimeRoot(__dirname);
// A later code release must not silently drop the seller's hosted report.
if (process.env.VERCEL_ENV === 'production' &&
    !require('node:fs').existsSync(require('node:path').join(__dirname, 'private-data/draft-price-report/snapshot.json'))) {
  throw new Error('Production release requires the private draft report export. See docs/hosted-draft-price-report.md.');
}
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.LEGENDS_NEXT_DIST_DIR || ".next",
  images: { remotePatterns: [{ protocol: "https", hostname: "i.ebayimg.com" }] },
  // Runtime-local seller evidence must never be traced into a deployment bundle.
  outputFileTracingExcludes: { "/*": ["./artifacts/**", "./outputs/**", "./*.zip"] },
  // Private frozen report belongs only to the authenticated server endpoint.
  outputFileTracingIncludes: {
    "/api/card-processing-v2/price-check/report": ["./private-data/draft-price-report/snapshot.json"],
  },
};

module.exports = nextConfig;
