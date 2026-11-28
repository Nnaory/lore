/**
 * Tests — the animation build flag, checked statically (design 7.9, Requirements 36.1, 36.13, 40.6)
 *
 * Docker cannot run in every place these tests run, so the guards read the files that decide the
 * default of `NEXT_PUBLIC_ANIMATIONS` and check them as text:
 *
 *   1. `frontend/Dockerfile` has `ARG NEXT_PUBLIC_ANIMATIONS=off`, then (the very next instruction)
 *      `ENV NEXT_PUBLIC_ANIMATIONS=${NEXT_PUBLIC_ANIMATIONS}`, both in the `build` stage and both
 *      before `RUN npm run build`, because `next build` inlines the value;
 *   2. `frontend/.env.example` has the uncommented line `NEXT_PUBLIC_ANIMATIONS=off` with a comment;
 *   3. `"ON"`, `"true"`, `"1"` and `""` read as off, and only `"on"` reads as on;
 *   4. the variable is read in one place, as the literal `process.env.NEXT_PUBLIC_ANIMATIONS`.
 *
 * Each check is a function of the file's text. The real files must give no problem, and a
 * broken copy of each (the line removed, the order swapped, the default changed) must give one,
 * so a guard that stops guarding shows up here. The `release-web.yml` build argument and path
 * filters (Requirement 36.13) are checked where that workflow is changed, not here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { animationsEnabled, readAnimationsFlag } from "@/lib/animation/flags";
import { FRONTEND, loadSources, parseSource, walk, where } from "./support/static-scan";

const FLAG = "NEXT_PUBLIC_ANIMATIONS";
const ARG_LINE = `${FLAG}=off`;
const ENV_LINE = `${FLAG}=\${${FLAG}}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------------------------

type Instruction = { readonly keyword: string; readonly args: string; readonly line: number };

/** Instructions of a Dockerfile: comments and blank lines dropped, `\` continuations joined. */
function parseDockerfile(text: string): Instruction[] {
  const instructions: Instruction[] = [];
  let parts: string[] | null = null;
  let start = 0;
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (parts === null) {
      if (trimmed === "" || trimmed.startsWith("#")) return;
      parts = [];
      start = index + 1;
    } else if (trimmed.startsWith("#")) {
      return; // Docker drops comment lines inside a continued instruction.
    }
    const body = raw.trimEnd();
    if (body.endsWith("\\")) {
      parts.push(body.slice(0, -1));
      return;
    }
    parts.push(body);
    const joined = parts.join(" ").trim().replace(/\s+/g, " ");
    const space = joined.indexOf(" ");
    instructions.push({
      keyword: (space < 0 ? joined : joined.slice(0, space)).toUpperCase(),
      args: space < 0 ? "" : joined.slice(space + 1),
      line: start,
    });
    parts = null;
  });
  return instructions;
}

/** Name of the stage each instruction belongs to (`""` before the first `FROM`). */
function stagesOf(instructions: readonly Instruction[]): string[] {
  let stage = "";
  return instructions.map((instruction) => {
    if (instruction.keyword === "FROM") {
      const named = /\sAS\s+(\S+)\s*$/i.exec(instruction.args);
      stage = named ? named[1] : `stage-${instruction.line}`;
    }
    return stage;
  });
}

const MENTIONS_FLAG = new RegExp(`(^|\\s)${FLAG}(=|\\s|$)`);

/** Problems with how a Dockerfile sets `NEXT_PUBLIC_ANIMATIONS`; empty when it is right. */
function checkDockerfile(text: string): string[] {
  const problems: string[] = [];
  const instructions = parseDockerfile(text);
  const stages = stagesOf(instructions);
  const argIndexes: number[] = [];
  const envIndexes: number[] = [];
  instructions.forEach((instruction, index) => {
    if (instruction.keyword === "ARG" && MENTIONS_FLAG.test(instruction.args)) argIndexes.push(index);
    if (instruction.keyword === "ENV" && MENTIONS_FLAG.test(instruction.args)) envIndexes.push(index);
  });

  if (argIndexes.length !== 1) {
    problems.push(`expected exactly one ARG ${FLAG}, found ${argIndexes.length}`);
  } else if (instructions[argIndexes[0]].args !== ARG_LINE) {
    problems.push(`ARG must be exactly "ARG ${ARG_LINE}", found "ARG ${instructions[argIndexes[0]].args}"`);
  }
  if (envIndexes.length !== 1) {
    problems.push(`expected exactly one ENV ${FLAG}, found ${envIndexes.length}`);
  } else if (instructions[envIndexes[0]].args !== ENV_LINE) {
    problems.push(`ENV must be exactly "ENV ${ENV_LINE}", found "ENV ${instructions[envIndexes[0]].args}"`);
  }
  if (argIndexes.length !== 1 || envIndexes.length !== 1) return problems;

  const [arg] = argIndexes;
  const [env] = envIndexes;
  if (env !== arg + 1) problems.push("ENV must be the instruction right after ARG");
  if (stages[arg] !== "build") problems.push(`ARG is in stage "${stages[arg]}", not "build"`);
  if (stages[env] !== "build") problems.push(`ENV is in stage "${stages[env]}", not "build"`);
  const build = instructions.findIndex(
    (instruction, index) =>
      stages[index] === "build" && instruction.keyword === "RUN" && /\bnpm run build\b/.test(instruction.args),
  );
  if (build < 0) {
    problems.push('the "build" stage has no RUN npm run build');
  } else if (arg > build || env > build) {
    problems.push("ARG and ENV must come before RUN npm run build");
  }
  return problems;
}

