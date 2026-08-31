import { readFile, realpath, writeFile } from "node:fs/promises";
import {
  DefaultResourceLoader,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../chat-home.js";
import { appendChatAuditEvent } from "../audit-log.js";
import { resolveProjectContext } from "../projects/registry.js";
import { describeResourceVersion, qualifiedResourceAddress } from "./version.js";

export async function listPiSkills(cwd: string, projectId?: string) {
  const { agentDir } = await ensureChatHome();
  const project = projectId === undefined ? undefined : await resolveProjectContext(projectId);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    ...(project !== undefined
      ? { additionalSkillPaths: [`${project.projectConfigDir}/skills`] }
      : {}),
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: await Promise.all(skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      disableModelInvocation: skill.disableModelInvocation,
      sourceInfo: skill.sourceInfo,
      address: qualifiedResourceAddress({
        kind: "skill",
        id: skill.name,
        scope: skill.sourceInfo.scope,
        ...(projectId === undefined ? {} : { projectId }),
      }),
      version: await describeResourceVersion(skill.filePath),
    }))),
    diagnostics,
  };
}

/** Changes only Pi's disable-model-invocation frontmatter field. */
export async function setSkillModelInvocation(
  cwd: string,
  filePath: string,
  disabled: boolean,
  projectId?: string,
): Promise<void> {
  const available = await listPiSkills(cwd, projectId);
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
  await appendChatAuditEvent({
    action: "skill.model-invocation.update",
    target: projectId === undefined
      ? { type: "personal", kind: "skill", path: canonicalPath }
      : { type: "project", projectId, kind: "skill", path: canonicalPath },
    details: { disableModelInvocation: disabled },
  });
}
