/**
 * Tests: the page of the Sandbox_Runtime (task 26.4), design 7.9, Requirements 27.2, 27.4, 27.5.
 *
 * `renderRuntimeHtml`, `parseThemeTokens` and `checkRuntimeHtml` are pure, so everything here runs
 * in-process on strings. Nothing reads `public/sandbox/`: the page is generated from the real
 * `lore-tokens.css`, the real contract and the real policy file, and then looked at:
 *
 *   1. `parseThemeTokens` returns each palette token and both `--font-*` with the value that
 *      `lore-tokens.css` has (read here with a different parser), minus the `next/font` variables;
 *   2. the page has exactly one `<script src>`, no inline script, no `@import`, no `url(` that is
 *      not `url(data:`, no other `href` or `src`, and a CSP `<meta>` without `frame-ancestors`;
 *   3. `:root` carries those tokens; four `@font-face` rules carry the font bytes as `data:`;
 *   4. `checkRuntimeHtml` notices each way a page can break those rules.
 *
 * The invariants in 2 are asserted here directly on the output, not only through
 * `checkRuntimeHtml`, so a bug in the checker cannot hide a bug in the template.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import policy from "@/lib/animation/sandbox-policy.json";
import { CONTRACT } from "@/lib/animation/contract";
import {
  FONT_FILES,
  RUNTIME_SCRIPT_SRC,
  checkRuntimeHtml,
  parseThemeTokens,
  renderRuntimeHtml,
  type PageFont,
} from "../../scripts/sandbox-page.mjs";

const TOKENS_CSS = readFileSync(join(__dirname, "..", "..", "src", "app", "lore-tokens.css"), "utf8");

/** The CSP of Requirement 27.2, written out in full on purpose (Requirement 27.10). */
const EXPECTED_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; " +
  "font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; " +
  "object-src 'none'";

/** A declaration's raw value in `lore-tokens.css`, read with a regex (not `parseThemeTokens`). */
function rawCssValue(property: string): string {
  const found = new RegExp(`${property}:\\s*([^;]+);`).exec(TOKENS_CSS);
  if (found === null) throw new Error(`${property} is not in lore-tokens.css`);
  return found[1].trim();
}

/** What `parseThemeTokens` must give for a `--font-*` value: the two `next/font` entries gone. */
function withoutNextFontVariables(raw: string): string {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "var(--font-space-grotesk)" && entry !== "var(--font-jetbrains-mono)")
    .join(", ");
}

const FONT_PROPERTIES = CONTRACT.font_variables;
const PALETTE_PROPERTIES = CONTRACT.color_tokens.map((name) => `--color-${name}`);

function parsed(): Record<string, string> {
  const result = parseThemeTokens(TOKENS_CSS);
  if (!result.ok) throw new Error(`lore-tokens.css did not parse: ${result.reason}`);
  return result.tokens;
}

/** The tokens the builder puts in `:root`: the palette of the contract and its font variables. */
function pageTokens(): Record<string, string> {
  const all = parsed();
  const tokens: Record<string, string> = {};
  for (const property of [...PALETTE_PROPERTIES, ...FONT_PROPERTIES]) tokens[property] = all[property];
  return tokens;
}

/** Arbitrary bytes standing in for the four woff2 files. */
function fakeFonts(): PageFont[] {
  return FONT_FILES.map((font, index) => ({
    family: font.family,
    weight: font.weight,
    base64: Buffer.from(`font-${index}-${font.family}-${font.weight}`).toString("base64"),
  }));
}

function page(): string {
  return renderRuntimeHtml({ csp: policy.csp, tokens: pageTokens(), fonts: fakeFonts() });
}

/** The page with every base64 payload cut out, so attribute searches cannot hit font bytes. */
function withoutFontData(html: string): string {
  return html.replace(/url\(data:[^)]*\)/g, "url(data:)");
}

describe("sandbox-policy.json", () => {
  it("holds the CSP, the sandbox attribute and the src of Requirements 27.1 to 27.3", () => {
    expect(policy.csp).toBe(EXPECTED_CSP);
    expect(policy.sandbox_attribute).toBe("allow-scripts");
    expect(policy.src).toBe("/sandbox/runtime.html");
    expect(policy.frame_ancestors).toBe("'self'");
  });

  it("keeps frame-ancestors out of the csp string (it is only valid in a header)", () => {
    expect(policy.csp).not.toContain("frame-ancestors");
  });

  it("has exactly these four keys", () => {
    expect(Object.keys(policy).sort()).toEqual(["csp", "frame_ancestors", "sandbox_attribute", "src"]);
  });
});

