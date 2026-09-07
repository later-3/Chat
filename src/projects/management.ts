import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { listProjects, openProject, readProjectRegistry, resolveProjectContext, updateProjectManifest } from "./registry.js";
import { createManagedProject } from "./managed-create.js";
import { ProjectManagementError, type ProjectSearchInput, type ProjectReadInput, type ProjectCreateInput, type ProjectOpenInput, type ProjectUpdateInput, type ProjectConfigureInput } from "./management-contract.js";
import { assertFileWithin, contentRevision, fileRevision, withFileLock } from "../persistence/versioned-file.js";
import { resolveChatConfig } from "../chat-config.js";
import { agentModelConfigPath, readAgentDurableConfig } from "../workflows/agent-model-config.js";
import { listChatWorkflowDefinitions } from "../workflows/registry.js";
import { listChatSystemTools } from "../tools/registry.js";
import { listPiSkills } from "../resources/skills.js";
import { configureProject, projectModelRuntime, requireWorkflowAgent } from "./configuration-management.js";
import type { ChatToolRuntimeContext } from "../tools/framework.js";
import type { ChatProjectContext } from "./types.js";

function summary(project: ChatProjectContext) {
  return { projectId: project.projectId, name: project.name, description: project.description, available: true };
}
function navigation(project: ChatProjectContext) {
  return { projectId: project.projectId, action: "new-session", url: `/?cwd=${encodeURIComponent(project.cwd)}` };
}
async function target(context: ChatToolRuntimeContext, projectId?: string) {
  const id = projectId ?? context.projectId;
  const entry = (await readProjectRegistry(context.chatHome)).projects.find((project) => project.projectId === id);
  if (entry === undefined) throw new ProjectManagementError("PROJECT_NOT_FOUND", "Project尚未登记");
  try { return await resolveProjectContext(id, context.chatHome); }
  catch { throw new ProjectManagementError("PROJECT_UNAVAILABLE", "Project路径不可用或身份不匹配；请重新打开正确目录"); }
}
function page<T>(items: readonly T[], cursor?: string, limit = 20) {
  if (cursor !== undefined && !/^(0|[1-9][0-9]*)$/.test(cursor)) throw new ProjectManagementError("INVALID_INPUT", "分页cursor无效");
  const offset = Number(cursor ?? 0);
  if (!Number.isSafeInteger(offset) || offset > items.length) throw new ProjectManagementError("INVALID_INPUT", "分页cursor已失效，请重新查询");
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
}

export async function searchProjects(input: ProjectSearchInput, context: ChatToolRuntimeContext) {
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const projects = await listProjects(context.chatHome);
  return page(projects.filter((p) => `${p.cachedName}\n${p.cachedDescription}`.toLocaleLowerCase().includes(query))
    .map((p) => ({ projectId: p.projectId, name: p.cachedName, description: p.cachedDescription, available: p.available, current: p.projectId === context.projectId })), input.cursor, input.limit);
}

