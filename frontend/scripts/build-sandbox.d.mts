/**
 * Types for `build-sandbox.mjs`, so the TypeScript tests can call the Sandbox_Builder in-process.
 * The script itself stays plain `.mjs`: Node runs it from `npm run dev` and `npm run build`
 * without a compiler.
 */

/** Largest `runtime.js` the page may load, in bytes (1048576). */
export const MAX_RUNTIME_BYTES: number;

/** `react`, `react-dom`, `remotion` and `@remotion/player`: one copy each in the bundle. */
export const SINGLE_COPY_PACKAGES: readonly string[];

/** The `frontend/` directory. */
export const DEFAULT_ROOT: string;

/** Every path is optional; the defaults are the real repository under `root`. */
export interface BuildOptions {
  /** The frontend directory; esbuild's working directory. */
  readonly root?: string;
  /** Where `runtime.js` and `runtime.html` are written (default `<root>/public/sandbox`). */
  readonly outDir?: string;
  /** `src/app/lore-tokens.css`. */
  readonly tokensCssPath?: string;
  /** `src/lib/animation/animation-contract.json`. */
  readonly contractPath?: string;
  /** `src/lib/animation/sandbox-policy.json`. */
  readonly policyPath?: string;
  /** The directory that holds `@fontsource/*` (default `<root>/node_modules`). */
  readonly fontsRoot?: string;
  /** Size limit of `runtime.js` (default `MAX_RUNTIME_BYTES`). */
  readonly maxRuntimeBytes?: number;
}

/** The part of the esbuild metafile the tests read. */
export interface BuildMetafile {
  readonly inputs: Readonly<Record<string, { readonly bytes: number }>>;
  readonly outputs: Readonly<Record<string, { readonly bytes: number }>>;
}

export type BuildResult =
  | {
      ok: true;
      outDir: string;
      runtimeBytes: number;
      htmlBytes: number;
      warnings: string[];
      metafile: BuildMetafile;
    }
  | { ok: false; errors: string[] };

/** Builds and writes the runtime; never throws, and writes nothing unless every check passed. */
export function buildSandbox(options?: BuildOptions): Promise<BuildResult>;

/** One problem per package that is missing, outside `<root>/node_modules`, or nested. */
export function checkSingleCopy(
  inputs: Readonly<Record<string, unknown>>,
  packages?: readonly string[],
): string[];

/** The script's command line; returns the exit code (0 written, 1 not written). */
export function runCli(
  argv: readonly string[],
  io?: {
    stdout: { write(text: string): unknown };
    stderr: { write(text: string): unknown };
  },
): Promise<number>;
