/**
 * The page of the Sandbox_Runtime, as pure functions (design 7.9, Requirement 27).
 *
 * `public/sandbox/runtime.html` is the document the sandboxed iframe loads. It has to be
 * self-contained and closed: one `<style>` with the Kit variables and the fonts as `data:` URLs,
 * one `<script src>` for `runtime.js`, and a CSP in a `<meta>` that forbids everything else. This
 * file builds that page from three inputs and checks it, with no file system, no clock and no
 * network, so the tests call it in-process and never read `public/sandbox/` (Requirement 27.5,
 * 27.13, note N-7). `build-sandbox.mjs` does the reading and the writing.
 *
 * - `parseThemeTokens(css)` reads the `--color-*` and `--font-*` custom properties of the `@theme`
 *   block of `src/app/lore-tokens.css`, the single source of the Kit's values. In `--font-*` it
 *   drops `var(--font-space-grotesk)` and `var(--font-jetbrains-mono)`: those variables are set by
 *   `next/font` on the app's `<html>`, and the iframe has no such element, so they would only be
 *   unresolved entries. What is left is the literal family list that the `@font-face` rules serve.
 * - `renderRuntimeHtml({ csp, tokens, fonts })` is the template. `csp` is `sandbox-policy.json`'s
 *   `csp`. It goes in the `<meta>` and never contains `frame-ancestors`: that directive is only
 *   valid in a response header, `next.config.ts` adds it there.
 * - `checkRuntimeHtml(html)` lists the ways a page breaks Requirement 27.4. The builder runs it on
 *   its own output before writing anything, and the tests run it on hostile pages to show it
 *   notices.
 *
 * This is a build script, not application code: it is `.mjs` so Node runs it without a compiler,
 * and `sandbox-page.d.mts` gives the tests its types.
 */

/** The `<script src>` of the page: `runtime.js` next to `runtime.html` (Requirement 27.4). */
export const RUNTIME_SCRIPT_SRC = "/sandbox/runtime.js";

/**
 * The four faces the page embeds, and where each file is in `node_modules` (design 7.9 step 2).
 * `family` is the name the `--font-*` values use; `file` is relative to `node_modules`.
 */
export const FONT_FILES = [
  {
    family: "Space Grotesk",
    weight: 500,
    file: "@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2",
  },
  {
    family: "Space Grotesk",
    weight: 700,
    file: "@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2",
  },
  {
    family: "JetBrains Mono",
    weight: 400,
    file: "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
  },
  {
    family: "JetBrains Mono",
    weight: 700,
    file: "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2",
  },
];

/** `next/font` variables that exist in the app but not in the iframe (design 7.9 step 1). */
const NEXT_FONT_VARIABLES = ["var(--font-space-grotesk)", "var(--font-jetbrains-mono)"];

/** Splits a CSS value at the commas that are not inside parentheses or quotes. */
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const char of value) {
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== "");
}

/** The family list of a `--font-*` value without the `next/font` variables. */
function dropNextFontVariables(value) {
  return splitTopLevel(value)
    .filter((entry) => !NEXT_FONT_VARIABLES.includes(entry))
    .join(", ");
}

/**
 * Reads `--color-*` and `--font-*` from the `@theme` block(s) of a Tailwind CSS file.
 * Returns `{ ok: true, tokens }` with `tokens` mapping each property name (`--color-ink`) to its
 * value (`#0f0f12`), or `{ ok: false, reason }` when the input has no readable `@theme` block.
 * Never throws.
 *
 * @param {unknown} css
 * @returns {{ ok: true, tokens: Record<string, string> } | { ok: false, reason: string }}
 */
export function parseThemeTokens(css) {
  if (typeof css !== "string") return { ok: false, reason: "the CSS is not a string" };
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const opener = /@theme\b[^{;]*\{/g;
  /** @type {Record<string, string>} */
  const tokens = {};
  let blocks = 0;
  for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      const char = source[end];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      end += 1;
    }
    if (depth !== 0) return { ok: false, reason: "the @theme block is not closed" };
    blocks += 1;
    const body = source.slice(start, end - 1);
    const declaration = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
    for (let found = declaration.exec(body); found !== null; found = declaration.exec(body)) {
      const name = found[1];
      const value = found[2].trim();
      if (name.startsWith("--color-")) tokens[name] = value;
      else if (name.startsWith("--font-")) tokens[name] = dropNextFontVariables(value);
    }
    opener.lastIndex = end;
  }
  if (blocks === 0) return { ok: false, reason: "there is no @theme block" };
  return { ok: true, tokens };
}

