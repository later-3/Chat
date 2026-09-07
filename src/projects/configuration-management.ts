import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSkills, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mutateProjectChatConfig, parseChatConfigOverride, readChatRootConfig, type ChatConfigOverride } from "../chat-config.js";
import { mutateAgentDurableConfig, parseDurableConfig } from "../workflows/agent-model-config.js";
import { resolveWorkflowAgentDefinition } from "../workflows/agent-config-loader.js";
import { getChatWorkflowDefinition } from "../workflows/registry.js";
import type { WorkflowAgentDefinition } from "../workflows/agent-config.js";
import type { ChatToolRuntimeContext } from "../tools/framework.js";
import { listChatSystemTools } from "../tools/registry.js";
import { contentRevision } from "../persistence/versioned-file.js";
import { ProjectManagementError, type ProjectConfigureInput } from "./management-contract.js";
import type { ChatProjectContext } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const unsafe = new Set(["__proto__", "prototype", "constructor", "schemaVersion"]);

/** Patches named fields, never array indices or arbitrary files. Schema parsing follows this step. */
export function applyConfigOperations(current: unknown, operations: ProjectConfigureInput["operations"]): Record<string, unknown> {
  const value: unknown = structuredClone(current);
  if (!record(value)) throw new ProjectManagementError("INVALID_CONFIG", "配置必须是对象");
  const paths: string[][] = [];
  for (const operation of operations) {
    const path = operation.path;
    if (path.some((part) => unsafe.has(part) || /^\d+$/.test(part))) throw new ProjectManagementError("INVALID_CONFIG", "配置路径包含保留字段或数组索引");
    if (paths.some((other) => other.slice(0, Math.min(other.length, path.length)).every((part, i) => part === path[i]))) {
      throw new ProjectManagementError("INVALID_CONFIG", "配置操作路径重复或父子冲突");
    }
    paths.push(path);
    let node = value;
    const parents: { node: Record<string, unknown>; key: string }[] = [];
    let missing = false;
    for (const part of path.slice(0, -1)) {
      if (!Object.hasOwn(node, part)) {
        if (operation.op === "unset") { missing = true; break; }
        node[part] = {};
      }
      const child = node[part];
      if (!record(child)) throw new ProjectManagementError("INVALID_CONFIG", "配置路径不能穿过数组或标量");
      parents.push({ node, key: part });
      node = child;
    }
    if (missing) continue;
    const field = path.at(-1);
    if (field === undefined) throw new ProjectManagementError("INVALID_CONFIG", "配置路径不能为空");
    if (operation.op === "unset") {
      delete node[field];
      // Empty Agent selections would shadow Personal defaults instead of inheriting them.
      for (const parent of parents.reverse()) {
        const child = parent.node[parent.key];
        if (record(child) && Object.keys(child).length === 0) delete parent.node[parent.key];
        else break;
      }
    }
    else node[field] = structuredClone(operation.value);
  }
  return value;
}

export function requireWorkflowAgent(workflowId: string, agentId: string): WorkflowAgentDefinition {
  const agent = getChatWorkflowDefinition(workflowId)?.agents.find((item) => item.id === agentId);
  if (agent === undefined) throw new ProjectManagementError("INVALID_CONFIG", "找不到指定的Workflow或Agent");
  return agent;
}

export async function projectModelRuntime(project: ChatProjectContext) {
  return ModelRuntime.create({ authPath: resolve(project.agentDir, "auth.json"), modelsPath: resolve(project.agentDir, "models.json") });
}

