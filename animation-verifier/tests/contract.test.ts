// Tes pembaca kontrak verifier (tugas 1.2): kontrak sumber diterima, setiap pelanggaran
// pemeriksaan minimum bagian 4.3 ditolak dengan `reason`, nilai kunci kontrak sesuai
// Requirement 2.12, dan regex kode Diagnostic hasil bangunan cocok dengan tabel 5.12 (2.13).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDiagnosticCodeRegex, loadContract } from "../src/contract.js";

type Json = Record<string, unknown>;

const SOURCE_PATH = new URL("../contract/animation-contract.json", import.meta.url);

function readSource(): Json {
  return JSON.parse(readFileSync(SOURCE_PATH, "utf8")) as Json;
}

/** Salinan dalam kontrak sumber yang boleh dimutasi sesuka tes. */
function fresh(): Json {
  return structuredClone(readSource());
}

/** Menerapkan `edit` pada salinan baru dan memuatnya. */
function loadEdited(edit: (contract: Json) => void) {
  const contract = fresh();
  edit(contract);
  return loadContract(contract);
}

function expectRejected(result: ReturnType<typeof loadContract>, pathFragment: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(typeof result.reason).toBe("string");
  expect(result.reason.length).toBeGreaterThan(0);
  expect(result.reason).toContain(pathFragment);
}

/** Regex literal pada Requirement 6 kriteria 8 (2.13): ditulis ulang di tes, bukan dari kontrak. */
const REQUIREMENT_CODE_REGEX = /^(SIZE|ENCODING|POLICY|META|ESLINT|TSC|BUNDLE|RENDER|FIDELITY|VERIFIER)_[A-Z0-9_]+$/;

/** Kode tetap pada tabel 5.12 yang cocok dengan regex verifier (termasuk `VERIFIER_CRASH` milik agent). */
const TABLE_5_12_VERIFIER_CODES = [
  "SIZE_SOURCE_TOO_LARGE",
  "ENCODING_INVALID",
  "POLICY_JSX_SYNTAX",
  "POLICY_IMPORT_DISALLOWED",
  "POLICY_DYNAMIC_IMPORT",
  "POLICY_FORBIDDEN_IDENTIFIER",
  "POLICY_FORBIDDEN_MEMBER",
  "POLICY_FORBIDDEN_PROPERTY",
  "POLICY_DYNAMIC_ELEMENT",
  "POLICY_FORBIDDEN_ELEMENT",
  "POLICY_FORBIDDEN_ATTRIBUTE",
  "POLICY_URL_LITERAL",
  "POLICY_COLOR_LITERAL",
  "POLICY_META_INVALID",
  "META_PAUSE_REQUIRED",
  "META_PAUSE_FORBIDDEN",
  "POLICY_EXPORT_MISSING",
  "POLICY_EXPORT_UNEXPECTED",
  "ESLINT_LORE_NO_MODULE_STATE",
  "ESLINT_LORE_USES_FRAME",
  "ESLINT_LORE_KIT_STYLE",
  "ESLINT_INLINE_DIRECTIVE",
  "ESLINT_PARSE_ERROR",
  // `ESLINT_<RULE>` dan `TSC_<n>` adalah keluarga kode: satu contoh nyata cukup.
  "ESLINT_NO_UNUSED_VARS",
  "TSC_2304",
  "TSC_SUPPRESSION_DIRECTIVE",
  "BUNDLE_TOO_LARGE",
  "BUNDLE_UNEXPECTED_REQUIRE",
  "BUNDLE_FAILED",
  "RENDER_EXCEPTION",
  "RENDER_CONSOLE_ERROR",
  "RENDER_CONSOLE_WARN",
  "RENDER_DOM_LIMIT",
  "RENDER_EMPTY",
  "RENDER_META_MISMATCH",
  "RENDER_NONDETERMINISTIC",
  "RENDER_FRAME_TIMEOUT",
  "RENDER_RESOURCE_LIMIT",
  "FIDELITY_TOKEN_MISSING",
  "FIDELITY_FORBIDDEN_TOKEN_VISIBLE",
  "FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED",
  "VERIFIER_BAD_INPUT",
  "VERIFIER_CONTRACT_MISMATCH",
  "VERIFIER_INTERNAL",
  "VERIFIER_DEADLINE",
  "VERIFIER_CRASH",
] as const;

/** Kode buatan agent (`tool: agent`): bukan bentuk kode verifier. */
const TABLE_5_12_AGENT_CODES = ["AGENT_EXTRACT_NO_CODE", "AGENT_REPAIR_UNCHANGED"] as const;

