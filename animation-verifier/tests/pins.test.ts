// Tes pin dependensi: setiap dependensi di package.json harus berupa versi persis.
// Verifier dan runtime browser harus memakai build yang sama (Requirement 8.13, 32.7), dan
// penentu rentang membuat `npm install` baru dapat menggeser versi tanpa perubahan di repo.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const FORBIDDEN_PREFIXES = ["^", "~", ">=", "*", "latest"] as const;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True bila `spec` berupa satu versi persis tanpa penentu rentang atau tag. */
function isExactPin(spec: string): boolean {
  const hasForbiddenPrefix = FORBIDDEN_PREFIXES.some((prefix) => spec.startsWith(prefix));
  return !hasForbiddenPrefix && EXACT_VERSION.test(spec);
}

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;

const entries: [field: string, name: string, spec: string][] = DEPENDENCY_FIELDS.flatMap((field) =>
  Object.entries(pkg[field] ?? {}).map(([name, spec]): [string, string, string] => [
    field,
    name,
    spec,
  ]),
);

describe("isExactPin", () => {
  it.each(["1.2.3", "0.28.2", "19.3.0", "4.0.543", "1.0.0-rc.1"])("menerima %s", (spec) => {
    expect(isExactPin(spec)).toBe(true);
  });

  it.each(["^1.2.3", "~1.2.3", ">=1.2.3", "*", "latest", "1.x", "1.2", ">1.2.3", "1.2.3 - 2.0.0", ""])(
    "menolak %j",
    (spec) => {
      expect(isExactPin(spec)).toBe(false);
    },
  );
});

describe("package.json", () => {
  it("memuat dependensi yang diperiksa", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s: %s dipin ke versi persis (%s)", (_field, _name, spec) => {
    for (const prefix of FORBIDDEN_PREFIXES) {
      expect(spec.startsWith(prefix)).toBe(false);
    }
    expect(isExactPin(spec)).toBe(true);
  });
});
