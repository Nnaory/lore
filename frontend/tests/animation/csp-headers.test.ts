/**
 * Tests: the response headers of the sandbox page (task 26.5), design 7.9 and A-10,
 * Requirements 27.1, 27.2, 27.3, 27.10 and 32.2.
 *
 * `next.config.ts` is imported as a module and its `headers()` is called, so what is checked is
 * the value Next will serve, not a copy of it. The expected strings below are written out in full
 * on purpose (Requirement 27.10): they are the second place the policy appears, and a change to
 * `sandbox-policy.json` has to be a change here too.
 *
 *   1. `headers()` returns one entry, for `/sandbox/:path*`, with exactly two headers: the CSP
 *      of the policy plus `frame-ancestors 'self'`, and `X-Content-Type-Options: nosniff`;
 *   2. the directives of that header are the directives of the page's `<meta>` plus
 *      `frame-ancestors`, which exists only in the header (it is not valid in a `<meta>`);
 *   3. the `sandbox` attribute value of the policy is exactly `allow-scripts`;
 *   4. the policy string is defined once: no other file of the build repeats it;
 *   5. the other options of the config are as they were (`rewrites` included);
 *   6. Next's own loader accepts the file and its route matcher, run on the entry, covers the
 *      sandbox path and no other route. This replaces `npm run build` as the proof that the config
 *      is valid, because the build cannot run without the font packages (ledger 26.4).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import policy from "@/lib/animation/sandbox-policy.json";
import nextConfig from "../../next.config";
import { renderRuntimeHtml } from "../../scripts/sandbox-page.mjs";

const FRONTEND = join(__dirname, "..", "..");

/** The CSP of Requirement 27.2, as it appears in the page's `<meta>`. */
const EXPECTED_META_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; " +
  "font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; " +
  "object-src 'none'";

/** The CSP of Requirement 27.3: the same directives plus `frame-ancestors 'self'`. */
const EXPECTED_HEADER_CSP = `${EXPECTED_META_CSP}; frame-ancestors 'self'`;

interface HeaderEntry {
  key: string;
  value: string;
}

interface RouteEntry {
  source: string;
  headers: HeaderEntry[];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** What `headers()` of `next.config.ts` resolves to. */
async function resolvedHeaders(): Promise<RouteEntry[]> {
  const headers = nextConfig.headers;
  if (headers === undefined) throw new Error("next.config.ts has no headers()");
  return (await headers()) as RouteEntry[];
}

/** The one entry of `headers()`; fails the test when there is not exactly one. */
async function sandboxEntry(): Promise<RouteEntry> {
  const entries = await resolvedHeaders();
  expect(entries).toHaveLength(1);
  return entries[0];
}

/** The value of the header called `key` (case-insensitive) on `entry`, or `undefined`. */
function valueOf(entry: RouteEntry, key: string): string | undefined {
  return entry.headers.find((header) => header.key.toLowerCase() === key.toLowerCase())?.value;
}

/** The `content` of the CSP `<meta>` of a page built with `renderRuntimeHtml`. */
function metaCsp(html: string): string {
  const meta = /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/.exec(html);
  const content = /content="([^"]*)"/.exec(meta?.[0] ?? "");
  if (content === null) throw new Error("the page has no CSP <meta>");
  return content[1];
}

/** A page built from the real policy; tokens and fonts do not matter for the CSP. */
function page(): string {
  return renderRuntimeHtml({ csp: policy.csp, tokens: {}, fonts: [] });
}