const TOP_LEVEL_FIELDS = [
  "contract_version",
  "file_name",
  "canvas",
  "duration",
  "limits",
  "allowed_imports",
  "required_exports",
  "pause_rules",
  "forbidden",
  "url_schemes",
  "url_schemes_strict_colon",
  "css_functions_forbidden",
  "color_tokens",
  "color_keywords",
  "color_properties",
  "color_forms",
  "font_variables",
  "kit_style_warnings",
  "diagnostic_code_prefixes",
  "supported_runtime_contract_versions",
] as const;

describe("kontrak sumber", () => {
  it("memuat tepat 20 bidang tingkat atas", () => {
    expect(Object.keys(readSource()).sort()).toEqual([...TOP_LEVEL_FIELDS].sort());
  });

  it("diterima loadContract", () => {
    const result = loadContract(readSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.contract_version).toBe(1);
    expect(result.contract.supported_runtime_contract_versions).toEqual([1]);
  });

  it("file_name sama dengan main.ts", () => {
    expect(readSource().file_name).toBe("main.ts");
  });

  it("nilai kunci sesuai Requirement 2.12", () => {
    const result = loadContract(readSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { contract } = result;
    expect(contract.canvas).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(contract.duration).toEqual({ min: 30, max: 900 });
    expect(contract.limits.source_max_bytes).toBe(32768);
    expect(contract.limits.bundle_max_bytes).toBe(131072);
    expect(contract.limits.dom_max_elements).toBe(600);
    expect(contract.color_tokens).toHaveLength(9);
  });

  it("color_tokens adalah sembilan token palet Kit yang unik", () => {
    const tokens = readSource().color_tokens as string[];
    expect(new Set(tokens).size).toBe(9);
    expect([...tokens].sort()).toEqual(
      ["candle", "candle-ink", "cream", "ember", "gold", "ink", "ink-soft", "muted", "smoke"].sort(),
    );
  });

  it("named_colors berisi 148 nama unik tanpa transparent dan currentColor", () => {
    const forms = readSource().color_forms as { named_colors: string[] };
    const lowered = forms.named_colors.map((name) => name.toLowerCase());
    expect(forms.named_colors).toHaveLength(148);
    expect(new Set(lowered).size).toBe(148);
    expect(lowered).not.toContain("transparent");
    expect(lowered).not.toContain("currentcolor");
    expect(forms.named_colors.every((name) => /^[a-z]+$/.test(name))).toBe(true);
  });

  it("color_keywords memuat empat kata kunci", () => {
    const keywords = readSource().color_keywords as string[];
    expect(keywords).toHaveLength(4);
    expect([...keywords].sort()).toEqual(["currentColor", "inherit", "none", "transparent"]);
  });

  it("diagnostic_code_prefixes memuat sebelas awalan termasuk AGENT", () => {
    const prefixes = readSource().diagnostic_code_prefixes as string[];
    expect(prefixes).toHaveLength(11);
    expect(prefixes).toContain("AGENT");
  });

  it("pause_rules dan forbidden terbagi per kategori (Requirement 2.16)", () => {
    const contract = readSource();
    expect(contract.pause_rules).toEqual({ lesson: "forbidden", puzzle: "required" });
    expect(Object.keys(contract.forbidden as Json).sort()).toEqual(
      ["attribute", "element", "identifier", "member", "property"].sort(),
    );
  });
});

describe("loadContract: masukan bukan object", () => {
  // Tiap kasus dibungkus array supaya `[]` dan `[1, 2, 3]` dikirim sebagai satu argumen.
  it.each([[null], [undefined], [0], [42], ["contract"], [true], [[]], [[1, 2, 3]]])(
    "menolak %j",
    (raw) => {
      expectRejected(loadContract(raw), "(root)");
    },
  );

  it("menolak object kosong dengan satu alasan per bidang yang hilang", () => {
    const result = loadContract({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("contract_version");
  });

  it("tidak melempar untuk object dengan getter yang melempar", () => {
    const hostile = fresh();
    Object.defineProperty(hostile, "canvas", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const result = loadContract(hostile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("loadContract: bidang hilang", () => {
  it.each(TOP_LEVEL_FIELDS)("menolak kontrak tanpa %s", (field) => {
    expectRejected(
      loadEdited((contract) => {
        delete contract[field];
      }),
      field,
    );
  });
});

describe("loadContract: tipe dan batas minimum", () => {
  it.each([0, -1, 1.5, "1", null, Number.NaN])("contract_version %j ditolak", (value) => {
    expectRejected(
      loadEdited((contract) => {
        contract.contract_version = value;
      }),
      "contract_version",
    );
  });

  it("contract_version 2 diterima bila didukung runtime", () => {
    const result = loadEdited((contract) => {
      contract.contract_version = 2;
      contract.supported_runtime_contract_versions = [1, 2];
    });
    expect(result.ok).toBe(true);
  });

  it.each([[[]], [[2]], [[1.5]], ["1"], [null]])(
    "supported_runtime_contract_versions %j ditolak",
    (value) => {
      expectRejected(
        loadEdited((contract) => {
          contract.supported_runtime_contract_versions = value;
        }),
        "supported_runtime_contract_versions",
      );
    },
  );

  it("supported_runtime_contract_versions harus memuat contract_version", () => {
    const result = loadEdited((contract) => {
      contract.contract_version = 3;
      contract.supported_runtime_contract_versions = [1, 2];
    });
    expectRejected(result, "supported_runtime_contract_versions");
    if (!result.ok) expect(result.reason).toContain("contract_version");
  });

  describe.each(["width", "height", "fps"] as const)("canvas.%s", (key) => {
    it.each([0, -1, 1.5, "1280", null])("menolak %j", (value) => {
      expectRejected(
        loadEdited((contract) => {
          (contract.canvas as Json)[key] = value;
        }),
        `canvas.${key}`,
      );
    });

    it("menolak bila hilang", () => {
      expectRejected(
        loadEdited((contract) => {
          delete (contract.canvas as Json)[key];
        }),
        `canvas.${key}`,
      );
    });
  });

  describe.each(["min", "max"] as const)("duration.%s", (key) => {
    it.each([0, -5, 2.5, "30", null])("menolak %j", (value) => {
      expectRejected(
        loadEdited((contract) => {
          (contract.duration as Json)[key] = value;
        }),
        `duration.${key}`,
      );
    });
  });

  it("menolak duration.min lebih besar dari duration.max", () => {
    expectRejected(
      loadEdited((contract) => {
        contract.duration = { min: 901, max: 900 };
      }),
      "duration",
    );
  });

  it("menerima duration.min sama dengan duration.max dan sama dengan 1", () => {
    expect(
      loadEdited((contract) => {
        contract.duration = { min: 1, max: 1 };
      }).ok,
    ).toBe(true);
  });

  it("menolak duration dengan max di bawah 1 walau min valid", () => {
    expectRejected(
      loadEdited((contract) => {
        contract.duration = { min: 1, max: 0 };
      }),
      "duration.max",
    );
  });

  describe.each(Object.keys(readSource().limits as Json))("limits.%s", (key) => {
    it.each([0, -1, 1.5, "100", null])("menolak %j", (value) => {
      expectRejected(
        loadEdited((contract) => {
          (contract.limits as Json)[key] = value;
        }),
        `limits.${key}`,
      );
    });

    it("menolak bila hilang", () => {
      expectRejected(
        loadEdited((contract) => {
          delete (contract.limits as Json)[key];
        }),
        `limits.${key}`,
      );
    });
  });

  it.each([0, 8, 10, 12])("color_tokens dengan %i elemen ditolak (harus tepat 9)", (count) => {
    expectRejected(
      loadEdited((contract) => {
        contract.color_tokens = Array.from({ length: count }, (_, index) => `token-${index}`);
      }),
      "color_tokens",
    );
  });

  it.each([0, 10, 12])("diagnostic_code_prefixes dengan %i elemen ditolak (harus tepat 11)", (count) => {
    expectRejected(
      loadEdited((contract) => {
        contract.diagnostic_code_prefixes = Array.from({ length: count }, (_, index) =>
          index === 0 ? "AGENT" : `P${index}`,
        );
      }),
      "diagnostic_code_prefixes",
    );
  });

  it("diagnostic_code_prefixes tanpa AGENT ditolak walau berjumlah 11", () => {
    const result = loadEdited((contract) => {
      contract.diagnostic_code_prefixes = (contract.diagnostic_code_prefixes as string[]).map(
        (prefix) => (prefix === "AGENT" ? "OTHER" : prefix),
      );
    });
    expectRejected(result, "diagnostic_code_prefixes");
    if (!result.ok) expect(result.reason).toContain("AGENT");
  });

  const wrongTypes: [field: string, value: unknown][] = [
    ["file_name", 1],
    ["file_name", ""],
    ["allowed_imports", []],
    ["allowed_imports", { react: { values: "createElement", types: [] } }],
    ["required_exports", { meta: { keys: [] } }],
    ["pause_rules", { lesson: "forbidden", puzzle: "maybe" }],
    ["forbidden", { identifier: "eval" }],
    ["url_schemes", "http"],
    ["color_forms", { hex_pattern: 1, functions: [], named_colors: [] }],
    ["kit_style_warnings", "warn"],
    ["font_variables", [1, 2]],
  ];

  it.each(wrongTypes)("tipe salah pada %s (%j) ditolak", (field, value) => {
    expectRejected(
      loadEdited((contract) => {
        contract[field] = value;
      }),
      field,
    );
  });

  it("membuang bidang tambahan tanpa menolak kontrak", () => {
    const result = loadEdited((contract) => {
      contract.future_field = { anything: true };
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("future_field" in result.contract).toBe(false);
  });

  it("reason memuat paling banyak lima temuan dan menyebut sisanya", () => {
    const result = loadContract({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.split("; ")).toHaveLength(6);
    expect(result.reason).toMatch(/\+15 more$/);
  });
});

describe("loadContract: turunan set cepat", () => {
  it("forbiddenIdentifiers memuat semua identifier terlarang apa adanya", () => {
    const result = loadContract(readSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const identifiers = (readSource().forbidden as { identifier: string[] }).identifier;
    expect(result.contract.forbiddenIdentifiers.size).toBe(identifiers.length);
    for (const name of identifiers) expect(result.contract.forbiddenIdentifiers.has(name)).toBe(true);
    expect(result.contract.forbiddenIdentifiers.has("eval")).toBe(true);
    expect(result.contract.forbiddenIdentifiers.has("EVAL")).toBe(false);
    expect(result.contract.forbiddenIdentifiers.has("createElement")).toBe(false);
  });

  it("namedColors berisi 148 nama huruf kecil", () => {
    const result = loadContract(readSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.namedColors.size).toBe(148);
    expect(result.contract.namedColors.has("rebeccapurple")).toBe(true);
    expect(result.contract.namedColors.has("transparent")).toBe(false);
    expect(result.contract.namedColors.has("currentcolor")).toBe(false);
  });

  it("namedColors menurunkan huruf kecil dari nama bercampur huruf", () => {
    const result = loadEdited((contract) => {
      (contract.color_forms as { named_colors: string[] }).named_colors = ["AliceBlue", "RED"];
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.contract.namedColors].sort()).toEqual(["aliceblue", "red"]);
  });
});

describe("regex kode Diagnostic", () => {
  const loaded = loadContract(readSource());
  const regex = loaded.ok ? loaded.contract.diagnosticCodeRegex : /(?!)/;

  it("kontrak sumber termuat", () => {
    expect(loaded.ok).toBe(true);
  });

  it("sama dengan pola literal pada Requirement 6 kriteria 8", () => {
    expect(regex.source).toBe(REQUIREMENT_CODE_REGEX.source);
    expect(regex.flags).toBe(REQUIREMENT_CODE_REGEX.flags);
  });

  it("tidak memuat awalan AGENT", () => {
    expect(regex.source).not.toContain("AGENT");
  });

  it.each(TABLE_5_12_VERIFIER_CODES)("cocok dengan kode verifier %s", (code) => {
    expect(regex.test(code)).toBe(true);
    expect(REQUIREMENT_CODE_REGEX.test(code)).toBe(true);
  });

  it.each(TABLE_5_12_AGENT_CODES)("menolak kode agent %s", (code) => {
    expect(regex.test(code)).toBe(false);
  });

  it.each([
    "",
    "SIZE",
    "SIZE_",
    "FOO_BAR",
    "AGENT_X",
    "XSIZE_TOO_LARGE",
    "SIZEX_TOO_LARGE",
    "SIZE-TOO_LARGE",
    "size_source_too_large",
    "SIZE_source",
    "SIZE_TOO LARGE",
    " SIZE_TOO_LARGE",
    "SIZE_TOO_LARGE ",
    "SIZE_TOO_LARGE\n",
    "POLICY",
  ])("menolak kode berawalan lain atau bentuk salah %j", (code) => {
    expect(regex.test(code)).toBe(false);
  });

  it("setiap awalan kode pada tabel 5.12 ada di kontrak, dan setiap awalan verifier terpakai", () => {
    const prefixes = (readSource().diagnostic_code_prefixes as string[]).filter((p) => p !== "AGENT");
    const used = new Set(TABLE_5_12_VERIFIER_CODES.map((code) => code.slice(0, code.indexOf("_"))));
    expect([...used].sort()).toEqual([...prefixes].sort());
  });

  it("awalan agent pada tabel 5.12 hanya AGENT", () => {
    const prefixes = readSource().diagnostic_code_prefixes as string[];
    for (const code of TABLE_5_12_AGENT_CODES) {
      expect(prefixes).toContain(code.slice(0, code.indexOf("_")));
    }
  });

  it("regex tidak menyimpan status antar-panggilan", () => {
    for (let i = 0; i < 3; i += 1) expect(regex.test("SIZE_SOURCE_TOO_LARGE")).toBe(true);
  });

  it("buildDiagnosticCodeRegex mengikuti daftar awalan dan melepas karakter khusus", () => {
    const built = buildDiagnosticCodeRegex(["AB", "C.D", "AGENT"]);
    expect(built.test("AB_X")).toBe(true);
    expect(built.test("C.D_X")).toBe(true);
    expect(built.test("CXD_X")).toBe(false);
    expect(built.test("AGENT_X")).toBe(false);
  });
});
