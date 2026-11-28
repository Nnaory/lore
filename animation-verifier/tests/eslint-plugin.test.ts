// Tes plugin ESLint lokal `lore` (tugas 5.1): kasus valid dan tidak valid per aturan, dijalankan
// lewat `Linter` ESLint dengan parser TypeScript, seperti konfigurasi internal langkah 3 (design 5.6).
// Opsi `lore/kit-style` dibangun dari kontrak sumber, bukan dari literal di tes ini
// (Requirement 2.6). Korpus `fixtures/good` harus bebas dari semua temuan plugin.
import { readdirSync, readFileSync } from "node:fs";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import lore, { type KitStyleOptions } from "../eslint-plugin-lore/index.js";
import { loadContract } from "../src/contract.js";

const CONTRACT_URL = new URL("../contract/animation-contract.json", import.meta.url);
const GOOD_DIR = new URL("../fixtures/good/", import.meta.url);

const loaded = loadContract(JSON.parse(readFileSync(CONTRACT_URL, "utf8")));
if (!loaded.ok) throw new Error(`contract fixture is invalid: ${loaded.reason}`);
const contract = loaded.contract;

const KIT_OPTIONS: KitStyleOptions = {
  kit_style_warnings: contract.kit_style_warnings,
  font_variables: contract.font_variables,
};

type RuleName = "no-module-state" | "uses-frame" | "kit-style";

const SEVERITY = { "no-module-state": "error", "uses-frame": "error", "kit-style": "warn" } as const;

/** Konfigurasi flat satu aturan, setara dengan baris `rules` pada bagian 5.6. */
function configFor(rule: RuleName, options: unknown[] = rule === "kit-style" ? [KIT_OPTIONS] : []) {
  return [
    {
      files: ["**/*.ts"],
      plugins: { lore },
      languageOptions: {
        parser: tseslint.parser,
        sourceType: "module" as const,
        ecmaVersion: 2022 as const,
      },
      linterOptions: { noInlineConfig: true },
      rules: { [`lore/${rule}`]: [SEVERITY[rule], ...options] },
    },
  ] as Linter.Config[];
}

function lint(rule: RuleName, source: string, options?: unknown[]): Linter.LintMessage[] {
  return new Linter({ configType: "flat" }).verify(source, configFor(rule, options), "main.ts");
}

/** Pesan tiap temuan sebagai `baris:kolom pesan` agar kegagalan tes mudah dibaca. */
function brief(messages: Linter.LintMessage[]): string[] {
  return messages.map((m) => `${m.line}:${m.column} ${m.message}`);
}

describe("plugin lore", () => {
  it("mengekspor objek plugin flat-config dengan tiga aturan", () => {
    expect(lore.meta.name).toBe("eslint-plugin-lore");
    expect(Object.keys(lore.rules).sort()).toEqual(["kit-style", "no-module-state", "uses-frame"]);
    for (const rule of Object.values(lore.rules)) {
      expect(typeof rule.create).toBe("function");
    }
  });
});

