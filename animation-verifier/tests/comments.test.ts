// Tes pemindai komentar (`src/policy/comments.ts`, tugas 5.2; Requirement 8.10, design 5.5 butir (a)).
// Yang dijaga: komentar sungguhan ditemukan dengan isi dan posisi yang benar (basis 1, unit UTF-16,
// semua jenis pemisah baris), sedangkan teks yang hanya mirip komentar di dalam string, template,
// dan regex literal tidak dihitung. Konteks yang tidak bisa diputuskan scanner sendiri (penutup
// substitusi template, `/` sebagai pembagian atau awal regex) diuji dengan sumber yang sengaja
// menaruh komentar sesudahnya, sehingga salah baca terlihat sebagai komentar yang hilang atau berlebih.
// Bagian "bug 5.3" mereproduksi `a! / 2; // @ts-ignore` (heuristik "token sebelumnya" membaca `/`
// sebagai awal regex dan komentar terlewat) beserta kelas bug yang sama (`if (x) /"/.test(s)`,
// `await /"/`, `of /"/`, blok lalu regex), dan "pemindai tanpa parser" menguji jalur cadangan yang
// dipakai bila parser kehabisan stack pada sumber yang bersarang sangat dalam.
import { describe, expect, it } from "vitest";
import { scanComments } from "../src/policy/comments.js";

/** Isi komentar menurut urutan dokumen, supaya kegagalan tes mudah dibaca. */
function valuesOf(source: string): string[] {
  return scanComments(source).map((comment) => comment.value);
}

describe("scanComments: bentuk dan posisi", () => {
  it("mengembalikan larik kosong untuk sumber tanpa komentar atau kosong", () => {
    expect(scanComments("")).toEqual([]);
    expect(scanComments("const a = 1;\n")).toEqual([]);
  });

  it("membedakan komentar baris dan blok, dengan isi tanpa pembatas dan tanpa trim", () => {
    expect(scanComments("// satu\n/* dua */ /*tiga*/")).toEqual([
      { kind: "line", value: " satu", line: 1, column: 1 },
      { kind: "block", value: " dua ", line: 2, column: 1 },
      { kind: "block", value: "tiga", line: 2, column: 11 },
    ]);
  });

  it("menghitung baris dan kolom basis 1 untuk LF, CRLF, CR, dan pemisah baris Unicode", () => {
    for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      const comments = scanComments(`a${separator}  b ${separator}   // c`);
      expect(comments).toEqual([{ kind: "line", value: " c", line: 3, column: 4 }]);
    }
  });

  it("menghitung kolom dalam unit UTF-16 (emoji dua unit)", () => {
    const [comment] = scanComments('const s = "\u{1F600}"; // x');
    expect(comment).toMatchObject({ line: 1, column: 17 });
  });

  it("komentar blok multibaris dilaporkan di baris awalnya", () => {
    const [comment] = scanComments("x;\n\n  /* a\n b */ y;");
    expect(comment).toEqual({ kind: "block", value: " a\n b ", line: 3, column: 3 });
  });

  it("komentar blok tanpa penutup memakai sisa teks sebagai isinya, tanpa melempar", () => {
    expect(valuesOf("x; /* belum ditutup")).toEqual([" belum ditutup"]);
    expect(valuesOf("/*/")).toEqual(["/"]);
    expect(valuesOf("/**/")).toEqual([""]);
  });

  it("baris shebang bukan komentar", () => {
    expect(valuesOf("#!/usr/bin/env node\n// halo")).toEqual([" halo"]);
  });
});

