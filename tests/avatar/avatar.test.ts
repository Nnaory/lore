// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_EVENT,
  AVATAR_KEY,
  AVATAR_PRESETS,
  DEFAULT_AVATAR,
  MAX_ART_COLUMNS,
  avatarArt,
  avatarName,
  isValidArt,
  loadAvatar,
  parseAvatar,
  saveAvatar,
} from "@/lib/avatar/avatar";

afterEach(() => window.localStorage.removeItem(AVATAR_KEY));

describe("presets", () => {
  it("are valid, unique, multi-line ASCII art", () => {
    const ids = new Set(AVATAR_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(AVATAR_PRESETS.length);
    for (const preset of AVATAR_PRESETS) {
      expect(isValidArt(preset.art)).toBe(true);
      expect(preset.art.split("\n").length).toBeGreaterThan(4);
      expect(preset.art).not.toMatch(/^\n|[ \t]+$/m); // no blank first line or trailing spaces
    }
  });
});

describe("isValidArt", () => {
  it("accepts printable ASCII within limits", () => {
    expect(isValidArt(" .:\n@#%")).toBe(true);
  });
  it("rejects empty, non-ASCII, and oversized art", () => {
    expect(isValidArt("   \n  ")).toBe(false);
    expect(isValidArt("héllo")).toBe(false);
    expect(isValidArt("a\tb")).toBe(false);
    expect(isValidArt("#".repeat(MAX_ART_COLUMNS + 1))).toBe(false);
    expect(isValidArt(Array(41).fill("#").join("\n"))).toBe(false);
  });
});

describe("parseAvatar", () => {
  it("falls back to the default for missing or invalid data", () => {
    expect(parseAvatar(null)).toEqual(DEFAULT_AVATAR);
    expect(parseAvatar("not json")).toEqual(DEFAULT_AVATAR);
    expect(parseAvatar(JSON.stringify({ kind: "preset", id: "nope" }))).toEqual(DEFAULT_AVATAR);
    expect(parseAvatar(JSON.stringify({ kind: "custom", art: "<script>é" }))).toEqual(DEFAULT_AVATAR);
  });
});

describe("save and load", () => {
  it("starts with the default preset", () => {
    expect(loadAvatar()).toEqual(DEFAULT_AVATAR);
    expect(avatarArt(loadAvatar())).toBe(AVATAR_PRESETS[0].art);
  });

  it("round-trips a preset and announces the change", () => {
    const listener = vi.fn();
    window.addEventListener(AVATAR_EVENT, listener);
    expect(saveAvatar({ kind: "preset", id: "automaton" })).toBe(true);
    window.removeEventListener(AVATAR_EVENT, listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(loadAvatar()).toEqual({ kind: "preset", id: "automaton" });
    expect(avatarName(loadAvatar())).toBe("Automaton");
  });

  it("round-trips custom art", () => {
    expect(saveAvatar({ kind: "custom", art: " .:\n:@:" })).toBe(true);
    const avatar = loadAvatar();
    expect(avatarArt(avatar)).toBe(" .:\n:@:");
    expect(avatarName(avatar)).toBe("Your picture");
  });

  it("refuses to save invalid art", () => {
    expect(saveAvatar({ kind: "custom", art: "" })).toBe(false);
    expect(window.localStorage.getItem(AVATAR_KEY)).toBeNull();
  });
});