describe("headers() of next.config.ts", () => {
  it("is a function that resolves to exactly one entry, and only for /sandbox/:path*", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const entries = await resolvedHeaders();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("/sandbox/:path*");
  });

  it("has no matching condition, base path or locale option on the entry", async () => {
    const entry = await sandboxEntry();
    expect(Object.keys(entry).sort()).toEqual(["headers", "source"]);
  });

  it("sends exactly the CSP and nosniff, with the CSP string of Requirements 27.2 and 27.3", async () => {
    const entry = await sandboxEntry();
    expect(entry.headers).toEqual([
      { key: "Content-Security-Policy", value: EXPECTED_HEADER_CSP },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ]);
  });

  it("repeats no header key on the entry", async () => {
    const entry = await sandboxEntry();
    const keys = entry.headers.map((header) => header.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("frame-ancestors lives in the header only", () => {
  it("is in the header exactly once, as the last directive, with the value of the policy", async () => {
    const csp = valueOf(await sandboxEntry(), "Content-Security-Policy") ?? "";
    expect(policy.frame_ancestors).toBe("'self'");
    expect(csp.match(/frame-ancestors/g)).toHaveLength(1);
    expect(csp.endsWith("; frame-ancestors 'self'")).toBe(true);
  });

  it("is not in the csp string of the policy, nor in the <meta> of the page", () => {
    expect(policy.csp).toBe(EXPECTED_META_CSP);
    expect(policy.csp).not.toContain("frame-ancestors");
    const html = page();
    expect(metaCsp(html)).toBe(EXPECTED_META_CSP);
    expect(html).not.toContain("frame-ancestors");
  });

  it("leaves every other directive of the header identical to the page's <meta>", async () => {
    const csp = valueOf(await sandboxEntry(), "Content-Security-Policy") ?? "";
    const headerDirectives = csp.split("; ");
    const metaDirectives = metaCsp(page()).split("; ");
    expect(headerDirectives.filter((directive) => !directive.startsWith("frame-ancestors"))).toEqual(
      metaDirectives,
    );
    expect(headerDirectives).toHaveLength(metaDirectives.length + 1);
  });

  it("has the directives the sandbox depends on, and none that open the page up", async () => {
    const csp = valueOf(await sandboxEntry(), "Content-Security-Policy") ?? "";
    const directives = new Map(
      csp.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources.join(" ")] as const;
      }),
    );
    expect(directives.get("default-src")).toBe("'none'");
    expect(directives.get("connect-src")).toBe("'none'");
    expect(directives.get("frame-src")).toBe("'none'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'none'");
    expect(directives.get("form-action")).toBe("'none'");
    expect(directives.get("script-src")).toBe("'self' 'unsafe-eval'");
    expect(directives.get("style-src")).toBe("'unsafe-inline'");
    expect(directives.get("img-src")).toBe("data:");
    expect(directives.get("font-src")).toBe("data:");
    expect(directives.get("frame-ancestors")).toBe("'self'");
    expect(csp).not.toContain("*");
    expect(csp).not.toMatch(/https?:/);
  });
});

describe("the sandbox attribute and the page address of the policy", () => {
  it("is exactly allow-scripts (Requirement 27.1)", () => {
    expect(policy.sandbox_attribute).toBe("allow-scripts");
    expect(policy.sandbox_attribute.split(/\s+/)).toEqual(["allow-scripts"]);
  });

  it.each([
    "allow-same-origin",
    "allow-top-navigation",
    "allow-popups",
    "allow-forms",
    "allow-modals",
  ])("does not grant %s", (token) => {
    expect(policy.sandbox_attribute).not.toContain(token);
  });

  it("points the frame at the page that the headers cover", async () => {
    expect(policy.src).toBe("/sandbox/runtime.html");
    expect((await sandboxEntry()).source).toBe("/sandbox/:path*");
    expect(policy.src.startsWith("/sandbox/")).toBe(true);
  });
});

describe("the policy is defined once (Requirement 27.3)", () => {
  const SOURCES = [
    "next.config.ts",
    join("scripts", "sandbox-page.mjs"),
    join("scripts", "build-sandbox.mjs"),
  ];

  it.each(SOURCES)("%s has no copy of the CSP or of the sandbox attribute", (file) => {
    const text = readFileSync(join(FRONTEND, file), "utf8");
    expect(text).not.toContain("default-src");
    expect(text).not.toContain("'unsafe-eval'");
    expect(text).not.toContain("allow-scripts");
    expect(text).not.toContain("'self'");
  });

  it("next.config.ts reads the policy file and builds the header value from its two fields", () => {
    const text = readFileSync(join(FRONTEND, "next.config.ts"), "utf8");
    expect(text).toContain('from "./src/lib/animation/sandbox-policy.json"');
    expect(text).toContain("${policy.csp}; frame-ancestors ${policy.frame_ancestors}");
  });
});

describe("the other options of next.config.ts are as they were", () => {
  it("keeps the build options", () => {
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.cacheComponents).toBe(true);
    expect(nextConfig.partialPrefetching).toBe(true);
    expect(nextConfig.reactCompiler).toBe(true);
    expect(nextConfig.experimental).toEqual({ proxyTimeout: 330_000 });
    expect(nextConfig.turbopack).toEqual({
      rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } },
    });
  });

  it("keeps rewrites: the API proxy in development, nothing anywhere else", async () => {
    const rewrites = nextConfig.rewrites;
    if (rewrites === undefined) throw new Error("next.config.ts lost its rewrites()");
    vi.stubEnv("NODE_ENV", "development");
    const inDevelopment = await rewrites();
    expect(inDevelopment).toEqual([
      { source: "/api/v1/:path*", destination: expect.stringMatching(/^https?:\/\/.+\/api\/v1\/:path\*$/) },
    ]);
    for (const mode of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", mode);
      expect(await rewrites()).toEqual([]);
    }
  });

  it("has no redirects and no other custom routes", () => {
    expect(nextConfig.redirects).toBeUndefined();
  });
});