describe("lore/no-module-state", () => {
  const rule: RuleName = "no-module-state";

  it("menerima keadaan lokal, konstanta yang hanya dibaca, dan salinan sebelum mengurutkan", () => {
    const source = `
      const ITEMS = [3, 1, 2];
      const STYLE = { a: 1 };
      export default function Main() {
        let total = 0;
        const local: number[] = [];
        local.push(1);
        local.sort();
        total += 1;
        total++;
        const view = { ...STYLE };
        view.a = 2;
        return [...ITEMS].sort().concat(ITEMS.slice().reverse(), ITEMS.map((n) => n + total));
      }
    `;
    expect(brief(lint(rule, source))).toEqual([]);
  });

  it("menerima parameter yang menimpa nama level modul dan metode non-mutator", () => {
    const source = `
      const items: number[] = [];
      const lookup = new Map<string, number>();
      function fill(items: number[]) { items.push(1); items.length = 0; }
      export default function Main() { return [items.includes(1), lookup.get("a"), lookup.has("b")]; }
    `;
    expect(brief(lint(rule, source))).toEqual([]);
  });

  it.each(["let", "var"])("melaporkan `%s` di level modul pada baris dan kolom nama", (kind) => {
    const messages = lint(rule, `\n${kind} counter = 0;\n`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      ruleId: "lore/no-module-state",
      severity: 2,
      line: 2,
      column: kind.length + 2,
      message: "module-level state is not allowed: counter",
    });
  });

  it("melaporkan `let` yang diekspor dan `var` yang terangkat dari blok level atas", () => {
    expect(brief(lint(rule, "export let a = 1;"))).toEqual([
      "1:12 module-level state is not allowed: a",
    ]);
    expect(brief(lint(rule, "if (true) {\n  var b = 1;\n}\n"))).toEqual([
      "2:7 module-level state is not allowed: b",
    ]);
  });

  it("tidak melaporkan `let` yang lokal di fungsi atau penghitung loop level atas", () => {
    expect(brief(lint(rule, "export default function Main() { let a = 1; var b = 2; return a + b; }"))).toEqual([]);
    expect(brief(lint(rule, "const XS = [1, 2, 3];\nconst SUM = XS.reduce((a, b) => a + b, 0);\nfor (const x of XS) { void x; }\nfor (let i = 0; i < 3; i++) { void i; }\n"))).toEqual([]);
  });

  it.each([
    ["penugasan", "state.a = 1;", 3],
    ["penugasan properti bersarang", "state.a.b = 1;", 3],
    ["penugasan lewat indeks", 'state["a"] = 1;', 3],
    ["operator majemuk", "state.n += 1;", 3],
    ["kenaikan sufiks", "state.n++;", 3],
    ["penurunan awalan", "--state.n;", 5],
    ["penugasan destructuring array", "[state.n] = [1];", 4],
    ["penugasan destructuring objek", "({ k: state.n } = { k: 1 });", 9],
    ["kepala for-of", "for (state.n of [1]) { void state; }", 8],
    ["pembungkus non-null", "state!.n = 1;", 3],
    ["pembungkus as", "(state as { n: number }).n = 1;", 4],
  ])("melaporkan %s pada binding level modul di dalam fungsi", (_label, statement, column) => {
    const source = `const state = { n: 0, a: { b: 0 } };\nexport default function Main() {\n  ${statement}\n  return null;\n}\n`;
    expect(brief(lint(rule, source))).toEqual([`3:${column} module-level state is not allowed: state`]);
  });

  it.each(["push", "pop", "splice", "sort", "reverse", "set", "add", "delete", "clear"])(
    "melaporkan pemanggilan mutator %s pada binding level modul",
    (method) => {
      const source = `const store: any = {};\nexport default function Main() {\n  store.${method}(1);\n  return null;\n}\n`;
      expect(brief(lint(rule, source))).toEqual(["3:3 module-level state is not allowed: store"]);
    },
  );

  it("melaporkan mutator pada properti bersarang, bentuk indeks, rantai opsional, dan pembungkus TS", () => {
    const source = [
      "const store: any = { list: [] as number[] };",
      "export default function Main() {",
      "  store.list.push(1);",
      '  store["list"]["push"](1);',
      "  store?.list.pop();",
      "  (store as any).list.sort();",
      "  return null;",
      "}",
    ].join("\n");
    expect(lint(rule, source).map((m) => m.line)).toEqual([3, 4, 5, 6]);
  });

  it("tidak melaporkan mutator pada nilai lokal, hasil panggilan, atau nama non-mutator", () => {
    const source = `
      const SRC = [3, 1, 2];
      export default function Main() {
        const copy = SRC.slice();
        copy.sort();
        SRC.slice().reverse();
        [...SRC].sort();
        SRC.map((n) => n).push(1);
        SRC.concat([4]).length;
        return SRC.indexOf(1);
      }
    `;
    expect(brief(lint(rule, source))).toEqual([]);
  });

  it("melaporkan setiap binding yang ditugasi, satu temuan per akar", () => {
    const source = "const a = { n: 0 };\nconst b = { n: 0 };\nfunction f() { a.n = 1; b.n = 2; }\n";
    expect(brief(lint(rule, source))).toEqual([
      "3:16 module-level state is not allowed: a",
      "3:25 module-level state is not allowed: b",
    ]);
  });
});

