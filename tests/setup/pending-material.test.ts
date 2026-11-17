/**
 * Tests — pending material (home page → /create handoff)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setPendingMaterial, takePendingMaterial } from "@/lib/setup/pending-material";

beforeEach(() => {
  takePendingMaterial(); // start every test with an empty slot
});

describe("pending material", () => {
  it("is empty until something is set", () => {
    expect(takePendingMaterial()).toBeNull();
  });

  it("hands over typed text once", () => {
    setPendingMaterial({ kind: "text", text: "Vectors have direction." });
    expect(takePendingMaterial()).toEqual({ kind: "text", text: "Vectors have direction." });
    expect(takePendingMaterial()).toBeNull();
  });

  it("hands over a file", () => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    setPendingMaterial({ kind: "file", file });
    const taken = takePendingMaterial();
    expect(taken?.kind).toBe("file");
    expect(taken?.kind === "file" && taken.file).toBe(file);
  });

  it("keeps only the latest handoff", () => {
    setPendingMaterial({ kind: "text", text: "first" });
    setPendingMaterial({ kind: "text", text: "second" });
    expect(takePendingMaterial()).toEqual({ kind: "text", text: "second" });
  });
});
