// Tes kecil host Worker NYATA untuk langkah 6 (tugas 6.2; design 5.9, Requirement 11.1, 11.7, 11.9).
// Worker dikompilasi dengan compiler TypeScript ke direktori sementara (`tests/support/
// compile-render-worker.ts`) karena Worker harus menjalankan JavaScript hasil `tsc`, bukan `.ts`.
// Cakupan sengaja kecil: jalur sukses lewat `createRenderStep` dengan host nyata, Worker dan konteks
// `vm` baru pada tiap invokasi, dan cabang RSS dengan pembaca RSS yang disuntikkan (tanpa mengalokasikan
// memori besar). Isolasi, watchdog loop tak berujung, `new Uint8Array(1.4e9)`, dan batas waktu total
// pada korpus adalah tugas 6.3 (`render-real.test.ts`).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/clock.js";
import { loadContract, type Contract } from "../src/contract.js";
import { createWorkerRenderHost, type RenderRequest } from "../src/steps/render-host.js";
import { FRAMES_ARTIFACT, createRenderStep } from "../src/steps/render.js";
import { BUNDLE_ARTIFACT, META_ARTIFACT, createStepContext } from "../src/steps/step.js";
import type { MainMeta } from "../src/types.js";
import { compileRenderWorker, type CompiledRenderWorker } from "./support/compile-render-worker.js";
import { handBundle } from "./support/render-bundles.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const loaded = loadContract(
  JSON.parse(readFileSync(new URL("../contract/animation-contract.json", import.meta.url), "utf8")),
);
if (!loaded.ok) throw new Error(`kontrak sumber tidak sah: ${loaded.reason}`);
const contract: Contract = loaded.contract;

const META: MainMeta = { width: 1280, height: 720, fps: 30, durationInFrames: 30 };
const LOW_RSS = (): number => 0;

let compiled: CompiledRenderWorker;
beforeAll(() => {
  compiled = compileRenderWorker();
});
afterAll(() => {
  compiled?.dispose();
});

function requestFor(bundle: string): RenderRequest {
  return {
    job: {
      type: "run",
      bundle,
      frames: [0, 29],
      shim: { allowed_imports: contract.allowed_imports },
      fps: 30,
      width: 1280,
      height: 720,
      staticMeta: META,
    },
    limits: {
      frame_timeout_ms: contract.limits.frame_timeout_ms,
      rss_limit_mb: contract.limits.rss_limit_mb,
      worker_heap_mb: contract.limits.worker_heap_mb,
    },
    remainingMs: contract.limits.verifier_deadline_ms,
    deadlineReached: () => false,
  };
}

describe("host Worker nyata (hasil tsc di direktori sementara)", () => {
  it("merender bundle di Worker dan mengembalikan hasil; Worker dan konteks vm baru untuk tiap invokasi", async () => {
    const host = createWorkerRenderHost({ workerUrl: compiled.workerUrl, readRssBytes: LOW_RSS });
    const bundle = handBundle(
      'return h("div", null, "run " + globalThis.__runs);',
      { top: "globalThis.__runs = (globalThis.__runs ?? 0) + 1;" },
    );

    const texts: Array<string | undefined> = [];
    for (let run = 0; run < 2; run += 1) {
      const outcome = await host.run(requestFor(bundle));
      expect(outcome.kind).toBe("result");
      if (outcome.kind !== "result") continue;
      expect(outcome.result.evaluateError).toBeUndefined();
      expect(outcome.result.metaMatches).toBe(true);
      expect(outcome.result.frames[29]?.secondHtml).toBe(outcome.result.frames[29]?.html);
      texts.push(outcome.result.frames[29]?.text);
    }
    expect(texts).toEqual(["run 1", "run 1"]);
  });

  it("langkah 6 di atas host nyata: bundle sehat tanpa temuan, bundle kosong melapor RENDER_EMPTY", async () => {
    const step = createRenderStep(createWorkerRenderHost({ workerUrl: compiled.workerUrl, readRssBytes: LOW_RSS }));
    const run = async (bundle: string) => {
      const context = createStepContext({
        input: { source: "", kind: "lesson", required_tokens: [], forbidden_tokens: [], contract_version: 1 },
        contract,
        clock: new FakeClock(),
        deadlineAt: Number.POSITIVE_INFINITY,
      });
      context.artifacts.set(META_ARTIFACT, META);
      context.artifacts.set(BUNDLE_ARTIFACT, bundle);
      const result = await step.run(context);
      return { diagnostics: result.diagnostics, frames: context.artifacts.get(FRAMES_ARTIFACT) };
    };

    const good = await run(handBundle('return h("p", null, "Water boils at " + R.useCurrentFrame());'));
    expect(good.diagnostics).toEqual([]);
    expect(good.frames?.map((f) => f.frame)).toEqual([0, 7, 15, 22, 29]);
    expect(good.frames?.at(-1)?.text).toBe("Water boils at 29");

    const empty = await run(handBundle("return null;"));
    expect(empty.diagnostics.map((d) => d.message)).toEqual(
      [0, 7, 15, 22, 29].map((frame) => `frame=${frame} rendered no content`),
    );
  });

  it("RSS di atas batas menghentikan Worker dan melaporkan resource_limit", async () => {
    const host = createWorkerRenderHost({
      workerUrl: compiled.workerUrl,
      readRssBytes: () => (contract.limits.rss_limit_mb + 1) * 1024 * 1024,
    });
    const outcome = await host.run(requestFor(handBundle('return h("div", null, "x");')));
    expect(outcome).toEqual({ kind: "resource_limit" });
  });

  it("Worker yang tidak ditemukan menjadi failure, bukan exception", async () => {
    const host = createWorkerRenderHost({
      workerUrl: new URL("./does-not-exist/render-worker.js", compiled.workerUrl),
      readRssBytes: LOW_RSS,
    });
    expect(await host.run(requestFor(handBundle('return h("div", null, "x");')))).toEqual({ kind: "failure" });
  });
});