// Next's internals, pinned by `next` 16.4.5 in package.json. They are used only here, only to ask
// Next what it makes of the file; if an upgrade moves them this describe fails loudly.
type LoadConfig = (phase: string, dir: string) => Promise<object>;
type LoadCustomRoutes = (config: object) => Promise<{ headers: RouteEntry[] }>;
type BuildCustomRoute = (type: "header", route: RouteEntry) => RouteEntry & { regex: string };

describe("Next's own loader and route matcher (stands in for `npm run build`)", () => {
  const nodeRequire = createRequire(join(FRONTEND, "package.json"));
  const { PHASE_PRODUCTION_BUILD } = nodeRequire("next/constants") as { PHASE_PRODUCTION_BUILD: string };
  const loadConfig = (nodeRequire("next/dist/server/config") as { default: LoadConfig }).default;
  const loadCustomRoutes = (nodeRequire("next/dist/lib/load-custom-routes") as { default: LoadCustomRoutes })
    .default;
  const { buildCustomRoute } = nodeRequire("next/dist/lib/build-custom-route") as {
    buildCustomRoute: BuildCustomRoute;
  };

  /** The header routes of the config as Next's loader reads it from disk, with their regexes. */
  async function loadedRoutes() {
    const config = await loadConfig(PHASE_PRODUCTION_BUILD, FRONTEND);
    const custom = await loadCustomRoutes(config);
    return custom.headers.map((route) => buildCustomRoute("header", route));
  }

  it("loads next.config.ts with its JSON import and validates the headers entry", async () => {
    const routes = await loadedRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].source).toBe("/sandbox/:path*");
    expect(routes[0].headers).toEqual([
      { key: "Content-Security-Policy", value: EXPECTED_HEADER_CSP },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ]);
  }, 60_000);

  it.each(["/sandbox", "/sandbox/", "/sandbox/runtime.html", "/sandbox/runtime.js"])(
    "gives the headers to %s",
    async (pathname) => {
      const routes = await loadedRoutes();
      expect(routes.filter((route) => new RegExp(route.regex).test(pathname))).toHaveLength(1);
    },
    60_000,
  );

  it.each([
    "/",
    "/play",
    "/story",
    "/setup",
    "/api/health",
    "/api/v1/projects",
    "/api/v1/animations",
    "/_next/static/chunks/main.js",
    "/sandboxed",
    "/sandbox.html",
    "/sandbox-other/runtime.html",
    "/x/sandbox/runtime.html",
    "/public/sandbox/runtime.html",
  ])("gives no header to %s", async (pathname) => {
    const routes = await loadedRoutes();
    expect(routes.filter((route) => new RegExp(route.regex).test(pathname))).toEqual([]);
  }, 60_000);
});
