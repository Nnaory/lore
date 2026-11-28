/**
 * Types for `sandbox-page.mjs`, so the TypeScript tests can import the build script's page
 * functions. The script itself stays plain `.mjs`: Node runs it from `npm run dev` and
 * `npm run build` without a compiler.
 */

/** The `<script src>` of the page (`/sandbox/runtime.js`). */
export const RUNTIME_SCRIPT_SRC: string;

/** One font face the page embeds; `file` is relative to `node_modules`. */
export interface FontFile {
  readonly family: string;
  readonly weight: number;
  readonly file: string;
}

/** The four faces the page embeds: Space Grotesk 500 and 700, JetBrains Mono 400 and 700. */
export const FONT_FILES: readonly FontFile[];

/** A font face as `renderRuntimeHtml` takes it: the file already base64-encoded. */
export interface PageFont {
  readonly family: string;
  readonly weight: number;
  readonly base64: string;
}

export type ParseThemeTokensResult =
  | { ok: true; tokens: Record<string, string> }
  | { ok: false; reason: string };

/** `--color-*` and `--font-*` of the `@theme` block(s), without the `next/font` variables. */
export function parseThemeTokens(css: unknown): ParseThemeTokensResult;

export interface RuntimeHtmlInput {
  /** `csp` of `sandbox-policy.json`; never contains `frame-ancestors`. */
  readonly csp: string;
  /** Custom properties for `:root`, in emission order. */
  readonly tokens: Readonly<Record<string, string>>;
  readonly fonts: readonly PageFont[];
}

/** The page; pure. */
export function renderRuntimeHtml(input: RuntimeHtmlInput): string;

/** The ways `html` breaks the page invariants of Requirement 27.4; empty means none. */
export function checkRuntimeHtml(html: unknown): string[];
