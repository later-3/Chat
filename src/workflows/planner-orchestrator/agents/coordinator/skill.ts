import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { useStorage } from "nitro/storage";

const WORKFLOW_DELEGATION_SKILL_ASSET = "planner-orchestrator/agents/coordinator/skills/workflow-delegation/SKILL.md";

async function readWorkflowDelegationSkillSource(): Promise<string> {
  try {
    return await readFile(new URL("./skills/workflow-delegation/SKILL.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const content = await useStorage("assets:workflow-resources").getItem<string>(WORKFLOW_DELEGATION_SKILL_ASSET);
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(`找不到Workflow Delegation Skill资源: ${WORKFLOW_DELEGATION_SKILL_ASSET}`);
  }
  return content;
}

export async function ensureWorkflowDelegationSkill(
  runtimeDir: string,
  options: { readonly refresh?: boolean } = {},
): Promise<string> {
  const skillDir = resolve(runtimeDir, "skills", "workflow-delegation");
  const skillPath = resolve(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true, mode: 0o700 });
  const current = await readFile(skillPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (options.refresh !== true && current !== undefined && current.trim() !== "") return skillPath;
  const source = await readWorkflowDelegationSkillSource();
  if (current !== source) await writeFile(skillPath, source, { encoding: "utf8", mode: 0o600 });
  return skillPath;
}