describe("lore/uses-frame", () => {
  const rule: RuleName = "uses-frame";
  const MESSAGE = "Main must call useCurrentFrame() imported from remotion at least once";

  it("menerima pemanggilan useCurrentFrame yang diimpor dari remotion", () => {
    const source = `
      import { createElement } from "react";
      import { useCurrentFrame } from "remotion";
      export default function Main() { const frame = useCurrentFrame(); return createElement("div", null, frame); }
    `;
    expect(brief(lint(rule, source))).toEqual([]);
  });

  it("menerima impor beralias dan pemanggilan di dalam fungsi pembantu", () => {
    const source = `
      import { useCurrentFrame as currentFrame } from "remotion";
      function Helper() { return currentFrame(); }
      export default function Main() { return Helper(); }
    `;
    expect(brief(lint(rule, source))).toEqual([]);
  });

  it("menerima nama impor berupa string literal", () => {
    const source = `
      import { "useCurrentFrame" as frameOf } from "remotion";
      export default function Main() { return frameOf(); }
    `;
    expect(brief(lint(rule, source))).toEqual([]);
  });

  it("melaporkan di baris 1 kolom 1 bila tidak ada impor sama sekali", () => {
    const messages = lint(rule, '\n\nexport const meta = { durationInFrames: 30 };\nexport default function Main() { return null; }\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      ruleId: "lore/uses-frame",
      severity: 2,
      line: 1,
      column: 1,
      message: MESSAGE,
    });
  });

  it.each([
    ["berkas kosong", ""],
    ["hanya komentar", "// nothing here\n"],
    ["diimpor tetapi tidak dipanggil", 'import { useCurrentFrame } from "remotion";\nexport default function Main() { return null; }\n'],
    ["hanya dirujuk, tidak dipanggil", 'import { useCurrentFrame } from "remotion";\nconst hook = useCurrentFrame;\nexport default function Main() { return hook; }\n'],
    ["fungsi lokal bernama sama", 'import { interpolate } from "remotion";\nfunction useCurrentFrame() { return 0; }\nexport default function Main() { return interpolate(useCurrentFrame(), [0, 1], [0, 1]); }\n'],
    ["diimpor dari modul lain", 'import { useCurrentFrame } from "./frame";\nexport default function Main() { return useCurrentFrame(); }\n'],
    ["parameter menimpa nama impor", 'import { useCurrentFrame } from "remotion";\nexport default function Main() { return ((useCurrentFrame: () => number) => useCurrentFrame())(() => 1); }\n'],
  ])("melaporkan di baris 1 untuk %s", (_label, source) => {
    expect(brief(lint(rule, source))).toEqual([`1:1 ${MESSAGE}`]);
  });
});

