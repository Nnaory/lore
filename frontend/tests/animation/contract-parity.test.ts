/**
 * Tests: animation contract reader and parity (task 20.1).
 *
 * Covers Requirement 2.6 (one source of truth), 2.8 (canvas constants equal the contract),
 * 2.10 / 2.11 (total reader with the minimum checks):
 *   1. the frontend copy is byte-identical to the verifier source;
 *   2. `CANVAS_WIDTH`, `CANVAS_HEIGHT`, `CANVAS_FPS` equal `contract.canvas`;
 *   3. the shipped copy is accepted and `CONTRACT` is that contract;
 *   4. every minimum check rejects its violation with a reason naming the field;
 *   5. `readContract` never throws, whatever it is given.
 *
 * The contract values are read from the JSON itself; nothing here restates them as literals.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_FPS, CANVAS_HEIGHT, CANVAS_WIDTH } from "@/components/stage/canvas-layout";
import { CONTRACT, CONTRACT_READ, readContract } from "@/lib/animation/contract";

const FRONTEND_COPY = join(__dirname, "..", "..", "src", "lib", "animation", "animation-contract.json");
const VERIFIER_SOURCE = join(
  __dirname,
  "..",
  "..",
  "..",
  "animation-verifier",
  "contract",
  "animation-contract.json",
);

type Json = Record<string, unknown>;

/** A fresh deep copy of the shipped contract, safe to mutate. */
function fresh(): Json {
  return JSON.parse(readFileSync(FRONTEND_COPY, "utf8")) as Json;
}

/** Applies `mutate` to a fresh copy and returns the reader's verdict. */
function readMutated(mutate: (c: Json) => void) {
  const copy = fresh();
  mutate(copy);
  return readContract(copy);
}

/** Reads `a.b.c` style paths into nested objects. */
function nested(root: Json, path: string): Json {
  return path.split(".").reduce<Json>((node, key) => node[key] as Json, root);
}

const FIELDS = Object.keys(fresh());
const LIMIT_KEYS = Object.keys(fresh().limits as Json);

describe("contract copy parity", () => {
  it("is byte-identical to the verifier source", () => {
    const copy = readFileSync(FRONTEND_COPY);
    const source = readFileSync(VERIFIER_SOURCE);
    expect(copy.equals(source)).toBe(true);
  });

  it("has the 20 contract fields", () => {
    expect(FIELDS).toHaveLength(20);
  });

  it("keeps the stage canvas constants equal to contract.canvas", () => {
    expect(CANVAS_WIDTH).toBe(CONTRACT.canvas.width);
    expect(CANVAS_HEIGHT).toBe(CONTRACT.canvas.height);
    expect(CANVAS_FPS).toBe(CONTRACT.canvas.fps);
  });
});

describe("CONTRACT", () => {
  it("is read successfully from the shipped copy", () => {
    expect(CONTRACT_READ.ok).toBe(true);
  });

  it("equals the JSON of the shipped copy", () => {
    expect(CONTRACT).toEqual(fresh());
  });
});