describe("scanComments: teks yang mirip komentar", () => {
  it("tidak menghitung `//` dan `/*` di dalam string", () => {
    expect(valuesOf(`const a = "// bukan"; const b = '/* bukan */'; // asli`)).toEqual([" asli"]);
  });

  it("tidak menghitung komentar-mirip di dalam template, termasuk bagian sesudah substitusi", () => {
    expect(valuesOf("const a = `x // y ${1} /* z */ ${2} // w`; // asli")).toEqual([" asli"]);
  });

  it("menemukan komentar di dalam substitusi template", () => {
    expect(valuesOf("const a = `x ${ /* dalam */ 1 } y`; // luar")).toEqual([" dalam ", " luar"]);
  });

  it("menjaga kedalaman kurung kurawal di dalam substitusi (objek literal) dan template bersarang", () => {
    expect(valuesOf("const a = `p ${ { k: 1 }.k } q // r`; // asli")).toEqual([" asli"]);
    expect(valuesOf("const a = `a ${`b ${1} // c`} d // e`; // asli")).toEqual([" asli"]);
    expect(valuesOf("const a = `a${b}c` // x")).toEqual([" x"]);
    expect(valuesOf("const a = tag`a ${b} // c`; // d")).toEqual([" d"]);
  });

  it("tidak menghitung `//` di dalam regex literal, termasuk yang memuat kutip dan kelas karakter", () => {
    expect(valuesOf("const a = /\\/\\//; // asli")).toEqual([" asli"]);
    expect(valuesOf('const a = /"/; // asli')).toEqual([" asli"]);
    expect(valuesOf("const a = /'/; // asli")).toEqual([" asli"]);
    expect(valuesOf("const a = /[/]/; // asli")).toEqual([" asli"]);
    expect(valuesOf("const a = /a/g.test(b) && /\\/*/.test(c); // asli")).toEqual([" asli"]);
  });
});

describe("scanComments: `/` sebagai pembagian atau awal regex", () => {
  it("pembagian sesudah identifier, angka, tanda kurung, dan kurung siku", () => {
    expect(valuesOf("const a = b / 2; // 1")).toEqual([" 1"]);
    expect(valuesOf("const a = 4 / 2; // 2")).toEqual([" 2"]);
    expect(valuesOf("const a = (b + c) / 2; // 3")).toEqual([" 3"]);
    expect(valuesOf("const a = d[0] / 2; // 4")).toEqual([" 4"]);
    expect(valuesOf("const a = b / c / d; // 5")).toEqual([" 5"]);
    expect(valuesOf("let a = 8; a /= 2; // 6")).toEqual([" 6"]);
    expect(valuesOf("const a = this.x / 2; // 7")).toEqual([" 7"]);
    expect(valuesOf('const a = "s".length / 2; // 8')).toEqual([" 8"]);
    expect(valuesOf("const a = `t`.length / 2; // 9")).toEqual([" 9"]);
    expect(valuesOf("const a = `t${b}`.length / 2; // 10")).toEqual([" 10"]);
    expect(valuesOf("const a = i++ / 2; // 11")).toEqual([" 11"]);
  });

  it("pembagian sesudah nama yang kebetulan kata kunci kontekstual", () => {
    expect(valuesOf("const type = 4; const a = type / 2; /* a */ const of = 1; of / 2; // b")).toEqual([
      " a ",
      " b",
    ]);
  });

  it("regex sesudah operator, tanda kurung buka, koma, dan kata kunci", () => {
    expect(valuesOf('const a = x ? /"/ : /\'/; // 1')).toEqual([" 1"]);
    expect(valuesOf('const a = [/"/, /\'/]; // 2')).toEqual([" 2"]);
    expect(valuesOf('const a = f(/"/); // 3')).toEqual([" 3"]);
    expect(valuesOf('function f() { return /"/; } // 4')).toEqual([" 4"]);
    expect(valuesOf('const a = typeof /"/; // 5')).toEqual([" 5"]);
    expect(valuesOf('const a = !/"/.test(s); // 6')).toEqual([" 6"]);
    expect(valuesOf('const a = b && /"/.test(s); // 7')).toEqual([" 7"]);
    expect(valuesOf("const a = /=/.test(s); // 8")).toEqual([" 8"]);
  });

  it("tidak melempar untuk sumber rusak apa pun", () => {
    for (const source of ["`", "${", "}", "/", "/=", "`${", "`${}`", "'", '"', "/[", "}}`"]) {
      expect(() => scanComments(source)).not.toThrow();
    }
  });
});