export async function readProject(input: ProjectReadInput, context: ChatToolRuntimeContext) {
  const id = input.projectId ?? context.projectId;
  if ((input.workflowId === undefined) !== (input.agentId === undefined)) throw new ProjectManagementError("INVALID_INPUT", "workflowId和agentId必须一起提供");
  if (input.view === undefined || input.view === "summary") {
    const entry = (await listProjects(context.chatHome)).find((p) => p.projectId === id);
    if (entry === undefined) throw new ProjectManagementError("PROJECT_NOT_FOUND", "Project尚未登记");
    if (!entry.available) return { status: "unavailable", project: { projectId: id, name: entry.cachedName, description: entry.cachedDescription, available: false } };
    const project = await target(context, id);
    const manifestPath = resolve(project.projectConfigDir, "project.json");
    return withFileLock(manifestPath, async () => {
      await assertFileWithin(manifestPath, project.projectRoot);
      const current = await target(context, id);
      return { status: "ready", project: summary(current), revision: await fileRevision(manifestPath), navigation: navigation(current) };
    });
  }
  const project = await target(context, id);
  if (input.workflowId !== undefined && input.agentId !== undefined) requireWorkflowAgent(input.workflowId, input.agentId);
  if (input.view === "configuration") {
    const configuration = await withFileLock(project.projectConfigPath, async () => {
      await assertFileWithin(project.projectConfigPath, project.projectRoot);
      return { ...await resolveChatConfig(id, context.chatHome), revision: await fileRevision(project.projectConfigPath) };
    });
    let agent;
    if (input.workflowId !== undefined && input.agentId !== undefined) {
      const { workflowId, agentId } = input;
      const path = agentModelConfigPath(project.projectDataDir, workflowId, agentId);
      agent = await withFileLock(path, async () => ({
        workflowId, agentId, configuration: await readAgentDurableConfig(project.projectDataDir, workflowId, agentId) ?? null,
        revision: await fileRevision(path),
      }));
    }
    return { status: "ready", project: summary(project), configuration, agent: agent ?? null,
      editable: { project: ["defaultWorkflowId", "workflows.<workflowId>.agents.<agentId>", "sessions.removedRetentionDays"], workflowAgent: ["model", "thinkingLevel", "tools"] },
      diagnostics: ["effective为Project默认配置，不包含已有Session选择；Workflow Agent配置不改变Long Agent定义。"] };
  }
  const [runtime, skills] = await Promise.all([projectModelRuntime(project), listPiSkills(project.cwd, project.projectId, project.chatHome)]);
  const items = [
    ...listChatWorkflowDefinitions().map((workflow) => ({ kind: "workflow", ...workflow })),
    ...listChatSystemTools().map((tool) => ({ kind: "tool", address: tool.address, name: tool.manifest.name, description: tool.manifest.description,
      grantable: context.authorizedToolAddresses?.includes(tool.address) ?? false })),
    ...skills.skills.map((skill) => ({ kind: "skill", ...skill })),
    ...runtime.getModels().filter((model) => runtime.hasConfiguredAuth(model.provider)).map((model) => ({ kind: "model", provider: model.provider, modelId: model.id, name: model.name })),
  ];
  return { status: "ready", project: summary(project), ...page(items, input.cursor), diagnostics: skills.diagnostics };
}

export async function createProject(input: ProjectCreateInput, context: ChatToolRuntimeContext) {
  const result = await createManagedProject(input, context.chatHome, context.sessionId);
  return { status: result.status, project: summary(result.project), navigation: navigation(result.project) };
}

export async function openProjectForAgent(input: ProjectOpenInput, context: ChatToolRuntimeContext) {
  let path: string;
  try { path = await realpath(input.path); }
  catch { throw new ProjectManagementError("PROJECT_UNAVAILABLE", "目录不存在或不可访问"); }
  // Only an exact previously opened root is a trusted directory grant. Parent membership is insufficient.
  const registered = (await readProjectRegistry(context.chatHome)).projects.find((entry) => entry.path === path);
  if (registered === undefined) throw new ProjectManagementError("PATH_NOT_ALLOWED", "请先在Chat项目选择器中打开此目录，再调用project_open");
  const existing = await target(context, registered.projectId);
  const project = await openProject({ path: existing.projectRoot, chatHome: context.chatHome });
  return { status: "existing", project: summary(project), navigation: navigation(project) };
}

export async function updateProject(input: ProjectUpdateInput, context: ChatToolRuntimeContext) {
  if (input.changes.name !== undefined && !input.changes.name.trim()) throw new ProjectManagementError("INVALID_INPUT", "Project名称不能为空");
  const current = await target(context, input.projectId);
  const project = await updateProjectManifest(current.projectId, input.changes, input.expectedRevision, context.chatHome);
  return { status: "updated", project: summary(project), revision: contentRevision(`${JSON.stringify({ schemaVersion: 1, id: project.projectId, name: project.name, description: project.description }, null, 2)}\n`) };
}

export async function updateProjectConfiguration(input: ProjectConfigureInput, context: ChatToolRuntimeContext) {
  const project = await target(context, input.projectId);
  return { ...await configureProject(input, project, context), project: summary(project) };
}
