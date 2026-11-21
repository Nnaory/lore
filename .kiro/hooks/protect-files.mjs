// PreToolUse hook for file-writing tools (fs_write, fs_append, str_replace, delete_file).
//
// Blocks edits to files that must be changed by tooling, not by hand: lockfiles,
// the existing Alembic revisions, secret-bearing files, Terraform state, and
// generated or vendored folders.
//
// Path extraction is defensive (see _lib.mjs): it looks at any tool_input key
// whose name contains path/file/target/dest. If no path is found the call is
// allowed, because blocking blind would break normal work.

import { existsSync } from "node:fs";
import path from "node:path";
import { block, pathValues, readInput } from "./_lib.mjs";

const input = readInput();
const cwd = (input.cwd || process.cwd()).replace(/\\/g, "/");
const paths = pathValues(input.tool_input);

const PROTECTED = [
  [/(^|\/)package-lock\.json$/, "package-lock.json is managed by npm. Run npm install/ci instead of editing it."],
  [/(^|\/)\.terraform\.lock\.hcl$/, ".terraform.lock.hcl is managed by terraform init."],
  [/(^|\/)\.env(?!\.example$)(\..+)?$/, ".env files hold secrets. Edit .env.example for placeholders only."],
  [/\.tfstate(\.|$)/, "Terraform state must never be edited."],
  [/\.tfvars$/, ".tfvars files can hold secrets. Use *.tfvars.example."],
  [/(^|\/)node_modules\//, "node_modules is vendored."],
  [/(^|\/)\.next\//, ".next is a build output."],
];

for (const raw of paths) {
  for (const [pattern, reason] of PROTECTED) {
    if (pattern.test(raw)) block(`${raw}: ${reason}`);
  }
  // Existing Alembic revisions are immutable; creating a NEW revision file is fine.
  if (/(^|\/)backend\/alembic\/versions\/[^/]+\.py$/.test(raw)) {
    const abs = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
    if (existsSync(abs)) {
      block(`${raw}: existing Alembic revisions must not be edited. Add a new revision (expand-only).`);
    }
  }
}
process.exit(0);
