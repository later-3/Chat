import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { useStorage } from "nitro/storage";

const CHAT_ARCHITECTURE_ASSET = "chat-architecture/SKILL.md";

async function readChatArchitectureSkillSource(): Promise<string> {
  try {
    return await readFile(new URL("./chat-architecture/SKILL.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const content = await useStorage("assets:chat-skills").getItem<string>(CHAT_ARCHITECTURE_ASSET);
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(`找不到Chat架构Skill资源: ${CHAT_ARCHITECTURE_ASSET}`);
  }
  return content;
}

/** Materializes Chat's built-in architecture Skill without treating it as user-installed data. */
export async function ensureChatArchitectureSkill(runtimeDir: string): Promise<string> {
  const skillDir = resolve(runtimeDir, "skills", "chat-architecture");
  const skillPath = resolve(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true, mode: 0o700 });
  const current = await readFile(skillPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const source = await readChatArchitectureSkillSource();
  if (current !== source) {
    await writeFile(skillPath, source, { encoding: "utf8", mode: 0o600 });
  }
  return skillPath;
}