/**
 * Pasangan [sumber, isi komentar yang diharapkan]. Setiap sumber valid secara sintaks, dan
 * komentar penutupnya (`@ts-ignore`, `@ts-nocheck`, `eslint-disable-line`) harus ditemukan.
 */
type Case = readonly [source: string, values: readonly string[]];

function expectCases(cases: readonly Case[]): void {
  for (const [source, values] of cases) {
    it(JSON.stringify(source), () => {
      expect(valuesOf(source)).toEqual(values);
    });
  }
}

describe("scanComments: bug 5.3, `/` sesudah `!` (non-null assertion) adalah pembagian", () => {
  expectCases([
    ["a! / 2; // @ts-ignore", [" @ts-ignore"]],
    ["a!/2; // @ts-ignore", [" @ts-ignore"]],
    ["x! /y/ 2 // @ts-ignore", [" @ts-ignore"]],
    ['x! / "/" / 2; // @ts-ignore', [" @ts-ignore"]],
    ["(a!) / 2 // @ts-ignore", [" @ts-ignore"]],
    ["a!! / 2 // @ts-nocheck", [" @ts-nocheck"]],
    ["a! /= 2; // @ts-ignore", [" @ts-ignore"]],
    ["a!\n/ 2; // @ts-ignore", [" @ts-ignore"]],
    ["a!.b! / 2; // @ts-ignore", [" @ts-ignore"]],
    ["f()! / 2; // @ts-ignore", [" @ts-ignore"]],
    ["f<T>(x)! / 2; // @ts-ignore", [" @ts-ignore"]],
    ["a![0]! / 2; // @ts-ignore", [" @ts-ignore"]],
    ['a! / 2 + /"/.source.length; // @ts-ignore', [" @ts-ignore"]],
    ['a! / 2; const s = "// bukan"; // @ts-ignore', [" @ts-ignore"]],
    ["a! / 2; /* eslint-disable */ b! / 3; // eslint-disable-line", [" eslint-disable ", " eslint-disable-line"]],
  ]);

  it("posisi komentar sesudah pembagian non-null tepat", () => {
    expect(scanComments("a! / 2; // satu\nb! / 3; /* dua */")).toEqual([
      { kind: "line", value: " satu", line: 1, column: 9 },
      { kind: "block", value: " dua ", line: 2, column: 9 },
    ]);
  });
});

describe("scanComments: `/` sebagai pembagian di semua posisi akhir ekspresi", () => {
  expectCases([
    ["x = y / z // @ts-ignore", [" @ts-ignore"]],
    ["(a + b)/ 2; // @ts-ignore", [" @ts-ignore"]],
    ["a[0] / 2 // @ts-ignore", [" @ts-ignore"]],
    ["const o = {} / 2; // @ts-ignore", [" @ts-ignore"]],
    ["const t = `a${b}` / 2 // @ts-ignore", [" @ts-ignore"]],
    ["a as number / 2; // @ts-ignore", [" @ts-ignore"]],
    ["<number>a / 2; // @ts-ignore", [" @ts-ignore"]],
    ["i++ / 2; // @ts-ignore", [" @ts-ignore"]],
    ["this.x / 2; // @ts-ignore", [" @ts-ignore"]],
    ["type / 2; // @ts-ignore", [" @ts-ignore"]],
  ]);
});

