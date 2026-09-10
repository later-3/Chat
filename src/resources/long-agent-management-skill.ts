import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { useStorage } from "nitro/storage";
import { ensureChatHome } from "../chat-home.js";
import { assertFileWithin, atomicWriteText, contentRevision, fileRevision, withFileLock } from "../persistence/versioned-file.js";

const SKILL_NAME = "long-agent-management";

async function source(): Promise<string> {
  try { return await readFile(new URL(`./builtin-skills/${SKILL_NAME}/SKILL.md`, import.meta.url), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const value = await useStorage("assets:builtin-skills").getItem<string>(`${SKILL_NAME}/SKILL.md`);
  if (typeof value !== "string" || !value.startsWith("---")) throw new Error("找不到Long Agent管理Skill发布资源");
  return value;
}

/** Install as an ordinary Personal Skill. Only update a previously installed, unmodified copy. */
export async function ensureLongAgentManagementSkill(chatHome: string) {
  const home = await ensureChatHome(chatHome);
  const path = resolve(home.agentDir, "skills", SKILL_NAME, "SKILL.md");
  const receipt = resolve(home.runtimeDir, "builtin-skills", `${SKILL_NAME}.sha256`);
  return withFileLock(path, async () => {
    await assertFileWithin(path, home.agentDir);
    await assertFileWithin(receipt, home.root);
    const current = await fileRevision(path);
    const installed = await readFile(receipt, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    const content = await source();
    const version = contentRevision(content);
    if (current !== "absent" && current !== installed && current !== version) {
      return { path, status: "user-owned" as const };
    }
    if (current !== version) await atomicWriteText(path, content);
    await atomicWriteText(receipt, version);
    return { path, status: "installed" as const };
  });
}