describe("parseThemeTokens on lore-tokens.css", () => {
  it("returns each palette token of the contract with the value of lore-tokens.css", () => {
    const tokens = parsed();
    expect(PALETTE_PROPERTIES).toHaveLength(9);
    for (const property of PALETTE_PROPERTIES) {
      expect(tokens[property], property).toBe(rawCssValue(property));
    }
  });

  it("returns --font-display and --font-mono without the next/font variables", () => {
    const tokens = parsed();
    expect(FONT_PROPERTIES).toEqual(["--font-display", "--font-mono"]);
    for (const property of FONT_PROPERTIES) {
      expect(tokens[property], property).toBe(withoutNextFontVariables(rawCssValue(property)));
      expect(tokens[property]).not.toContain("var(");
    }
    expect(tokens["--font-display"]).toMatch(/^"Space Grotesk"/);
    expect(tokens["--font-mono"]).toMatch(/^"JetBrains Mono"/);
  });

  it("returns only --color-* and --font-* properties", () => {
    for (const name of Object.keys(parsed())) expect(name).toMatch(/^--(?:color|font)-/);
    expect(parsed()).not.toHaveProperty("--radius-none");
    expect(parsed()).not.toHaveProperty("--spacing-hud");
  });

  it("does not take a colour that appears only in a comment or outside @theme", () => {
    const result = parseThemeTokens(
      "@theme { /* --color-nope: #fff; */ --color-a: #111; }\n:root { --color-outside: #222; }",
    );
    expect(result).toEqual({ ok: true, tokens: { "--color-a": "#111" } });
  });
});

describe("parseThemeTokens on other input", () => {
  it("merges several @theme blocks and accepts `@theme inline`", () => {
    const result = parseThemeTokens("@theme { --color-a: #111; }\n@theme inline { --color-b: #222; }");
    expect(result).toEqual({ ok: true, tokens: { "--color-a": "#111", "--color-b": "#222" } });
  });

  it("keeps a comma inside parentheses or quotes with its entry", () => {
    const result = parseThemeTokens(
      '@theme { --font-x: var(--font-space-grotesk), "A, B", ui-sans-serif, var(--other, fallback); }',
    );
    expect(result).toEqual({
      ok: true,
      tokens: { "--font-x": '"A, B", ui-sans-serif, var(--other, fallback)' },
    });
  });

  it.each([
    ["no @theme block", ":root { --color-a: #111; }"],
    ["an unclosed block", "@theme { --color-a: #111;"],
    ["an empty string", ""],
  ])("reports %s as { ok: false } without throwing", (_name, css) => {
    const result = parseThemeTokens(css);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 42, {}, []])("reports a non-string (%j) as { ok: false }", (value) => {
    expect(parseThemeTokens(value).ok).toBe(false);
  });
});

describe("FONT_FILES", () => {
  it("lists the four @fontsource files of design 7.9", () => {
    expect(FONT_FILES.map((font) => font.file)).toEqual([
      "@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2",
      "@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2",
      "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
      "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2",
    ]);
    expect(FONT_FILES.map((font) => `${font.family} ${font.weight}`)).toEqual([
      "Space Grotesk 500",
      "Space Grotesk 700",
      "JetBrains Mono 400",
      "JetBrains Mono 700",
    ]);
  });
});

describe("renderRuntimeHtml: the page invariants of Requirement 27.4", () => {
  it("is a pure function: the same input gives the same page", () => {
    expect(page()).toBe(page());
  });

  it("has exactly one <script>, and it is <script src> for runtime.js with no body", () => {
    const html = page();
    expect(RUNTIME_SCRIPT_SRC).toBe("/sandbox/runtime.js");
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain('<script src="/sandbox/runtime.js"></script>');
    const tag = /<script\b([^>]*)>([\s\S]*?)<\/script>/.exec(html);
    expect(tag?.[1]).toBe(' src="/sandbox/runtime.js"');
    expect(tag?.[2]).toBe("");
  });

  it("has exactly one <style> and no @import", () => {
    const html = page();
    expect(html.match(/<style\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/@import/i);
  });

  it("has no url( other than url(data:", () => {
    const html = page();
    const all = html.match(/url\(/gi) ?? [];
    const data = html.match(/url\(data:/gi) ?? [];
    expect(all).toHaveLength(4);
    expect(data).toHaveLength(all.length);
  });

  it("has no href or src attribute besides the one on the script", () => {
    const html = withoutFontData(page()).replace('<script src="/sandbox/runtime.js"></script>', "");
    expect(html).not.toMatch(/\bhref\s*=/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/<(?:link|base|iframe|img|form|object|embed)\b/i);
  });

  it("has a CSP <meta> that equals the policy csp and names no frame-ancestors", () => {
    const html = page();
    const metas = html.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/g) ?? [];
    expect(metas).toHaveLength(1);
    const content = /content="([^"]*)"/.exec(metas[0] ?? "");
    expect(content?.[1]).toBe(EXPECTED_CSP);
    expect(html).not.toContain("frame-ancestors");
  });

  it("passes checkRuntimeHtml with no problem", () => {
    expect(checkRuntimeHtml(page())).toEqual([]);
  });

  it("escapes a quote in the csp so the attribute stays whole", () => {
    const html = renderRuntimeHtml({ csp: 'a "b" & c', tokens: pageTokens(), fonts: fakeFonts() });
    expect(html).toContain('content="a &quot;b&quot; &amp; c"');
    expect(checkRuntimeHtml(html)).toEqual([]);
  });
});

