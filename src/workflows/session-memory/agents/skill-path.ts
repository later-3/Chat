import { fileURLToPath } from "node:url";

/** Absolute path of the built-in session-memory Skill, shared by the worker and the writer. */
export function sessionMemorySkillPath(): string {
  return fileURLToPath(new URL("../../../resources/builtin-skills/session-memory/SKILL.md", import.meta.url));
}