describe("scanComments: regex yang memuat tanda kutip tetap dikenali sebagai regex", () => {
  expectCases([
    ["const r = /ab+c/; // eslint-disable-line", [" eslint-disable-line"]],
    ['const r = /"/; // @ts-ignore', [" @ts-ignore"]],
    ["const r = /'/g; /* @ts-nocheck */", [" @ts-nocheck "]],
    ['x = a ? /\'/ : /"/ // @ts-ignore', [" @ts-ignore"]],
    ['!/"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    ['const a = <RegExp>/"/; // @ts-ignore', [" @ts-ignore"]],
    ['label: /"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    ['export default /"/; // @ts-ignore', [" @ts-ignore"]],
    ['/"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    ["x = /re/// @ts-ignore", [" @ts-ignore"]],
  ]);
});

describe("scanComments: regex di posisi yang heuristik 'token sebelumnya' salah baca", () => {
  expectCases([
    // `)` penutup kondisi if/while/for mengakhiri kepala pernyataan, bukan sebuah ekspresi.
    ['if (x) /"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    ['while (x) /"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    ['for (;;) /"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    ['if (a) /"/.test(s); else /\'/.test(s); // @ts-ignore', [" @ts-ignore"]],
    // `}` penutup blok, fungsi, atau kelas diikuti pernyataan baru.
    ['{}\n/"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    ['function f() {}\n/"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    ['class A { m() {} }\n/"/.test(s); // @ts-ignore', [" @ts-ignore"]],
    // `await` dan `of` adalah kata kunci kontekstual yang diikuti ekspresi.
    ['async function f() { await /"/.test(s); } // @ts-ignore', [" @ts-ignore"]],
    ['for (const x of /"/.exec(s) ?? []) {} // @ts-ignore', [" @ts-ignore"]],
    // `++` awalan pada pernyataan baru.
    ['x\n++/"/.lastIndex; // @ts-ignore', [" @ts-ignore"]],
    ['do /"/.test(s); while (x) // @ts-ignore', [" @ts-ignore"]],
  ]);
});

describe("scanComments: string, template, dan regex yang memuat penanda komentar", () => {
  expectCases([
    [
      'const a = "// x" + `// y ${"/* z */"} // w` + /\\/\\/ v/.source; // @ts-ignore',
      [" @ts-ignore"],
    ],
    ["const a = '/*'; // @ts-ignore\nconst b = '*/';", [" @ts-ignore"]],
    ["const a = `${/\\/\\//.source} // bukan`; // @ts-ignore", [" @ts-ignore"]],
    ["const a = `a${1/* c */}b${/* d */2}`; // e", [" c ", " d ", " e"]],
  ]);
});

describe("scanComments: komentar di tempat yang hanya berisi tanda baca atau menempel pada literal", () => {
  expectCases([
    ["f(/* c */);", [" c "]],
    ["f(a, /* b */);", [" b "]],
    ["class A { /* c */ }", [" c "]],
    ["{ /* c */ }", [" c "]],
    ["x = [/* c */];", [" c "]],
    ["type T = { /* c */ };", [" c "]],
    ["enum E { /* c */ }", [" c "]],
    ["x = a ? /* c */ b : c;", [" c "]],
    ['x = "a"/* c */+"b";', [" c "]],
    ["x = /**/'a';", [""]],
    ["x = `a`// c", [" c"]],
    ["/** doc */ export const a = 1; // tail", ["* doc ", " tail"]],
    ["export const a = 1; /* tidak ditutup", [" tidak ditutup"]],
  ]);
});

describe("scanComments: pemindai tanpa parser (sumber yang bersarang sangat dalam)", () => {
  // Parser TypeScript rekursif dan melempar RangeError pada sekitar seribu tingkat kurung (proses
  // utama; Worker punya stack lebih besar), jadi 15000 tingkat melewati batas itu di keduanya. Langkah
  // 3 dan 4 pun gagal pada sumber seperti itu (lihat tes pipeline di comments-gate.test.ts), tetapi
  // `scanComments` tetap total dan tetap menemukan komentar yang tidak ambigu.
  const DEEP = 15_000;

  it("tetap mengembalikan komentar dengan posisinya, tanpa melempar", () => {
    const source = `${"(".repeat(DEEP)}1${")".repeat(DEEP)};\n// @ts-ignore\n`;
    expect(scanComments(source)).toEqual([
      { kind: "line", value: " @ts-ignore", line: 2, column: 1 },
    ]);
  });

  it("tidak melempar untuk kurung siku, kurung kurawal, dan template yang bersarang dalam", () => {
    for (const [open, close] of [
      ["[", "]"],
      ["{", "}"],
      ["`${", "}`"],
      ["a ? ", " : b"],
    ] as const) {
      const source = `${open.repeat(DEEP)}1${close.repeat(DEEP)}\n/* c */`;
      expect(() => scanComments(source)).not.toThrow();
      expect(Array.isArray(scanComments(source))).toBe(true);
    }
  });
});