describe("lore/kit-style", () => {
  const rule: RuleName = "kit-style";
  const warnings = contract.kit_style_warnings;
  const [fontDisplay, fontMono] = contract.font_variables;

  /** Gaya satu properti dalam objek `style`, seperti pada Main_File sungguhan. */
  const styled = (property: string, valueSource: string) =>
    `void ({ style: { ${property}: ${valueSource} } });`;

  it("menerima gaya yang sesuai Kit", () => {
    const source = [
      styled(warnings.border_radius_property, "0"),
      styled(warnings.border_radius_property, '"0"'),
      styled(warnings.border_radius_property, '"0px"'),
      ...warnings.shadow_properties.map((property) => styled(property, '"none"')),
      styled(warnings.font_family_property, `"var(${fontDisplay})"`),
      styled(warnings.font_family_property, `"var(${fontMono})"`),
      'const LABEL = "plain text and the number 42";',
      "const NOTE = `template ${1 + 1} without special characters`;",
      "const OTHER = { padding: 8, color: 'var(--color-cream)', fontSize: 26 };",
    ].join("\n");
    expect(brief(lint(rule, source))).toEqual([]);
  });

  it.each(["8", '"4px"', '"50%"', '"0 0 4px 0"', "radius"])(
    "memberi peringatan untuk borderRadius %s",
    (value) => {
      const messages = lint(rule, `declare const radius: number;\n${styled(warnings.border_radius_property, value)}`);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        ruleId: "lore/kit-style",
        severity: 1,
        line: 2,
        message: `${warnings.border_radius_property} must be 0 in the Kit style`,
      });
    },
  );

  it.each(contract.kit_style_warnings.shadow_properties)(
    "memberi peringatan untuk %s selain none",
    (property) => {
      for (const value of ['"0 0 8px black"', '"NONE inset"', "0"]) {
        const messages = lint(rule, styled(property, value));
        expect(messages.map((m) => m.message)).toEqual([`${property} must be "none" in the Kit style`]);
      }
    },
  );

  it.each(contract.kit_style_warnings.gradient_functions)("memberi peringatan untuk fungsi gradient %s", (fn) => {
    const messages = lint(rule, styled("backgroundImage", `"${fn}0deg, red, blue)"`));
    expect(messages.map((m) => m.message)).toEqual([`gradients are not allowed in the Kit style: ${fn}`]);
  });

  it.each(contract.kit_style_warnings.filter_functions)("memberi peringatan untuk filter %s", (fn) => {
    const messages = lint(rule, styled("filter", `\`${fn}4px)\``));
    expect(messages.map((m) => m.message)).toEqual([`${fn} is not allowed in the Kit style`]);
  });

  it("memberi peringatan untuk kunci backdropFilter apa pun nilainya", () => {
    const messages = lint(rule, styled(warnings.backdrop_property, '"none"'));
    expect(messages.map((m) => m.message)).toEqual([`${warnings.backdrop_property} is not allowed in the Kit style`]);
  });

  it.each(['"Arial"', '"monospace"', '"var(--font-body)"', '"var(--font-mono), monospace"', "family"])(
    "memberi peringatan untuk fontFamily %s",
    (value) => {
      const messages = lint(rule, `declare const family: string;\n${styled(warnings.font_family_property, value)}`);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.message).toBe(
        `${warnings.font_family_property} must be one of var(${fontDisplay}), var(${fontMono}) in the Kit style`,
      );
    },
  );

  it("memberi peringatan untuk emoji di string dan template, bukan untuk teks biasa", () => {
    const messages = lint(rule, 'const A = "pumpkin \u{1F383}";\nconst B = `ghost \u{1F47B}`;\nconst C = "pumpkin";\n');
    expect(messages.map((m) => [m.line, m.message])).toEqual([
      [1, "emoji are not allowed in the Kit style"],
      [2, "emoji are not allowed in the Kit style"],
    ]);
  });

  it("selalu berseverity warning (1) sehingga tidak mengubah ok", () => {
    const messages = lint(rule, styled(warnings.border_radius_property, "8") + '\nconst E = "\u{1F383}";');
    expect(messages.length).toBeGreaterThan(1);
    expect(new Set(messages.map((m) => m.severity))).toEqual(new Set([1]));
  });

  it("menolak konfigurasi tanpa opsi, bukan mati diam-diam", () => {
    expect(() => lint(rule, 'const A = "\u{1F383}";', [])).toThrow();
  });

  it("melempar saat aturan dibuat bila pola emoji bukan regex sah", () => {
    const broken: KitStyleOptions = {
      ...KIT_OPTIONS,
      kit_style_warnings: { ...KIT_OPTIONS.kit_style_warnings, emoji_pattern: "(" },
    };
    expect(() => lint(rule, "const A = 1;", [broken])).toThrow(/emoji_pattern/);
  });
});

describe("korpus fixtures/good", () => {
  const files = readdirSync(GOOD_DIR).filter((name) => name.endsWith(".ts")).sort();

  it("memuat berkas contoh", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s bebas dari temuan tiga aturan lore", (name) => {
    const source = readFileSync(new URL(name, GOOD_DIR), "utf8");
    for (const rule of ["no-module-state", "uses-frame", "kit-style"] as const) {
      expect(brief(lint(rule, source)), `${name} / lore/${rule}`).toEqual([]);
    }
  });
});
