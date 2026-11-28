// Property 2: Determinisme verifier (tugas 7.3).
// Validates: Requirements 6.12, 38.3

import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { createWorkerRenderHost } from "../src/steps/render-host.js";
import { createRenderStep } from "../src/steps/render.js";
import type { VerifierResult, VerifierSummary } from "../src/types.js";
import { verify } from "../src/verify.js";
import { compileRenderWorker, type CompiledRenderWorker } from "./support/compile-render-worker.js";

vi.setConfig({ testTimeout: 120_000 });

const PACKAGE_URL = new URL("../", import.meta.url);
const GOOD_DIR = new URL("fixtures/good/", PACKAGE_URL);

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("contract/animation-contract.json", PACKAGE_URL), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

interface Companion {
  readonly kind: "lesson" | "puzzle";
  readonly required_tokens: readonly string[];
  readonly forbidden_tokens: readonly string[];
}

const GOOD_FIXTURES = readdirSync(GOOD_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => {
    const source = readFileSync(new URL(name, GOOD_DIR), "utf8");
    const companion = JSON.parse(
      readFileSync(new URL(name.replace(/\.ts$/, ".json"), GOOD_DIR), "utf8"),
    ) as Companion;
    return { name, source, companion };
  });

function stripMs(summary: VerifierSummary) {
  return {
    ...summary,
    checks: summary.checks.map(({ name, ok }) => ({ name, ok })),
  };
}

function normalizeResult(result: VerifierResult) {
  return result.ok
    ? {
        ok: true as const,
        diagnostics: result.diagnostics,
        bundle: result.bundle,
        meta: result.meta,
        summary: stripMs(result.summary),
      }
    : {
        ok: false as const,
        diagnostics: result.diagnostics,
        summary: stripMs(result.summary),
      };
}

const MUTATIONS: readonly ((source: string) => string)[] = [
  (s) => s,
  (s) => `${s}\n// comment\n`,
  (s) => s.replace("export const meta =", "export   const   meta ="),
  (s) => `${s}\nconst unused_helper = 42;\n`,
  (s) => `${s}\nexport const extra = 1;\n`,
];

let compiled: CompiledRenderWorker;
let steps: typeof DEFAULT_STEPS;

beforeAll(() => {
  compiled = compileRenderWorker();
  const host = createWorkerRenderHost({ workerUrl: compiled.workerUrl });
  steps = DEFAULT_STEPS.map((step) => (step.number === 6 ? createRenderStep(host) : step));
});

afterAll(() => {
  compiled?.dispose();
});

describe("Property 2: Determinisme verifier", () => {
  it("dua panggilan verify() menghasilkan ok, diagnostics, bundle, meta, dan summary identik selain ms", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...GOOD_FIXTURES),
        fc.constantFrom(...MUTATIONS),
        async (fixture, mutate) => {
          const event = {
            source: mutate(fixture.source),
            kind: fixture.companion.kind,
            required_tokens: [...fixture.companion.required_tokens],
            forbidden_tokens: [...fixture.companion.forbidden_tokens],
            contract_version: contract.contract_version,
          };

          const first = await verify(event, { clock: new FakeClock(1_000), contract, steps });
          const second = await verify(event, { clock: new FakeClock(99_000), contract, steps });

          expect(first.diagnostics.every((d) => d.code !== "VERIFIER_INTERNAL"), fixture.name).toBe(true);
          expect(normalizeResult(first)).toEqual(normalizeResult(second));
        },
      ),
      { numRuns: 10 },
    );
  });
});