describe("renderRuntimeHtml: tokens and fonts", () => {
  /** The `name:value` pairs of the `:root{...}` rule. */
  function rootVariables(html: string): Record<string, string> {
    const rule = /:root\{([^}]*)\}/.exec(html);
    if (rule === null) throw new Error("no :root rule");
    const variables: Record<string, string> = {};
    for (const declaration of rule[1].split(";")) {
      const at = declaration.indexOf(":");
      variables[declaration.slice(0, at)] = declaration.slice(at + 1);
    }
    return variables;
  }

  it("puts every palette token, --font-display and --font-mono in :root with the css values", () => {
    const variables = rootVariables(page());
    expect(Object.keys(variables).sort()).toEqual([...PALETTE_PROPERTIES, ...FONT_PROPERTIES].sort());
    for (const property of PALETTE_PROPERTIES) {
      expect(variables[property], property).toBe(rawCssValue(property));
    }
    for (const property of FONT_PROPERTIES) {
      expect(variables[property], property).toBe(withoutNextFontVariables(rawCssValue(property)));
    }
  });

  it("leaves no next/font variable in the page", () => {
    const html = page();
    expect(html).not.toContain("--font-space-grotesk");
    expect(html).not.toContain("--font-jetbrains-mono");
  });

  it("styles the body from the Kit variables, not from hex values", () => {
    const html = withoutFontData(page());
    const rules = html.slice(html.indexOf("html,body{"), html.indexOf("</style>"));
    expect(rules).toContain("background:var(--color-ink)");
    expect(rules).toContain("color:var(--color-cream)");
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("embeds one @font-face per font, with the bytes as a woff2 data: URL", () => {
    const html = page();
    const faces = html.match(/@font-face\{[^}]*\}/g) ?? [];
    expect(faces).toHaveLength(4);
    fakeFonts().forEach((font, index) => {
      expect(faces[index]).toBe(
        `@font-face{font-family:"${font.family}";font-weight:${font.weight};` +
          `src:url(data:font/woff2;base64,${font.base64}) format("woff2")}`,
      );
    });
  });

  it("is not fooled by font bytes that look like an attribute (base64 ending in `src=`)", () => {
    const fonts = fakeFonts().map((font) => ({ ...font, base64: "AAAAsrc=" }));
    const html = renderRuntimeHtml({ csp: policy.csp, tokens: pageTokens(), fonts });
    expect(checkRuntimeHtml(html)).toEqual([]);
  });
});

describe("checkRuntimeHtml notices every way to break the page", () => {
  const good = page();

  /** The good page with `from` replaced by `to`; fails the test if `from` is not there. */
  function mutated(from: string, to: string): string {
    expect(good).toContain(from);
    return good.replace(from, to);
  }

  it("accepts the good page", () => {
    expect(checkRuntimeHtml(good)).toEqual([]);
  });

  const SCRIPT = '<script src="/sandbox/runtime.js"></script>';
  const bad: Array<[string, string]> = [
    ["an inline script", mutated(SCRIPT, "<script>alert(1)</script>")],
    ["a second script", mutated(SCRIPT, `${SCRIPT}<script src="/sandbox/other.js"></script>`)],
    ["a script with a type attribute", mutated(SCRIPT, '<script type="module" src="/sandbox/runtime.js"></script>')],
    ["a script from another place", mutated(SCRIPT, '<script src="https://example.com/x.js"></script>')],
    ["no script", mutated(SCRIPT, "")],
    ["an @import", mutated("html,body{", '@import "https://example.com/x.css";html,body{')],
    ["a url( that is not url(data:", mutated("#root{", "#root{background:url(https://example.com/x.png);")],
    ["a relative url(", mutated("#root{", "#root{background:url(x.png);")],
    ["an upper-case URL(", mutated("#root{", "#root{background:URL(x.png);")],
    ["a <link href>", mutated("<title>", '<link rel="stylesheet" href="/x.css"><title>')],
    ["an <img src>", mutated("<div id=", '<img src="data:image/png;base64,AAAA"><div id=')],
    ["a second <style>", mutated("</head>", "<style>a{}</style></head>")],
    ["no <style>", mutated("<style>", "<div>").replace("</style>", "</div>")],
    ["frame-ancestors in the meta", mutated("object-src 'none'", "object-src 'none'; frame-ancestors 'self'")],
    ["no CSP meta", mutated('<meta http-equiv="Content-Security-Policy"', '<meta name="x"')],
    ["a second CSP meta", mutated("<title>", `<meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>`)],
    ["a '<' inside the style", mutated("#root{", "#root{content:'<';")],
  ];

  it.each(bad)("reports %s", (_name, html) => {
    expect(checkRuntimeHtml(html).length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 7, {}])("reports a non-string (%j) without throwing", (value) => {
    expect(checkRuntimeHtml(value).length).toBeGreaterThan(0);
  });
});
