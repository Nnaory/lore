/**
 * Next.js configuration of the LORE web app.
 *
 * Besides the build options, this file does two things that depend on where the request goes:
 *   - `rewrites` (development only) proxies `/api/v1/*` to the FastAPI backend.
 *   - `headers` gives the animation sandbox page (`/sandbox/:path*`, design 7.9, Requirement 27.3)
 *     its response headers: the CSP of the page plus `frame-ancestors`, and `nosniff`. No other
 *     route gets a header from here. `frame-ancestors` is only valid in a header, which is why the
 *     `<meta>` CSP inside `runtime.html` does not have it.
 *
 * The CSP is not written in this file. `sandbox-policy.json` is its single source: the page
 * builder (`scripts/sandbox-page.mjs`), the sandbox frame and the tests read the same constants.
 */
import type { NextConfig } from "next";
import policy from "./src/lib/animation/sandbox-policy.json";

// Local development only: send /api/v1/* to the FastAPI backend, the way Caddy does in
// production (deploy/web/Caddyfile). Without it `npm run dev` has no route for the LORE API
// (AI generation, and persistence in `http` mode).
// Production never uses this: `rewrites` returns nothing outside `next dev`.
const LORE_API_ORIGIN = process.env.LORE_API_ORIGIN ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  experimental: {
    // Next's rewrite proxy gives up after 30 s by default, but one AI step can run for
    // up to AI_DEADLINE_MS (5 min). Match Caddy's 330 s response_header_timeout.
    proxyTimeout: 330_000,
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return [{ source: "/api/v1/:path*", destination: `${LORE_API_ORIGIN}/api/v1/:path*` }];
  },
  // Next checks `headers` before the file system, `/public` included, so the static files in
  // `public/sandbox/` (runtime.html and runtime.js) receive these. Only that path is listed.
  async headers() {
    return [
      {
        source: "/sandbox/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `${policy.csp}; frame-ancestors ${policy.frame_ancestors}`,
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
