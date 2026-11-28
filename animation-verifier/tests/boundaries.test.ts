// Tes batas, sentinel, dan handler tambahan (tugas 8.3).
// Validates: Requirements 32.13, 32.14, 38.10, 38.11

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { createHandler } from "../src/handler.js";
import { DEFAULT_STEPS } from "../src/steps/registry.js";
import { createWorkerRenderHost } from "../src/steps/render-host.js";
import { createRenderStep } from "../src/steps/render.js";
import { sizeStep } from "../src/steps/size.js";
import { ArtifactStore, createStepContext } from "../src/steps/step.js";
import { verify } from "../src/verify.js";
import { compileRenderWorker, type CompiledRenderWorker } from "./support/compile-render-worker.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

const PACKAGE_URL = new URL("../", import.meta.url);
const loaded = loadContract(
  JSON.parse(readFileSync(new URL("contract/animation-contract.json", PACKAGE_URL), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

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

function baseLesson(overrides: { durationInFrames?: number; body?: string; label?: string } = {}): string {
  const duration = overrides.durationInFrames ?? 60;
  const label = overrides.label ?? "alpha";
  const body =
    overrides.body ??
    `return createElement("div", null, "${label}", String(frame));`;
  return `import { createElement } from "react";
import { useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: ${duration} };

export default function Main() {
  const frame = useCurrentFrame();
  ${body}
}
`;
}

function basePuzzle(duration: number, pauseAtFrame: number): string {
  return `import { createElement } from "react";
import { useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: ${duration}, pauseAtFrame: ${pauseAtFrame} };

export default function Main() {
  const frame = useCurrentFrame();
  return createElement("div", null, "alpha", String(frame));
}
`;
}

describe("Tes batas Requirement 38.10", () => {
  it("ukuran sumber: 32768 byte lolos langkah 1 dan 32769 byte memicu SIZE_SOURCE_TOO_LARGE", async () => {
    const runSize = async (source: string) => {
      const clock = new FakeClock(1_000);
      const ctx = createStepContext({
        input: {
          source,
          kind: "lesson",
          required_tokens: [],
          forbidden_tokens: [],
          contract_version: contract.contract_version,
        },
        contract,
        clock,
        deadlineAt: 31_000,
        artifacts: new ArtifactStore(),
      });
      return sizeStep.run(ctx);
    };

    const okRes = await runSize("a".repeat(32768));
    expect(okRes.diagnostics).toEqual([]);

    const badRes = await runSize("a".repeat(32769));
    expect(badRes.diagnostics.map((d) => d.code)).toEqual(["SIZE_SOURCE_TOO_LARGE"]);
  });

  it("durationInFrames: 30 dan 900 lolos, 29 dan 901 gagal POLICY_META_INVALID", async () => {
    for (const d of [30, 900]) {
      const res = await verify(
        {
          source: baseLesson({ durationInFrames: d }),
          kind: "lesson",
          required_tokens: ["alpha"],
          forbidden_tokens: [],
          contract_version: contract.contract_version,
        },
        { clock: new FakeClock(1_000), contract, steps },
      );
      expect(res.ok, `duration=${d}`).toBe(true);
    }

    for (const d of [29, 901]) {
      const res = await verify(
        {
          source: baseLesson({ durationInFrames: d }),
          kind: "lesson",
          required_tokens: ["alpha"],
          forbidden_tokens: [],
          contract_version: contract.contract_version,
        },
        { clock: new FakeClock(1_000), contract, steps },
      );
      expect(res.ok, `duration=${d}`).toBe(false);
      expect(res.diagnostics.map((x) => x.code)).toContain("POLICY_META_INVALID");
    }
  });

  it("pauseAtFrame: d-1 lolos dan d gagal POLICY_META_INVALID", async () => {
    const okRes = await verify(
      {
        source: basePuzzle(60, 59),
        kind: "puzzle",
        required_tokens: ["alpha"],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { clock: new FakeClock(1_000), contract, steps },
    );
    expect(okRes.ok).toBe(true);

    const badRes = await verify(
      {
        source: basePuzzle(60, 60),
        kind: "puzzle",
        required_tokens: ["alpha"],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { clock: new FakeClock(1_000), contract, steps },
    );
    expect(badRes.ok).toBe(false);
    expect(badRes.diagnostics.map((x) => x.code)).toContain("POLICY_META_INVALID");
  });

  it("elemen DOM: <= 600 lolos dan 601 memicu RENDER_DOM_LIMIT", async () => {
    // Thumbnail membungkus dengan 3 elemen wrapper + 1 div induk = 4 elemen; sehingga 596 span = 600 dan 597 span = 601.
    const underBody = `const items = Array.from({ length: 596 }, (_, i) => createElement("span", { key: i }, i === 0 ? "alpha" : ""));
    return createElement("div", null, ...items, String(frame));`;
    const overBody = `const items = Array.from({ length: 597 }, (_, i) => createElement("span", { key: i }, i === 0 ? "alpha" : ""));
    return createElement("div", null, ...items, String(frame));`;

    const okRes = await verify(
      {
        source: baseLesson({ body: underBody }),
        kind: "lesson",
        required_tokens: ["alpha"],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { clock: new FakeClock(1_000), contract, steps },
    );
    expect(okRes.diagnostics.map((x) => x.code)).not.toContain("RENDER_DOM_LIMIT");

    const badRes = await verify(
      {
        source: baseLesson({ body: overBody }),
        kind: "lesson",
        required_tokens: ["alpha"],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { clock: new FakeClock(1_000), contract, steps },
    );
    expect(badRes.ok).toBe(false);
    expect(badRes.diagnostics.map((x) => x.code)).toContain("RENDER_DOM_LIMIT");
  });

  it("token 80 karakter cocok normalisasi dan hadir di checks summary", async () => {
    const token80 = "x".repeat(80);
    const res = await verify(
      {
        source: baseLesson({ label: token80 }),
        kind: "lesson",
        required_tokens: [token80],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { clock: new FakeClock(1_000), contract, steps },
    );
    expect(res.ok).toBe(true);
    expect(res.summary.checks.length).toBe(7);
    for (const check of res.summary.checks) {
      expect(check.ms).toBeGreaterThanOrEqual(0);
    }
    expect(res.diagnostics.every((d) => d.code !== "VERIFIER_CRASH")).toBe(true);
  });
});

describe("Tes sentinel log handler (Requirement 32.13)", () => {
  it("sentinel di source dan token tidak muncul pada baris log handler", async () => {
    const logLines: string[] = [];
    const handler = createHandler({
      load: () => ({ ok: true, contract }),
      writeLine: (line) => {
        logLines.push(line);
      },
    });
    const sentinel = "SENTINEL_SECRET_SOURCE_TOKEN_9988";
    const result = await handler(
      {
        source: `const ${sentinel} = window; export default function Main() { return null; }`,
        kind: "lesson",
        required_tokens: [sentinel],
        forbidden_tokens: [],
        contract_version: contract.contract_version,
      },
      { awsRequestId: "req-sentinel" },
    );
    expect(result.ok).toBe(false);
    expect(logLines.length).toBe(1);
    expect(logLines[0]).not.toContain(sentinel);
    expect(result.diagnostics.every((d) => d.code !== "VERIFIER_CRASH")).toBe(true);
  });
});
