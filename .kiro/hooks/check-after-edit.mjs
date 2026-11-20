// PostToolUse hook for file-writing tools.
//
// Runs a fast, single-file check on what the agent just changed:
//   backend/**/*.py            -> ruff check <file>
//   frontend/{src,tests}/**/*.ts(x) -> eslint <file>
// Output of a failing check goes to the agent (stderr, exit 2) so it can fix it.
//
// It never fails because a tool is missing: ruff is not installed on every
// machine and frontend/node_modules is not always present. In that case it
// exits 0 silently. Full tests and tsc are deliberately NOT run here (too slow
// per edit); CI and the agent's own steps cover them.

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathValues, readInput } from "./_lib.mjs";

const input = readInput();
const root = path.resolve(input.cwd || process.cwd());
const files = [...new Set(pathValues(input.tool_input))].map((p) =>
  path.isAbsolute(p) ? p : path.join(root, p),
);

const rel = (abs) => path.relative(root, abs).replace(/\\/g, "/");
const run = (cmd, args, cwd) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", shell: true, timeout: 80_000 });

const failures = [];

for (const abs of files) {
  if (!existsSync(abs)) continue; // deleted or not a real file
  const r = rel(abs);

  if (/^backend\/.+\.py$/.test(r)) {
    let res = run("ruff", ["check", `"${path.relative(path.join(root, "backend"), abs)}"`], path.join(root, "backend"));
    if (res.status !== 0 && /not (found|recognized)|No module named/i.test(`${res.stderr}${res.stdout}`)) {
      res = run("python", ["-m", "ruff", "check", `"${path.relative(path.join(root, "backend"), abs)}"`], path.join(root, "backend"));
    }
    const missing = /not (found|recognized)|No module named/i.test(`${res.stderr}${res.stdout}`);
    if (res.error || missing) continue; // ruff unavailable: skip silently
    if (res.status !== 0) failures.push(`ruff ${r}\n${res.stdout}${res.stderr}`);
  } else if (/^frontend\/(src|tests)\/.+\.(ts|tsx)$/.test(r)) {
    const hasEslint = [
      path.join(root, "frontend/node_modules/.bin/eslint"),
      path.join(root, "node_modules/.bin/eslint"),
    ].some((p) => existsSync(p) || existsSync(`${p}.cmd`));
    if (!hasEslint) continue; // run `npm ci` in frontend/ to enable this check
    const res = run("npx", ["--no-install", "eslint", `"${path.relative(path.join(root, "frontend"), abs)}"`], path.join(root, "frontend"));
    if (res.error) continue;
    if (res.status !== 0) failures.push(`eslint ${r}\n${res.stdout}${res.stderr}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`[lore-hook] Fix these before continuing:\n${failures.join("\n---\n")}\n`);
  process.exit(2);
}
process.exit(0);
