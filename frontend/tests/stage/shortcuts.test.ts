/**
 * shortcuts.test.ts — property tests for the Stage keyboard shortcut mapping.
 *
 * Why: SPACE/F/L must map to next/toggle-mode/open-log and every other key to
 * nothing, on a neutral target with no modifiers and no modal.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveShortcut, type ShortcutTargetKind } from "@/lib/stage/shortcuts";

const neutralTarget = fc.constantFrom<ShortcutTargetKind | undefined>(
  undefined,
  "none",
  "other",
);

// Feature: ui-redesign, Property 14: Pintasan memetakan tombol ke aksi yang benar
describe("resolveShortcut mapping (Property 14)", () => {
  it("SPACE maps to next on a neutral target", () => {
    fc.assert(
      fc.property(
        neutralTarget,
        fc.constantFrom({ key: " " }, { key: " ", code: "Space" }, { key: "Spacebar", code: "Space" }),
        (targetKind, k) => {
          expect(resolveShortcut({ ...k, targetKind }, { modalOpen: false })).toEqual({
            ok: true,
            action: "next",
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("F and f map to toggle-mode, L and l map to open-log", () => {
    fc.assert(
      fc.property(
        neutralTarget,
        fc.constantFrom("F", "f", "L", "l"),
        fc.boolean(),
        (targetKind, key, withCode) => {
          const event = withCode
            ? { key, code: `Key${key.toUpperCase()}`, targetKind }
            : { key, targetKind };
          const expected = key.toLowerCase() === "f" ? "toggle-mode" : "open-log";
          expect(resolveShortcut(event, { modalOpen: false })).toEqual({
            ok: true,
            action: expected,
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("any other key is unmapped", () => {
    const otherKey = fc
      .oneof(fc.string({ minLength: 1, maxLength: 12 }), fc.constantFrom("Enter", "Escape", "a", "Tab"))
      .filter((k) => k !== " " && !["f", "l"].includes(k.toLowerCase()));
    fc.assert(
      fc.property(neutralTarget, otherKey, (targetKind, key) => {
        const r = resolveShortcut({ key, targetKind }, { modalOpen: false });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("unmapped");
      }),
      { numRuns: 200 },
    );
  });
});

// Feature: ui-redesign, Property 15: Pintasan ditekan pada elemen editable, pengubah, atau modal diabaikan
describe("resolveShortcut ignored presses (Property 15)", () => {
  const anyKey = fc.oneof(
    fc.constantFrom(" ", "f", "F", "l", "L", "Enter"),
    fc.string({ minLength: 1, maxLength: 4 }),
  );
  const anyTarget = fc.constantFrom<ShortcutTargetKind | undefined>(
    undefined,
    "none",
    "editable",
    "activatable",
    "other",
  );

  it("editable target is ignored for any key", () => {
    fc.assert(
      fc.property(anyKey, fc.boolean(), (key, modalOpen) => {
        const r = resolveShortcut({ key, targetKind: "editable" }, { modalOpen });
        expect(r.ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("ctrl, meta or alt makes any key ignored", () => {
    const mods = fc
      .record({ ctrlKey: fc.boolean(), metaKey: fc.boolean(), altKey: fc.boolean() })
      .filter((m) => m.ctrlKey || m.metaKey || m.altKey);
    fc.assert(
      fc.property(anyKey, anyTarget, mods, fc.boolean(), (key, targetKind, m, modalOpen) => {
        const r = resolveShortcut({ key, targetKind, ...m }, { modalOpen });
        expect(r.ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("an open modal makes any key ignored", () => {
    fc.assert(
      fc.property(anyKey, anyTarget, (key, targetKind) => {
        const r = resolveShortcut({ key, targetKind }, { modalOpen: true });
        expect(r.ok).toBe(false);
        if (targetKind !== "editable" && !r.ok) expect(r.reason).toBe("modal");
      }),
      { numRuns: 100 },
    );
  });

  it("SPACE on a self-activating element is ignored without modifiers or modal", () => {
    fc.assert(
      fc.property(
        fc.constantFrom({ key: " " }, { key: " ", code: "Space" }, { key: "Spacebar", code: "Space" }),
        (k) => {
          expect(resolveShortcut({ ...k, targetKind: "activatable" }, { modalOpen: false })).toEqual({
            ok: false,
            reason: "self_handled",
          });
        },
      ),
      { numRuns: 50 },
    );
  });
});
