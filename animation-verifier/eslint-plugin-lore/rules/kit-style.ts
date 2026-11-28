// Aturan `lore/kit-style` (design 5.6; Requirement 1.8, 1.13, 8.11): peringatan, bukan galat,
// untuk gaya yang menyimpang dari Kit. Dipasang sebagai `warn`, jadi tidak mengubah `ok`.
//   - `borderRadius` selain `0`, `"0"`, `"0px"`;
//   - `boxShadow` dan `textShadow` selain `"none"`;
//   - `backdropFilter` (kunci apa pun nilainya);
//   - `fontFamily` selain `var(<font>)` untuk tiap nama di `font_variables`;
//   - string yang memuat fungsi gradient, filter `blur(` atau `drop-shadow(`, atau emoji.
// Nilai properti yang tidak dapat dibaca secara statis (identifier, ekspresi) dianggap menyimpang,
// karena kepatuhannya tidak terbukti. Daftar nama properti dan fungsi tidak ditulis di sini:
// kontrak diteruskan lewat opsi aturan (`kit_style_warnings` dan `font_variables` dari
// `animation-contract.json`), sehingga plugin tidak mengimpor berkas di luar direktorinya dan
// Requirement 2.6 (tanpa duplikasi nilai kontrak) tetap berlaku. Nilai yang diizinkan (`0`,
// `"0px"`, `"none"`) berasal dari teks requirement dan tidak ada di kontrak.
// Opsi wajib: tanpa opsi, ESLint menolak konfigurasi, supaya aturan tidak mati diam-diam. Pola
// emoji yang bukan regex sah melempar saat aturan dibuat; ESLint tidak punya jalur galat konfigurasi
// lain, dan langkah lint memetakan exception itu ke `VERIFIER_INTERNAL`.

import type { Rule, SourceCode } from "eslint";

type EsNode = Parameters<SourceCode["getScope"]>[0];
type NodeOf<T extends EsNode["type"]> = Extract<EsNode, { type: T }>;

/** Potongan kontrak yang dibaca aturan; bentuknya sama dengan bidang kontrak bernama sama. */
export interface KitStyleOptions {
  kit_style_warnings: {
    border_radius_property: string;
    shadow_properties: string[];
    gradient_functions: string[];
    filter_functions: string[];
    backdrop_property: string;
    emoji_pattern: string;
    font_family_property: string;
  };
  font_variables: string[];
}

interface CompiledOptions {
  borderRadiusProperty: string;
  shadowProperties: ReadonlySet<string>;
  gradientFunctions: readonly string[];
  filterFunctions: readonly string[];
  backdropProperty: string;
  fontFamilyProperty: string;
  /** Nilai `fontFamily` yang diizinkan, mis. `var(--font-mono)`. */
  allowedFonts: ReadonlySet<string>;
  emoji: RegExp;
}

type CompileResult = { ok: true; options: CompiledOptions } | { ok: false; reason: string };

/** Nilai `borderRadius` yang diizinkan setelah `trim` dan huruf kecil; angka 0 menjadi `"0"`. */
const ALLOWED_RADIUS: ReadonlySet<string> = new Set(["0", "0px"]);

/** Satu-satunya nilai bayangan yang diizinkan, setelah `trim` dan huruf kecil. */
const NO_SHADOW = "none";

function compileOptions(raw: KitStyleOptions | undefined): CompileResult {
  if (raw === undefined) return { ok: false, reason: "options are required" };
  const warnings = raw.kit_style_warnings;
  let emoji: RegExp;
  try {
    emoji = new RegExp(warnings.emoji_pattern, "u");
  } catch {
    return { ok: false, reason: "kit_style_warnings.emoji_pattern is not a valid regular expression" };
  }
  return {
    ok: true,
    options: {
      borderRadiusProperty: warnings.border_radius_property,
      shadowProperties: new Set(warnings.shadow_properties),
      gradientFunctions: warnings.gradient_functions.map((name) => name.toLowerCase()),
      filterFunctions: warnings.filter_functions.map((name) => name.toLowerCase()),
      backdropProperty: warnings.backdrop_property,
      fontFamilyProperty: warnings.font_family_property,
      allowedFonts: new Set(raw.font_variables.map((name) => `var(${name})`)),
      emoji,
    },
  };
}

