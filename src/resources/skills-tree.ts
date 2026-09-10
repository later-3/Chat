import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../chat-home.js";
import { longAgentConfigRoot, readLongAgentRegistry } from "../long-agents/storage.js";
import { listProjects, resolveProjectContext } from "../projects/registry.js";
import { inspectWorkflowAgent } from "../workflows/agent-inspection.js";
import { getChatWorkflowDefinition, listChatWorkflowDefinitions } from "../workflows/registry.js";

export interface ChatSkillTreeEntry {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly disableModelInvocation: boolean;
}

export interface ChatSkillTree {
  readonly schemaVersion: 1;
  readonly personal: { readonly skills: readonly ChatSkillTreeEntry[]; readonly error?: string };
  readonly projects: readonly {
    readonly projectId: string;
    readonly name: string;
    readonly path: string;
    readonly available: boolean;
    readonly skills: readonly ChatSkillTreeEntry[];
    readonly error?: string;
  }[];
  readonly workflows: readonly {
    readonly workflowId: string;
    readonly name: string;
    readonly agents: readonly {
      readonly agentId: string;
      readonly name: string;
      readonly skills: readonly ChatSkillTreeEntry[];
      readonly error?: string;
    }[];
  }[];
  readonly longAgents: readonly {
    readonly longAgentId: string;
    readonly name: string;
    readonly skills: readonly ChatSkillTreeEntry[];
    readonly error?: string;
  }[];
}

function simplify(
  skills: readonly {
    name: string;
    description: string;
    filePath: string;
    disableModelInvocation?: boolean;
  }[],
): ChatSkillTreeEntry[] {
  return skills
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation ?? false,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Loads Skills with a controlled discovery scope. An empty throwaway agentDir
 * keeps Personal Skills out; an empty throwaway cwd keeps `.pi/skills` out.
 * Read-only discovery: no files are created or modified.
 */
function isUnderAnyRoot(filePath: string, roots: readonly string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return roots.some((root) => {
    const prefix = root.replace(/\\/g, "/").replace(/\/$/, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

/**
 * Loads Skills with a controlled discovery scope. An empty throwaway agentDir
 * keeps Personal Skills out; an empty throwaway cwd keeps `.pi/skills` out.
 * Pi 的包管理器还会全局扫描 `~/.agents/skills`，与本树要展示的归属无关，
 * 因此结果按 `pathRoots` 做真实路径过滤。只读发现，不创建或修改文件。
 */
async function loadScopedSkills(input: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly additionalSkillPaths?: readonly string[];
  readonly pathRoots: readonly string[];
}): Promise<ChatSkillTreeEntry[]> {
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    noExtensions: true,
    ...(input.additionalSkillPaths === undefined
      ? {}
      : { additionalSkillPaths: [...input.additionalSkillPaths] }),
  });
  await loader.reload();
  return simplify(loader.getSkills().skills.filter((skill) => isUnderAnyRoot(skill.filePath, input.pathRoots)));
}

function sectionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the four-level Skill ownership tree (Chat system / Project / Workflow /
 * Long Agent). Workflow sections resolve each Agent through the same Pi assembly
 * path as execution and keep only the Skills injected by the Workflow itself
 * (`owner === "injected"`); Personal and Project sections list the directories
 * an Agent can discover from those scopes.
 */
export async function buildChatSkillTree(input: {
  readonly projectId: string;
  readonly chatHome?: string;
}): Promise<ChatSkillTree> {
  const home = await ensureChatHome(input.chatHome);
  const currentProject = await resolveProjectContext(input.projectId, input.chatHome);
  const emptyRoot = await mkdtemp(join(tmpdir(), "chat-skill-tree-"));

  const personal = await loadScopedSkills({
    cwd: emptyRoot,
    agentDir: home.agentDir,
    pathRoots: [resolve(home.agentDir, "skills")],
  })
    .then((skills) => ({ skills }))
    .catch((error: unknown) => ({ skills: [] as readonly ChatSkillTreeEntry[], error: sectionError(error) }));

  const projects = await Promise.all((await listProjects(input.chatHome)).map(async (project) => {
    const base = {
      projectId: project.projectId,
      name: project.cachedName,
      path: project.path,
      available: project.available,
    };
    if (!project.available) return { ...base, skills: [] as readonly ChatSkillTreeEntry[] };
    try {
      const skills = await loadScopedSkills({
        cwd: project.path,
        agentDir: emptyRoot,
        additionalSkillPaths: [resolve(project.path, ".chat", "skills")],
        pathRoots: [project.path],
      });
      return { ...base, skills };
    } catch (error) {
      return { ...base, skills: [] as readonly ChatSkillTreeEntry[], error: sectionError(error) };
    }
  }));

  // listChatWorkflowDefinitions 是给浏览器的裁剪投影，必须用 Registry 的完整定义
  // （含 prepareAgentSession）才能解析出 Workflow 注入的私有 Skill。
  const workflows = await Promise.all(listChatWorkflowDefinitions().map(async (summary) => {
    const workflow = getChatWorkflowDefinition(summary.id);
    if (workflow === undefined) {
      return { workflowId: summary.id, name: summary.name, agents: [] };
    }
    return {
    workflowId: workflow.id,
    name: workflow.name,
    agents: await Promise.all(workflow.agents.map(async (agent) => {
      try {
        const inspection = await inspectWorkflowAgent({
          projectId: currentProject.projectId,
          chatHome: currentProject.chatHome,
          cwd: currentProject.cwd,
          workflowId: workflow.id,
          agentId: agent.id,
          stageId: workflow.nodes.find((node) => node.kind === "agent" && node.agentId === agent.id)?.id ?? agent.id,
          defaultAgent: agent,
          ...(workflow.prepareAgentSession === undefined
            ? {}
            : { prepareAgentSession: workflow.prepareAgentSession }),
        });
        return {
          agentId: agent.id,
          name: agent.name,
          skills: simplify(inspection.skills.filter((skill) => skill.owner === "injected")),
        };
      } catch (error) {
        return {
          agentId: agent.id,
          name: agent.name,
          skills: [] as readonly ChatSkillTreeEntry[],
          error: sectionError(error),
        };
      }
    })),
    };
  }));

  const registry = await readLongAgentRegistry(home.root);
  const longAgents = await Promise.all(registry.agents.map(async (agent) => {
    try {
      // S4：自有目录默认存在并接入；显式选择的跨域路径一并展示。
      const ownSkillsDir = resolve(longAgentConfigRoot(home.root, agent.id), "skills");
      const resources = agent.definition.resources;
      const extraPaths = resources.mode === "explicit" ? resources.skillPaths : [];
      const skills = await loadScopedSkills({
        cwd: emptyRoot,
        agentDir: emptyRoot,
        additionalSkillPaths: [ownSkillsDir, ...extraPaths],
        pathRoots: [ownSkillsDir, ...extraPaths],
      });
      return { longAgentId: agent.id, name: agent.name, skills };
    } catch (error) {
      return {
        longAgentId: agent.id,
        name: agent.name,
        skills: [] as readonly ChatSkillTreeEntry[],
        error: sectionError(error),
      };
    }
  }));

  return { schemaVersion: 1, personal, projects, workflows, longAgents };
}
