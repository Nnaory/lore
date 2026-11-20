// SessionStart hook: stdout is added to the agent's context.
//
// Prints the current branch and the few rules that are easy to forget, so every
// session starts with the same guardrails regardless of which steering files
// happen to be loaded.

import { spawnSync } from "node:child_process";

const git = (...args) => spawnSync("git", args, { encoding: "utf8" }).stdout?.trim() ?? "";
const branch = git("rev-parse", "--abbrev-ref", "HEAD") || "unknown";
const dirty = git("status", "--short").split("\n").filter(Boolean).length;

console.log(`LORE session start. Branch: ${branch} (${dirty} changed/untracked paths).
Rules:
- Do not commit or push unless the user asks. main is protected: work on a feature branch and open a PR.
- Do not run terraform apply/destroy or mutating AWS commands locally (CI applies infra on merge to main).
- Frontend commands run from frontend/ (run npm ci first if frontend/node_modules is missing). Backend commands run from backend/.
- Code and tests go in separate Conventional Commits.`);
