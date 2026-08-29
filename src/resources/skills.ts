import { readFile, realpath, writeFile } from "node:fs/promises";
import {
  DefaultResourceLoader,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { ensureChatDataLayout } from "../chat-data.js";

export async function listPiSkills(cwd: string) {
  const { agentDir } = await ensureChatDataLayout();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      disableModelInvocation: skill.disableModelInvocation,
      sourceInfo: skill.sourceInfo,
    })),
    diagnostics,
    projectResourcesLoaded: true,
  };
}

/** Changes only Pi's disable-model-invocation frontmatter field. */
export async function setSkillModelInvocation(
  cwd: string,
  filePath: string,
  disabled: boolean,
): Promise<void> {
  const available = await listPiSkills(cwd);
  const canonicalPath = await realpath(filePath);
  const availablePaths = await Promise.all(available.skills.map((skill) => realpath(skill.filePath)));
  if (!availablePaths.includes(canonicalPath)) {
    throw new Error("Skill不属于当前工作目录可用资源");
  }
  const content = await readFile(canonicalPath, "utf8");
  const key = "disable-model-invocation";
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
  const current = Boolean(frontmatter[key]);
  let updated = content;
  if (disabled && !current) {
    updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
    if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
  } else if (!disabled && current) {
    updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
  }
  if (updated !== content) await writeFile(canonicalPath, updated, "utf8");
}
