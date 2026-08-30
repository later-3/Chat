import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { useStorage } from "nitro/storage";

const RULE_LIBRARY_SKILL_ASSET = "rule-management/agents/rule-curator-agent/skills/rule-library/SKILL.md";

async function readRuleLibrarySkillSource(): Promise<string> {
  try {
    return await readFile(new URL("./skills/rule-library/SKILL.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const content = await useStorage("assets:workflow-resources").getItem<string>(RULE_LIBRARY_SKILL_ASSET);
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(`找不到Rule Library Skill资源: ${RULE_LIBRARY_SKILL_ASSET}`);
  }
  return content;
}

export async function ensureRuleLibrarySkill(runtimeDir: string): Promise<string> {
  const skillDir = resolve(runtimeDir, "skills", "rule-library");
  const skillPath = resolve(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true, mode: 0o700 });
  const current = await readFile(skillPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const source = await readRuleLibrarySkillSource();
  if (current !== source) await writeFile(skillPath, source, { encoding: "utf8", mode: 0o600 });
  return skillPath;
}
