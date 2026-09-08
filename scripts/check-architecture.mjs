// Read-only navigation check; semantic architecture review still needs scenario evidence.
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoints = [
  "AGENTS.md", "CLAUDE.md", ".chat/skills/chat-architecture/SKILL.md",
  "docs/README.md", "docs/architecture/README.md", "docs/development/README.md",
  "docs/development/agent-contribution.md", "docs/development/diagnostics.md",
  "docs/development/local-debugging.md", "docs/architecture/chat-module-contracts.md",
];
for (const name of await readdir(resolve(root, "docs/development/debugging"))) {
  if (name.endsWith(".md")) entrypoints.push(`docs/development/debugging/${name}`);
}
let checked = 0;
const errors = [];
for (const name of entrypoints) {
  const file = resolve(root, name);
  const content = await readFile(file, "utf8");
  // Ignore examples in fenced code blocks. Validate local Markdown targets, not remote URLs.
  const prose = content.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "");
  for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    try {
      await stat(resolve(dirname(file), decodeURIComponent(target)));
      checked += 1;
    } catch { errors.push(`${name}: missing local target ${target}`); }
  }
  // The Skill intentionally uses root-relative code paths for cross-CLI navigation.
  if (name.endsWith("/SKILL.md")) {
    for (const match of prose.matchAll(/`((?:docs\/|src\/)[^`\n]+|AGENTS\.md)`/g)) {
      try {
        await stat(resolve(root, match[1]));
        checked += 1;
      } catch { errors.push(`${name}: missing navigation source ${match[1]}`); }
    }
  }
}
const canonical = resolve(root, ".chat/skills/chat-architecture/SKILL.md");
try {
  const alias = await realpath(resolve(root, ".agents/skills/chat-architecture/SKILL.md"));
  if (alias !== await realpath(canonical)) errors.push("CLI alias must point to the canonical Skill");
} catch { errors.push("CLI architecture Skill alias is missing or broken"); }
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Architecture navigation: ${entrypoints.length} entrypoints, ${checked} local links, one canonical Skill.`);
  console.log("Next: read only task-relevant sources; verify discovery, selection and actual execution separately.");
}
