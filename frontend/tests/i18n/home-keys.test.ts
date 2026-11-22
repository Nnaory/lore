import { describe, it, expect } from "vitest";
import { UI, type UiKey } from "@/lib/i18n/ui";

const NEW_KEYS = [
  "home.inputLabel", "home.fileInputLabel", "home.removeFileNamed", "home.formats", "home.fileRequired",
  "home.file.unsupported_format", "home.file.empty_file", "home.file.too_large",
  "home.placeholderShort", "home.formatsShort",
  "home.hazelAlt.smile", "home.hazelAlt.surprised",
  "stories.title", "stories.label", "stories.completed", "stories.progress", "stories.continue",
  "stories.replay", "stories.delete", "stories.deleteNamed", "stories.keep",
  "stories.genre.fantasy", "stories.genre.modern", "stories.genre.science_fiction",
] as UiKey[];

describe("Home i18n keys", () => {
  it.each(["en", "id"] as const)("%s has every new key, non-empty", (lang) => {
    for (const k of NEW_KEYS) {
      expect(typeof UI[lang][k], k).toBe("string");
      expect(UI[lang][k].trim().length, k).toBeGreaterThan(0);
    }
  });

  it("placeholders survive in both languages", () => {
    for (const lang of ["en", "id"] as const) {
      expect(UI[lang]["home.formats"]).toContain("{mb}");
      expect(UI[lang]["home.formatsShort"]).toContain("{mb}");
      expect(UI[lang]["home.removeFileNamed"]).toContain("{file}");
      expect(UI[lang]["home.gotFile"]).toContain("{file}");
      expect(UI[lang]["stories.deleteNamed"]).toContain("{title}");
      expect(UI[lang]["stories.progress"]).toContain("{done}");
      expect(UI[lang]["stories.progress"]).toContain("{total}");
    }
  });

  it("no home.* value mentions topic/topik", () => {
    for (const lang of ["en", "id"] as const) {
      for (const [k, v] of Object.entries(UI[lang])) {
        if (k.startsWith("home.")) expect(v, `${lang} ${k}`).not.toMatch(/topic|topik/i);
      }
    }
  });
});
