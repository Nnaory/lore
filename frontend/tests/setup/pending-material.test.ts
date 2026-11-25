/**
 * Tests — pending material (home page → /create handoff)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setPendingMaterial, takePendingMaterial } from "@/lib/setup/pending-material";

beforeEach(() => {
  takePendingMaterial(); // start every test with an empty slot
});

const fileNamed = (name: string) => new File(["notes"], name, { type: "text/plain" });

describe("pending material", () => {
  it("is empty until something is set", () => {
    expect(takePendingMaterial()).toBeNull();
  });

  it("hands over a file with its instructions, once", () => {
    const file = fileNamed("notes.txt");
    setPendingMaterial({ file, instructions: "focus on dot products" });

    const taken = takePendingMaterial();
    expect(taken?.file).toBe(file);
    expect(taken?.instructions).toBe("focus on dot products");
    expect(takePendingMaterial()).toBeNull();
  });

  it("keeps only the latest handoff", () => {
    setPendingMaterial({ file: fileNamed("first.txt"), instructions: "" });
    const second = fileNamed("second.txt");
    setPendingMaterial({ file: second, instructions: "" });
    expect(takePendingMaterial()?.file).toBe(second);
  });
});
