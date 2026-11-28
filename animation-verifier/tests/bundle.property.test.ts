// Property 4: Bundle reproducible dan round-trip penyimpanan (bagian bundle, tugas 5.5).
// Validates: Requirements 8.9, 8.14

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { loadContract } from "../src/contract.js";
import { bundleStep } from "../src/steps/bundle.js";

vi.setConfig({ testTimeout: 60_000 });

const PACKAGE_URL = new URL("../", import.meta.url);
const GOOD_DIR = new URL("fixtures/good/", PACKAGE_URL);

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("contract/animation-contract.json", PACKAGE_URL), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const MAX_BYTES = loaded.contract.limits.bundle_max_bytes;

const GOOD_SOURCES = readdirSync(GOOD_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => ({ name, source: readFileSync(new URL(name, GOOD_DIR), "utf8") }));

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const WORKING_DIRS = [
  "/",
  "/tmp",
  "/var/task",
  "/home/builder/project",
  "/opt/lore/animation-verifier",
  "/srv/ci/runner-1/work",
];

describe("Property 4: Bundle reproducible", () => {
  it("semua fixture good menghasilkan SHA-256 bundle yang identik untuk dua absWorkingDir berbeda", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...GOOD_SOURCES),
        fc.constantFrom(...WORKING_DIRS),
        fc.constantFrom(...WORKING_DIRS),
        async (fixture, dirA, dirB) => {
          const outA = await bundleStep(fixture.source, MAX_BYTES, { absWorkingDir: dirA });
          const outB = await bundleStep(fixture.source, MAX_BYTES, { absWorkingDir: dirB });
          expect(outA.ok, fixture.name).toBe(true);
          expect(outB.ok, fixture.name).toBe(true);
          if (!outA.ok || !outB.ok) return;
          expect(sha256(outA.bundle)).toBe(sha256(outB.bundle));
          expect(outA.bundle).toBe(outB.bundle);
        },
      ),
      { numRuns: 30 },
    );
  });
});
