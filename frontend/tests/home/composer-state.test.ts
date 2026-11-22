/**
 * Tests — Home composer pure state (composer-state, hazel-greeting)
 */

import { describe, it, expect } from "vitest";
import { chooseFile, decideSend } from "@/lib/home/composer-state";
import { hazelGreeting } from "@/lib/home/hazel-greeting";

const ok = { name: "a.txt", size: 10, type: "text/plain" };
const bad = { name: "a.exe", size: 10, type: "application/x-msdownload" };

describe("chooseFile", () => {
  it("accepts a valid file", () => {
    expect(chooseFile(null, ok)).toEqual({ ok: true, file: ok });
  });
  it("keeps the current file when the candidate is rejected", () => {
    const r = chooseFile(ok, bad);
    expect(r.ok).toBe(false);
    expect(r.file).toBe(ok);
  });
});

describe("decideSend", () => {
  it("is idle with no file and no text", () => {
    expect(decideSend(null, "  ")).toEqual({ kind: "idle" });
  });
  it("requires a file when text was typed", () => {
    expect(decideSend(null, "topic")).toEqual({ kind: "file_required" });
  });
  it("submits with trimmed instructions", () => {
    expect(decideSend(ok, " focus ")).toEqual({ kind: "submit", file: ok, instructions: "focus" });
  });
});

describe("hazelGreeting", () => {
  it("smiles and asks for a file when none is attached", () => {
    const g = hazelGreeting(false);
    expect(g.expression).toBe("smile");
    expect(g.line).toMatch(/as a file/);
    expect(g.line).not.toMatch(/tell me a topic/i);
  });
  it("is surprised once a file is attached and resets after removal", () => {
    expect(hazelGreeting(true).expression).toBe("surprised");
    expect(hazelGreeting(true).fileLabel).toBe("Replace");
    expect(hazelGreeting(false)).toEqual(hazelGreeting(false));
    expect(hazelGreeting(false).fileLabel).toBe("Add file");
  });
});