describe("frontend/Dockerfile", () => {
  const real = readFileSync(join(FRONTEND, "Dockerfile"), "utf8");

  it("has ARG NEXT_PUBLIC_ANIMATIONS=off and then ENV NEXT_PUBLIC_ANIMATIONS=${NEXT_PUBLIC_ANIMATIONS} in the build stage, before npm run build", () => {
    expect(checkDockerfile(real)).toEqual([]);
  });

  it("holds the two lines in the order ARG, ENV, byte for byte", () => {
    const lines = real.split("\n");
    const arg = lines.indexOf(`ARG ${ARG_LINE}`);
    expect(arg).toBeGreaterThan(-1);
    expect(lines[arg + 1]).toBe(`ENV ${ENV_LINE}`);
  });

  it("keeps the project store argument that was already there", () => {
    expect(real).toContain("ARG NEXT_PUBLIC_PROJECT_STORE=idb");
    expect(real).toContain("ENV NEXT_PUBLIC_PROJECT_STORE=${NEXT_PUBLIC_PROJECT_STORE}");
  });

  describe("fails on a broken copy", () => {
    const withoutLines = (...drop: string[]) =>
      real
        .split("\n")
        .filter((line) => !drop.includes(line))
        .join("\n");

    it("without the ARG line", () => {
      expect(checkDockerfile(withoutLines(`ARG ${ARG_LINE}`))).toContain("expected exactly one ARG NEXT_PUBLIC_ANIMATIONS, found 0");
    });

    it("without the ENV line", () => {
      expect(checkDockerfile(withoutLines(`ENV ${ENV_LINE}`))).toContain("expected exactly one ENV NEXT_PUBLIC_ANIMATIONS, found 0");
    });

    it("with the default on", () => {
      const broken = real.replace(`ARG ${ARG_LINE}`, `ARG ${FLAG}=on`);
      expect(checkDockerfile(broken)).toEqual([`ARG must be exactly "ARG ${ARG_LINE}", found "ARG ${FLAG}=on"`]);
    });

    it("with no default", () => {
      const broken = real.replace(`ARG ${ARG_LINE}`, `ARG ${FLAG}`);
      expect(checkDockerfile(broken)).toEqual([`ARG must be exactly "ARG ${ARG_LINE}", found "ARG ${FLAG}"`]);
    });

    it("with ENV set to a fixed value instead of the argument", () => {
      const broken = real.replace(`ENV ${ENV_LINE}`, `ENV ${FLAG}=off`);
      expect(checkDockerfile(broken)).toEqual([`ENV must be exactly "ENV ${ENV_LINE}", found "ENV ${FLAG}=off"`]);
    });

    it("with ENV before ARG", () => {
      const broken = real.replace(`ARG ${ARG_LINE}\nENV ${ENV_LINE}`, `ENV ${ENV_LINE}\nARG ${ARG_LINE}`);
      expect(broken).not.toBe(real);
      expect(checkDockerfile(broken)).toContain("ENV must be the instruction right after ARG");
    });

    it("with another instruction between ARG and ENV", () => {
      const broken = real.replace(`ARG ${ARG_LINE}\n`, `ARG ${ARG_LINE}\nARG SOMETHING_ELSE=1\n`);
      expect(checkDockerfile(broken)).toContain("ENV must be the instruction right after ARG");
    });

    it("with both lines in the runtime stage, after the build", () => {
      const moved = withoutLines(`ARG ${ARG_LINE}`, `ENV ${ENV_LINE}`).replace(
        "USER app",
        `ARG ${ARG_LINE}\nENV ${ENV_LINE}\nUSER app`,
      );
      const problems = checkDockerfile(moved);
      expect(problems).toContain('ARG is in stage "runtime", not "build"');
      expect(problems).toContain('ENV is in stage "runtime", not "build"');
    });

    it("with both lines after npm run build", () => {
      const moved = withoutLines(`ARG ${ARG_LINE}`, `ENV ${ENV_LINE}`).replace(
        "RUN npm run build",
        `RUN npm run build\nARG ${ARG_LINE}\nENV ${ENV_LINE}`,
      );
      expect(checkDockerfile(moved)).toContain("ARG and ENV must come before RUN npm run build");
    });

    it("with the ARG declared twice", () => {
      const broken = real.replace(`ARG ${ARG_LINE}`, `ARG ${ARG_LINE}\nARG ${ARG_LINE}`);
      expect(checkDockerfile(broken)).toContain("expected exactly one ARG NEXT_PUBLIC_ANIMATIONS, found 2");
    });

    it("with a comment that mentions the lines but no instruction", () => {
      const broken = withoutLines(`ARG ${ARG_LINE}`, `ENV ${ENV_LINE}`).replace(
        "RUN npm run build",
        `# ARG ${ARG_LINE}\n# ENV ${ENV_LINE}\nRUN npm run build`,
      );
      expect(checkDockerfile(broken)).toContain("expected exactly one ARG NEXT_PUBLIC_ANIMATIONS, found 0");
    });
  });

  describe("the Dockerfile reader", () => {
    it("joins continued lines and skips comments inside them", () => {
      const text = "FROM node AS build\nRUN a \\\n  # note\n  && b\n# alone\nENV X=1\n";
      expect(parseDockerfile(text)).toEqual([
        { keyword: "FROM", args: "node AS build", line: 1 },
        { keyword: "RUN", args: "a && b", line: 2 },
        { keyword: "ENV", args: "X=1", line: 6 },
      ]);
    });

    it("names the stage of each instruction", () => {
      const instructions = parseDockerfile("ARG A=1\nFROM x AS deps\nRUN a\nFROM x AS build\nRUN b\n");
      expect(stagesOf(instructions)).toEqual(["", "deps", "deps", "build", "build"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// .env.example
// ---------------------------------------------------------------------------------------------

/** Problems with how `.env.example` documents `NEXT_PUBLIC_ANIMATIONS`; empty when it is right. */
function checkEnvExample(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  const assignments = lines.flatMap((line, index) => (new RegExp(`^\\s*${FLAG}\\s*=`).test(line) ? [index] : []));
  if (assignments.length !== 1) {
    return [`expected exactly one uncommented ${FLAG} line, found ${assignments.length}`];
  }
  const [index] = assignments;
  if (lines[index] !== ARG_LINE) problems.push(`the line must be exactly "${ARG_LINE}", found "${lines[index]}"`);
  const comment: string[] = [];
  for (let up = index - 1; up >= 0 && lines[up].startsWith("#"); up -= 1) comment.unshift(lines[up]);
  if (comment.length === 0) {
    problems.push("the line has no comment above it");
  } else if (!/\bon\b/.test(comment.join(" "))) {
    problems.push("the comment does not say what the value on does");
  }
  return problems;
}

describe("frontend/.env.example", () => {
  const real = readFileSync(join(FRONTEND, ".env.example"), "utf8");

  it("has the line NEXT_PUBLIC_ANIMATIONS=off with a comment above it that explains on", () => {
    expect(checkEnvExample(real)).toEqual([]);
  });

  it("lists it after the project store flag it is modelled on", () => {
    expect(real.indexOf("NEXT_PUBLIC_PROJECT_STORE=idb")).toBeGreaterThan(-1);
    expect(real.indexOf(ARG_LINE)).toBeGreaterThan(real.indexOf("NEXT_PUBLIC_PROJECT_STORE=idb"));
  });

  describe("fails on a broken copy", () => {
    it("without the line", () => {
      expect(checkEnvExample(real.replace(`${ARG_LINE}\n`, ""))).toEqual([
        `expected exactly one uncommented ${FLAG} line, found 0`,
      ]);
    });

    it("with the line commented out", () => {
      expect(checkEnvExample(real.replace(`\n${ARG_LINE}\n`, `\n# ${ARG_LINE}\n`))).toEqual([
        `expected exactly one uncommented ${FLAG} line, found 0`,
      ]);
    });

    it("with the default on", () => {
      expect(checkEnvExample(real.replace(ARG_LINE, `${FLAG}=on`))).toEqual([
        `the line must be exactly "${ARG_LINE}", found "${FLAG}=on"`,
      ]);
    });

    it("with the line set twice", () => {
      expect(checkEnvExample(`${real}${FLAG}=on\n`)).toEqual([
        `expected exactly one uncommented ${FLAG} line, found 2`,
      ]);
    });

    it("without the comment", () => {
      const lines = real.split("\n");
      const index = lines.indexOf(ARG_LINE);
      let first = index;
      while (first > 0 && lines[first - 1].startsWith("#")) first -= 1;
      lines.splice(first, index - first);
      expect(checkEnvExample(lines.join("\n"))).toEqual(["the line has no comment above it"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

describe("flag values", () => {
  it.each(["ON", "true", "1", ""])("reads %j as off", (raw) => {
    expect(animationsEnabled(raw)).toBe(false);
    vi.stubEnv(FLAG, raw);
    expect(readAnimationsFlag()).toBe(false);
  });

  it("reads off and an unset variable as off", () => {
    expect(animationsEnabled("off")).toBe(false);
    expect(animationsEnabled(undefined)).toBe(false);
    vi.stubEnv(FLAG, "off");
    expect(readAnimationsFlag()).toBe(false);
  });

  it('reads only the exact value "on" as on', () => {
    expect(animationsEnabled("on")).toBe(true);
    vi.stubEnv(FLAG, "on");
    expect(readAnimationsFlag()).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// One literal read
// ---------------------------------------------------------------------------------------------

/**
 * Places in `text` that name the flag other than as the literal `process.env.NEXT_PUBLIC_ANIMATIONS`:
 * `process.env["..."]`, a destructured `process.env`, a variable holding the name. Next inlines
 * only the literal member access, so any of these would read as unset in the browser.
 */
function nonLiteralFlagUses(path: string, text: string): string[] {
  const sf = parseSource(path, text);
  const found: string[] = [];
  walk(sf, (node) => {
    const named =
      (ts.isIdentifier(node) && node.text === FLAG) || (ts.isStringLiteralLike(node) && node.text === FLAG);
    if (!named) return;
    const parent = node.parent;
    const literal =
      ts.isPropertyAccessExpression(parent) &&
      parent.name === node &&
      ts.isPropertyAccessExpression(parent.expression) &&
      ts.isIdentifier(parent.expression.expression) &&
      parent.expression.expression.text === "process" &&
      parent.expression.name.text === "env";
    if (!literal) found.push(where(path, sf, node));
  });
  return found;
}

/** Places in `text` that read the flag with the literal `process.env.NEXT_PUBLIC_ANIMATIONS`. */
function literalFlagReads(path: string, text: string): string[] {
  const sf = parseSource(path, text);
  const found: string[] = [];
  walk(sf, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === FLAG &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "env" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process"
    ) {
      found.push(where(path, sf, node));
    }
  });
  return found;
}

describe("the flag is read in one place, as a literal", () => {
  const sources = loadSources(["src", "sandbox-runtime"]);

  it("scans the source tree", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.map((source) => source.path)).toContain("src/lib/animation/flags.ts");
  });

  it("reads process.env.NEXT_PUBLIC_ANIMATIONS only in src/lib/animation/flags.ts, once", () => {
    const reads = sources.flatMap(({ path, sf }) => literalFlagReads(path, sf.text));
    expect(reads).toHaveLength(1);
    expect(reads[0].startsWith("src/lib/animation/flags.ts:")).toBe(true);
  });

  it("never names the flag in any other way", () => {
    const uses = sources.flatMap(({ path, sf }) => nonLiteralFlagUses(path, sf.text));
    expect(uses).toEqual([]);
  });

  describe("the rule on samples", () => {
    it("accepts the literal read", () => {
      expect(nonLiteralFlagUses("a.ts", `const on = process.env.${FLAG} === "on";`)).toEqual([]);
      expect(literalFlagReads("a.ts", `const on = process.env.${FLAG} === "on";`)).toHaveLength(1);
    });

    it("ignores comments and unrelated names", () => {
      const text = `// process.env.${FLAG}\nconst s = "NEXT_PUBLIC_ANIMATIONS_X"; const e = process.env.OTHER;`;
      expect(nonLiteralFlagUses("a.ts", text)).toEqual([]);
      expect(literalFlagReads("a.ts", text)).toEqual([]);
    });

    it.each([
      ["element access", `const v = process.env["${FLAG}"];`],
      ["destructuring", `const { ${FLAG}: v } = process.env;`],
      ["a variable holding the name", `const key = "${FLAG}"; const v = process.env[key];`],
      ["another object", `const v = config.${FLAG};`],
      ["env of something else", `const v = other.env.${FLAG};`],
    ])("flags %s", (_label, text) => {
      expect(nonLiteralFlagUses("a.ts", text).length).toBeGreaterThan(0);
    });
  });
});
