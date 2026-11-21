// Shared helpers for the LORE Kiro hooks.
//
// Why this exists: Kiro passes hook context as JSON on STDIN. The docs name the
// fields hook_event_name, cwd, session_id, tool_name and tool_input, but do not
// list the keys inside tool_input for each tool (UNVERIFIED for fs_write /
// execute_pwsh). So these helpers collect values defensively instead of
// assuming one key name. Verify against a real run with `/hooks` in Kiro.

import { readFileSync } from "node:fs";

/** Read and parse the JSON Kiro writes to STDIN. Returns {} on any problem. */
export function readInput() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Every string value found anywhere inside `value` (depth-first). */
export function allStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

/** Values of keys that look like file paths (path, file, filePath, target, dest...). */
export function pathValues(toolInput) {
  const out = [];
  const visit = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, val] of Object.entries(obj)) {
      if (/path|file|target|dest/i.test(key)) {
        if (typeof val === "string") out.push(val);
        else if (Array.isArray(val)) val.forEach((v) => typeof v === "string" && out.push(v));
      } else if (val && typeof val === "object") {
        visit(val);
      }
    }
  };
  visit(toolInput);
  return out.map((p) => p.replace(/\\/g, "/"));
}

/** Block the tool call: stderr goes to the agent, non-zero exit blocks PreToolUse. */
export function block(message) {
  process.stderr.write(`[lore-hook] BLOCKED: ${message}\n`);
  process.exit(2);
}