async function validateDefinition(next: WorkflowAgentDefinition, previous: WorkflowAgentDefinition, project: ChatProjectContext, context: ChatToolRuntimeContext) {
  const known = new Set(listChatSystemTools().map((tool) => tool.address));
  const oldAddresses = new Set(previous.tools.mode === "none" ? [] : previous.tools.addresses ?? []);
  for (const address of next.tools.mode === "none" ? [] : next.tools.addresses ?? []) {
    if (!known.has(address)) throw new ProjectManagementError("INVALID_CONFIG", `找不到系统Tool: ${address}`);
    if (!oldAddresses.has(address) && !context.authorizedToolAddresses?.includes(address)) {
      throw new ProjectManagementError("PATH_NOT_ALLOWED", "不能授予当前Agent未获授权的系统Tool；请在配置页面选择");
    }
  }
  if (next.tools.mode === "explicit") {
    const permitted = new Set(context.authorizedToolNames ?? []);
    if (previous.tools.mode === "explicit") previous.tools.names.forEach((name) => permitted.add(name));
    for (const name of next.tools.names) {
      if (!permitted.has(name)) throw new ProjectManagementError("INVALID_CONFIG", `Tool未获授权或不存在: ${name}`);
    }
  } else if (next.tools.mode === "pi-default" && previous.tools.mode !== "pi-default"
    && !["read", "bash", "edit", "write"].every((name) => context.authorizedToolNames?.includes(name))) {
    throw new ProjectManagementError("PATH_NOT_ALLOWED", "当前Agent不能启用完整Pi默认Tool集");
  }
  if (next.model !== undefined) {
    const runtime = await projectModelRuntime(project);
    const model = runtime.getModel(next.model.provider, next.model.modelId);
    if (model === undefined || !runtime.hasConfiguredAuth(model.provider)) throw new ProjectManagementError("INVALID_CONFIG", "模型不存在或Provider未配置认证");
  }
  if (next.resources.mode === "explicit") {
    for (const path of next.resources.skillPaths) {
      try {
        await stat(path);
        const loaded = loadSkills({ cwd: project.cwd, agentDir: project.agentDir, skillPaths: [path], includeDefaults: false });
        if (loaded.skills.length === 0) throw new Error("没有有效Skill");
      }
      catch { throw new ProjectManagementError("RESOURCE_UNAVAILABLE", "选择的Skill路径不存在"); }
    }
    // Code-bearing resources require an existing trusted selection, not a prompt granting itself code execution.
    const oldResources = previous.resources.mode === "explicit" ? previous.resources : undefined;
    for (const path of next.resources.extensionPaths) {
      await realpath(path);
      if (!oldResources?.extensionPaths.includes(path)) throw new ProjectManagementError("PATH_NOT_ALLOWED", "新增Extension请通过资源配置入口授权");
    }
    for (const source of next.resources.pluginSources) {
      if (!oldResources?.pluginSources.includes(source)) throw new ProjectManagementError("PATH_NOT_ALLOWED", "新增Plugin请通过资源配置入口授权");
    }
  }
}

async function validateProjectConfig(next: ChatConfigOverride, previous: ChatConfigOverride, project: ChatProjectContext, context: ChatToolRuntimeContext) {
  const personal = await readChatRootConfig(project.chatHome);
  for (const [workflowId, workflowConfig] of Object.entries(next.workflows ?? {})) {
    for (const [agentId, selection] of Object.entries(workflowConfig.agents)) {
      const defaultAgent = requireWorkflowAgent(workflowId, agentId);
      const before = previous.workflows?.[workflowId]?.agents[agentId] ?? personal.workflows[workflowId]?.agents[agentId];
      const base = { defaultAgent, cwd: project.cwd, chatHome: project.chatHome };
      const [resolved, old] = await Promise.all([
        resolveWorkflowAgentDefinition({ ...base, selection }),
        resolveWorkflowAgentDefinition({ ...base, ...(before === undefined ? {} : { selection: before }) }),
      ]);
      await validateDefinition(resolved, old, project, context);
    }
  }
}

export async function configureProject(input: ProjectConfigureInput, project: ChatProjectContext, context: ChatToolRuntimeContext) {
  const options = { expectedRevision: input.expectedRevision, validateOnly: input.validateOnly ?? false };
  let config: unknown;
  if (input.target.kind === "project") {
    config = await mutateProjectChatConfig(project.projectId, async (current) => {
      const next = parseChatConfigOverride(applyConfigOperations(current, input.operations));
      await validateProjectConfig(next, current, project, context);
      return next;
    }, project.chatHome, options);
  } else {
    const { workflowId, agentId } = input.target;
    const defaultAgent = requireWorkflowAgent(workflowId, agentId);
    config = await mutateAgentDurableConfig(project.projectDataDir, workflowId, agentId, async (current) => {
      const next = applyConfigOperations(current ?? { schemaVersion: 1 }, input.operations);
      if (Object.keys(next).length === 1) return undefined;
      const parsed = parseDurableConfig(next, "Project Tool");
      await validateDefinition({ ...defaultAgent, ...parsed }, { ...defaultAgent, ...current }, project, context);
      return parsed;
    }, options);
  }
  return {
    status: input.validateOnly === true ? "validated" : "updated",
    target: input.target,
    configuration: config ?? null,
    revision: input.validateOnly === true ? input.expectedRevision : config === undefined ? "absent" : contentRevision(`${JSON.stringify(config, null, 2)}\n`),
    changes: input.operations.map(({ op, path: field }) => ({ op, path: field })),
    diagnostics: ["配置用于后续解析；当前Turn和已有Session选择不变。Long Agent的Personal定义不受影响。"],
  };
}