/** Makes a string safe inside a double-quoted HTML attribute. */
function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The page. `tokens` is emitted in the order given as the `:root` variables; `fonts` becomes one
 * `@font-face` per entry with the file inlined as a `data:` URL. Pure: the same input always gives
 * the same string. It does not validate its input; `checkRuntimeHtml` does, on the result.
 *
 * @param {{
 *   csp: string,
 *   tokens: Readonly<Record<string, string>>,
 *   fonts: ReadonlyArray<{ family: string, weight: number, base64: string }>,
 * }} input
 * @returns {string}
 */
export function renderRuntimeHtml({ csp, tokens, fonts }) {
  const faces = fonts
    .map(
      (font) =>
        `@font-face{font-family:"${font.family}";font-weight:${font.weight};` +
        `src:url(data:font/woff2;base64,${font.base64}) format("woff2")}`,
    )
    .join("\n");
  const variables = Object.entries(tokens)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    "<title>LORE animation sandbox</title>",
    "<style>",
    faces,
    `:root{${variables}}`,
    "html,body{margin:0;height:100%;overflow:hidden;background:var(--color-ink);color:var(--color-cream)}",
    "#root{position:fixed;inset:0}",
    "</style></head>",
    `<body><div id="root"></div><script src="${RUNTIME_SCRIPT_SRC}"></script></body></html>`,
    "",
  ].join("\n");
}

/** Elements that would load or navigate to something; the page has none of them. */
const FORBIDDEN_ELEMENT = /<(?:link|base|iframe|frame|img|form|object|embed|audio|video|source|track)\b/i;

/**
 * Lists every way `html` breaks the page invariants of Requirement 27.4. An empty list means the
 * page is as closed as the design says. Never throws.
 *
 * @param {unknown} html
 * @returns {string[]}
 */
export function checkRuntimeHtml(html) {
  if (typeof html !== "string") return ["the page is not a string"];
  const problems = [];
  // The fonts are long base64 runs; take them out before looking for attributes.
  const bare = html.replace(/url\(data:[^)]*\)/gi, "url(data:)");

  const scriptTags = bare.match(/<script\b/gi) ?? [];
  if (scriptTags.length !== 1) {
    problems.push(`expected exactly one <script>, found ${scriptTags.length}`);
  }
  const allowedScript = `<script src="${RUNTIME_SCRIPT_SRC}"></script>`;
  if (scriptTags.length === 1 && !bare.includes(allowedScript)) {
    problems.push(`the one <script> is not exactly ${allowedScript} (inline script or other attribute)`);
  }

  const styleTags = bare.match(/<style\b/gi) ?? [];
  if (styleTags.length !== 1) problems.push(`expected exactly one <style>, found ${styleTags.length}`);
  const styleBody = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/i.exec(bare);
  if (styleBody !== null && styleBody[1].includes("<")) {
    problems.push("the <style> contains a '<'");
  }

  if (/@import/i.test(html)) problems.push("the page has an @import");

  const urlCalls = (html.match(/url\(/gi) ?? []).length;
  const dataUrlCalls = (html.match(/url\(data:/gi) ?? []).length;
  if (urlCalls !== dataUrlCalls) {
    problems.push(`${urlCalls - dataUrlCalls} url( call(s) that are not url(data:`);
  }

  if (FORBIDDEN_ELEMENT.test(bare)) problems.push("the page has an element that loads a resource");
  const withoutScript = bare.replace(allowedScript, "");
  if (/\b(?:href|src|srcset|action|formaction|poster)\s*=/i.test(withoutScript)) {
    problems.push("the page has an href or src attribute besides the one <script src>");
  }

  const metas = bare.match(/<meta\b[^>]*http-equiv\s*=\s*"Content-Security-Policy"[^>]*>/gi) ?? [];
  if (metas.length !== 1) problems.push(`expected exactly one CSP <meta>, found ${metas.length}`);
  if (/frame-ancestors/i.test(html)) {
    problems.push("the page names frame-ancestors; it belongs only in the response header");
  }
  return problems;
}
