import type { NextConfig } from "next";

// Local development only: send /api/v1/* to the FastAPI backend, the way Caddy does in
// production (deploy/web/Caddyfile). Without it `npm run dev` has no route for the LORE API
// (persistence in `http` mode and AI generation with NEXT_PUBLIC_AI_BACKEND=api).
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