/** Nama kunci statis: `{ a: 1 }`, `{ "a": 1 }`, `{ ["a"]: 1 }`; null untuk kunci dinamis. */
function propertyName(property: NodeOf<"Property">): string | null {
  const { key } = property;
  if (!property.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")) {
    return String(key.value);
  }
  return null;
}

/** Teks CSS dari literal string, angka, atau template tanpa ekspresi; null bila tidak statis. */
function staticCssText(node: EsNode): string | null {
  if (node.type === "Literal") {
    if (typeof node.value === "string") return node.value.trim();
    if (typeof node.value === "number") return String(node.value);
    return null;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked?.trim() ?? null;
  }
  return null;
}

/**
 * Nama terpanjang di `names` yang muncul di `text`, supaya `repeating-linear-gradient(` tidak
 * dilaporkan sebagai `linear-gradient(`; satu string menghasilkan paling banyak satu temuan per jenis.
 */
function longestMatch(names: readonly string[], text: string): string | undefined {
  let best: string | undefined;
  for (const name of names) {
    if (text.includes(name) && (best === undefined || name.length > best.length)) best = name;
  }
  return best;
}

export const kitStyle: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Warn about styles that deviate from the LORE Kit.",
    },
    schema: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: [
        {
          type: "object",
          properties: {
            kit_style_warnings: {
              type: "object",
              properties: {
                border_radius_property: { type: "string" },
                shadow_properties: { type: "array", items: { type: "string" } },
                gradient_functions: { type: "array", items: { type: "string" } },
                filter_functions: { type: "array", items: { type: "string" } },
                backdrop_property: { type: "string" },
                emoji_pattern: { type: "string" },
                font_family_property: { type: "string" },
              },
              required: [
                "border_radius_property",
                "shadow_properties",
                "gradient_functions",
                "filter_functions",
                "backdrop_property",
                "emoji_pattern",
                "font_family_property",
              ],
            },
            font_variables: { type: "array", items: { type: "string" } },
          },
          required: ["kit_style_warnings", "font_variables"],
        },
      ],
    },
    messages: {
      borderRadius: "{{property}} must be 0 in the Kit style",
      shadow: '{{property}} must be "none" in the Kit style',
      backdrop: "{{property}} is not allowed in the Kit style",
      fontFamily: "{{property}} must be one of {{allowed}} in the Kit style",
      gradient: "gradients are not allowed in the Kit style: {{name}}",
      filter: "{{name}} is not allowed in the Kit style",
      emoji: "emoji are not allowed in the Kit style",
    },
  },
  create(context) {
    const compiled = compileOptions(context.options[0] as KitStyleOptions | undefined);
    if (!compiled.ok) throw new Error(`lore/kit-style: ${compiled.reason}`);
    const kit = compiled.options;
    const allowedFontList = [...kit.allowedFonts].join(", ");

    const checkText = (node: EsNode, text: string): void => {
      const lower = text.toLowerCase();
      const gradient = longestMatch(kit.gradientFunctions, lower);
      if (gradient !== undefined) {
        context.report({ node, messageId: "gradient", data: { name: gradient } });
      }
      const filter = longestMatch(kit.filterFunctions, lower);
      if (filter !== undefined) {
        context.report({ node, messageId: "filter", data: { name: filter } });
      }
      if (kit.emoji.test(text)) context.report({ node, messageId: "emoji" });
    };

    return {
      Property(node) {
        if (node.parent.type !== "ObjectExpression") return;
        const name = propertyName(node);
        if (name === null) return;
        const value = staticCssText(node.value);
        if (name === kit.borderRadiusProperty) {
          if (value === null || !ALLOWED_RADIUS.has(value.toLowerCase())) {
            context.report({ node, messageId: "borderRadius", data: { property: name } });
          }
        } else if (kit.shadowProperties.has(name)) {
          if (value === null || value.toLowerCase() !== NO_SHADOW) {
            context.report({ node, messageId: "shadow", data: { property: name } });
          }
        } else if (name === kit.backdropProperty) {
          context.report({ node, messageId: "backdrop", data: { property: name } });
        } else if (name === kit.fontFamilyProperty) {
          if (value === null || !kit.allowedFonts.has(value)) {
            context.report({
              node,
              messageId: "fontFamily",
              data: { property: name, allowed: allowedFontList },
            });
          }
        }
      },
      Literal(node) {
        if (typeof node.value === "string") checkText(node, node.value);
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
