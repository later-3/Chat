import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { useStorage } from "nitro/storage";

const MEMORY_SKILL_ASSET = "memory/agents/memory-agent/skills/memory/SKILL.md";

async function readMemorySkillSource(): Promise<string> {
  try {
    return await readFile(new URL("./skills/memory/SKILL.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const content = await useStorage("assets:workflow-resources").getItem<string>(MEMORY_SKILL_ASSET);
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(`找不到Memory Skill资源: ${MEMORY_SKILL_ASSET}`);
  }
  return content;
}

/** Materializes the Chat-owned Skill as a private runtime resource for Pi. */
export async function ensureMemorySkill(runtimeDir: string): Promise<string> {
  const skillDir = resolve(runtimeDir, "skills", "memory");
  const skillPath = resolve(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true, mode: 0o700 });
  const current = await readFile(skillPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const source = await readMemorySkillSource();
  if (current !== source) {
    await writeFile(skillPath, source, { encoding: "utf8", mode: 0o600 });
  }
  return skillPath;
}