describe("readContract: accepted input", () => {
  it("accepts the shipped contract", () => {
    const result = readContract(fresh());
    expect(result.ok).toBe(true);
  });

  it("drops unknown keys", () => {
    const result = readContract({ ...fresh(), unexpected: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contract).not.toHaveProperty("unexpected");
  });

  it("accepts the smallest valid duration range (min equal to max)", () => {
    const result = readMutated((c) => {
      const duration = c.duration as Json;
      duration.max = duration.min;
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a contract_version listed among several supported versions", () => {
    const result = readMutated((c) => {
      c.supported_runtime_contract_versions = [
        (c.contract_version as number) + 1,
        c.contract_version,
      ];
    });
    expect(result.ok).toBe(true);
  });
});

describe("readContract: every field is required", () => {
  it.each(FIELDS)("rejects a contract without %s", (field) => {
    const result = readMutated((c) => {
      delete c[field];
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(field);
  });
});

describe("readContract: minimum checks", () => {
  const notPositiveInt: Array<[string, unknown]> = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "1"],
    ["null", null],
  ];

  describe.each(["contract_version", "canvas.width", "canvas.height", "canvas.fps"])("%s", (path) => {
    it.each(notPositiveInt)("rejects %s", (_label, value) => {
      const result = readMutated((c) => {
        const keys = path.split(".");
        const last = keys.pop() as string;
        const parent = keys.length > 0 ? nested(c, keys.join(".")) : c;
        parent[last] = value;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(path);
    });
  });

  describe("limits", () => {
    it.each(LIMIT_KEYS)("rejects limits.%s equal to 0", (key) => {
      const result = readMutated((c) => {
        (c.limits as Json)[key] = 0;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(`limits.${key}`);
    });

    it.each(LIMIT_KEYS)("rejects a fractional limits.%s", (key) => {
      const result = readMutated((c) => {
        (c.limits as Json)[key] = 1.5;
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("duration", () => {
    it("rejects min below 1", () => {
      const result = readMutated((c) => {
        (c.duration as Json).min = 0;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("duration.min");
    });

    it("rejects min greater than max", () => {
      const result = readMutated((c) => {
        const duration = c.duration as Json;
        duration.min = (duration.max as number) + 1;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("duration.min");
    });

    it("rejects max below 1", () => {
      const result = readMutated((c) => {
        (c.duration as Json).max = 0;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("duration.max");
    });
  });

  describe("supported_runtime_contract_versions", () => {
    it("rejects an empty list", () => {
      const result = readMutated((c) => {
        c.supported_runtime_contract_versions = [];
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("supported_runtime_contract_versions");
    });

    it("rejects a list that does not include contract_version", () => {
      const result = readMutated((c) => {
        c.supported_runtime_contract_versions = [(c.contract_version as number) + 1];
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("supported_runtime_contract_versions");
    });

    it("rejects a non-integer entry", () => {
      const result = readMutated((c) => {
        c.supported_runtime_contract_versions = [c.contract_version, 1.5];
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("color_tokens", () => {
    it("rejects one token fewer", () => {
      const result = readMutated((c) => {
        (c.color_tokens as string[]).pop();
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("color_tokens");
    });

    it("rejects one token more", () => {
      const result = readMutated((c) => {
        (c.color_tokens as string[]).push("extra");
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("color_tokens");
    });
  });

  describe("diagnostic_code_prefixes", () => {
    it("rejects one prefix fewer", () => {
      const result = readMutated((c) => {
        const prefixes = c.diagnostic_code_prefixes as string[];
        prefixes.splice(prefixes.indexOf("SIZE"), 1);
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("diagnostic_code_prefixes");
    });

    it("rejects one prefix more", () => {
      const result = readMutated((c) => {
        (c.diagnostic_code_prefixes as string[]).push("EXTRA");
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("diagnostic_code_prefixes");
    });

    it("rejects a list of the right length without AGENT", () => {
      const result = readMutated((c) => {
        const prefixes = c.diagnostic_code_prefixes as string[];
        prefixes[prefixes.indexOf("AGENT")] = "OTHER";
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("AGENT");
    });
  });

  describe("pause_rules", () => {
    it("rejects a rule other than required or forbidden", () => {
      const result = readMutated((c) => {
        (c.pause_rules as Json).lesson = "optional";
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("pause_rules.lesson");
    });
  });
});

describe("readContract: total on any input", () => {
  const notObjects: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["a string", "contract"],
    ["a number", 42],
    ["an empty object", {}],
  ];

  it.each(notObjects)("rejects %s without throwing", (_label, value) => {
    const result = readContract(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("rejects an object with a throwing getter instead of throwing", () => {
    const hostile = fresh();
    Object.defineProperty(hostile, "canvas", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(() => readContract(hostile)).not.toThrow();
    expect(readContract(hostile).ok).toBe(false);
  });

  it("limits the reason to five issues and counts the rest", () => {
    const result = readContract({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/\+\d+ more$/);
  });
});
