// PreToolUse hook for shell tools (execute_bash on Unix, execute_pwsh on Windows).
//
// Blocks commands that change shared state or destroy data. These are the
// operations the repo scan flagged: terraform apply/destroy (CI already applies
// on merge to main), AWS commands that mutate resources, docker push, force
// push, alembic downgrade, recursive deletes. Read-only variants stay allowed.
//
// It scans every string in tool_input, so it does not depend on the exact key
// name of the command field. Trade-off: a command that merely *mentions* one of
// these (for example an echo) is also blocked. That is deliberate and cheap.

import { allStrings, block, readInput } from "./_lib.mjs";

const MUTATING_AWS_VERBS =
  "create|delete|put|update|modify|terminate|run|start|stop|reboot|send-command|add-tags|remove|attach|detach|associate|disassociate|register|deregister|revoke|authorize|import|tag|untag|set|enable|disable|invoke|publish|restore|reset|cp|mv|rm|sync|rb|mb";

const RULES = [
  [/\bterraform\b[^\n|;&]*\b(apply|destroy)\b/i, "terraform apply/destroy from a local machine. CI applies on merge to main (infra.yml); change infra through a PR."],
  [new RegExp(`\\baws\\b\\s+(?:--\\S+\\s+\\S+\\s+)*[\\w-]+\\s+(?:${MUTATING_AWS_VERBS})[\\w-]*`, "i"), "AWS CLI command that changes resources. Only describe/get/list calls are allowed locally."],
  [/\bdocker\b\s+push\b/i, "docker push. Images are pushed by the release workflows."],
  [/\bgit\b[^\n|;&]*\bpush\b[^\n|;&]*(--force\b|--force-with-lease\b|\s-f\b)/i, "force push."],
  [/\bgit\b\s+reset\s+--hard\b/i, "git reset --hard (discards work)."],
  [/\bgit\b\s+clean\b[^\n|;&]*-[a-z]*f/i, "git clean -f (deletes untracked files)."],
  [/\balembic\b[^\n|;&]*\bdowngrade\b/i, "alembic downgrade. Migrations must stay expand-only."],
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b[^\n|;&]*--force|--force\b[^\n|;&]*--recursive)/i, "recursive forced delete (rm -rf)."],
  [/\bRemove-Item\b(?=[^\n|;&]*-Recurse)(?=[^\n|;&]*-Force)/i, "recursive forced delete (Remove-Item -Recurse -Force)."],
];

const input = readInput();
const text = allStrings(input.tool_input).join("\n");

for (const [pattern, reason] of RULES) {
  if (pattern.test(text)) {
    block(`${reason} Ask the user to run it themselves if it is really needed.`);
  }
}
process.exit(0);
