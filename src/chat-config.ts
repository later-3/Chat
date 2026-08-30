import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { ensureChatHome, resolveChatHome } from "./chat-home.js";
import { appendChatAuditEvent } from "./audit-log.js";
import { resolveProjectContext } from "./projects/registry.js";
import { getProjectTrust } from "./projects/trust.js";
import {
  parseAgentConfigSelection,
  type AgentConfigSelection,
} from "./workflows/agent-config.js";
import {
  DEFAULT_CHAT_WORKFLOW_ID,
  getChatWorkflowDefinition,
  type ChatWorkflowId,
} from "./workflows/registry.js";

export const CHAT_CONFIG_SCHEMA_VERSION = 1;
export const CHAT_CONFIG_FILE_NAME = "config.json";

export interface ChatStoredWorkflowConfig {
  readonly agents: Readonly<Record<string, AgentConfigSelection>>;
}

export interface ChatRootConfig {
  readonly schemaVersion: 1;
  readonly defaultWorkflowId: ChatWorkflowId;
  readonly workflows: Readonly<Record<string, ChatStoredWorkflowConfig>>;
}

export interface ChatConfigOverride {
  readonly schemaVersion: 1;
  readonly defaultWorkflowId?: ChatWorkflowId;
  readonly workflows?: Readonly<Record<string, ChatStoredWorkflowConfig>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownFields(value: Record<string, unknown>, fields: readonly string[], subject: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`${subject}包含未知字段: ${unknown.join(", ")}`);
}

/** Validates the single runtime configuration shared by Chat APIs and UI. */
export function parseChatRootConfig(value: unknown): ChatRootConfig {
  if (!isRecord(value) || value.schemaVersion !== CHAT_CONFIG_SCHEMA_VERSION) {
    throw new Error(`Chat配置必须使用schemaVersion ${CHAT_CONFIG_SCHEMA_VERSION}`);
  }
  assertKnownFields(value, ["schemaVersion", "defaultWorkflowId", "workflows"], "Chat配置");
  if (typeof value.defaultWorkflowId !== "string" || getChatWorkflowDefinition(value.defaultWorkflowId) === undefined) {
    throw new Error("Chat配置defaultWorkflowId无效");
  }
  if (!isRecord(value.workflows)) throw new Error("Chat配置workflows必须是对象");

  const workflows: Record<string, ChatStoredWorkflowConfig> = {};
  for (const [workflowId, rawWorkflow] of Object.entries(value.workflows)) {
    const workflow = getChatWorkflowDefinition(workflowId);
    if (workflow === undefined) throw new Error(`Chat配置包含不存在的Workflow: ${workflowId}`);
    if (!isRecord(rawWorkflow)) throw new Error(`Workflow ${workflowId}配置必须是对象`);
    assertKnownFields(rawWorkflow, ["agents"], `Workflow ${workflowId}配置`);
    if (!isRecord(rawWorkflow.agents)) throw new Error(`Workflow ${workflowId} agents必须是对象`);
    const availableAgentIds = new Set(workflow.agents.map((agent) => agent.id));
    const agents: Record<string, AgentConfigSelection> = {};
    for (const [agentId, rawSelection] of Object.entries(rawWorkflow.agents)) {
      if (!availableAgentIds.has(agentId)) {
        throw new Error(`Workflow ${workflowId}不存在Agent: ${agentId}`);
      }
      agents[agentId] = parseAgentConfigSelection(rawSelection);
    }
    workflows[workflowId] = { agents };
  }

  return {
    schemaVersion: CHAT_CONFIG_SCHEMA_VERSION,
    defaultWorkflowId: value.defaultWorkflowId as ChatWorkflowId,
    workflows,
  };
}

export function parseChatConfigOverride(value: unknown): ChatConfigOverride {
  if (!isRecord(value) || value.schemaVersion !== CHAT_CONFIG_SCHEMA_VERSION) {
    throw new Error(`Chat Project配置必须使用schemaVersion ${CHAT_CONFIG_SCHEMA_VERSION}`);
  }
  assertKnownFields(value, ["schemaVersion", "defaultWorkflowId", "workflows"], "Chat Project配置");
  const base = parseChatRootConfig({
    schemaVersion: 1,
    defaultWorkflowId: value.defaultWorkflowId ?? DEFAULT_CHAT_WORKFLOW_ID,
    workflows: value.workflows ?? {},
  });
  return {
    schemaVersion: 1,
    ...(value.defaultWorkflowId === undefined ? {} : { defaultWorkflowId: base.defaultWorkflowId }),
    ...(value.workflows === undefined ? {} : { workflows: base.workflows }),
  };
}

export function defaultChatRootConfig(): ChatRootConfig {
  return {
    schemaVersion: CHAT_CONFIG_SCHEMA_VERSION,
    defaultWorkflowId: DEFAULT_CHAT_WORKFLOW_ID,
    workflows: {},
  };
}

async function personalChatConfigPath(chatHome = resolveChatHome()): Promise<string> {
  return (await ensureChatHome(chatHome)).configPath;
}

async function writeValidatedConfig(path: string, config: ChatRootConfig | ChatConfigOverride): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export async function readChatRootConfig(chatHome = resolveChatHome()): Promise<ChatRootConfig> {
  const path = await personalChatConfigPath(chatHome);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const config = defaultChatRootConfig();
    await writeValidatedConfig(path, config);
    return config;
  }
  try {
    return parseChatRootConfig(JSON.parse(content));
  } catch (error) {
    throw new Error(`Chat配置无效: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeChatRootConfig(value: unknown, chatHome = resolveChatHome()): Promise<ChatRootConfig> {
  const config = parseChatRootConfig(value);
  await writeValidatedConfig(await personalChatConfigPath(chatHome), config);
  await appendChatAuditEvent({
    action: "config.update",
    target: { type: "personal", kind: "config" },
    details: { schemaVersion: config.schemaVersion, workflowCount: Object.keys(config.workflows).length },
  }, chatHome);
  return config;
}

async function readProjectOverride(projectId: string, chatHome = resolveChatHome()): Promise<ChatConfigOverride> {
  const project = await resolveProjectContext(projectId, chatHome);
  try {
    return parseChatConfigOverride(JSON.parse(await readFile(project.projectConfigPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 };
    throw new Error(
      `Chat Project配置无效: ${project.projectConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function writeProjectChatConfig(
  projectId: string,
  value: unknown,
  chatHome = resolveChatHome(),
): Promise<ChatConfigOverride> {
  const project = await resolveProjectContext(projectId, chatHome);
  if (!(await getProjectTrust(projectId, chatHome)).trusted) {
    throw new Error(`Project尚未信任，不能修改配置: ${projectId}`);
  }
  const config = parseChatConfigOverride(value);
  await writeValidatedConfig(project.projectConfigPath, config);
  await appendChatAuditEvent({
    action: "config.update",
    target: { type: "project", projectId, kind: "config" },
    details: { schemaVersion: config.schemaVersion, workflowCount: Object.keys(config.workflows ?? {}).length },
  }, chatHome);
  return config;
}

export async function resolveChatConfig(
  projectId: string,
  chatHome = resolveChatHome(),
): Promise<{
  personal: ChatRootConfig;
  project: ChatConfigOverride;
  projectTrusted: boolean;
  effective: ChatRootConfig;
}> {
  const [personal, declaredProject, trust] = await Promise.all([
    readChatRootConfig(chatHome),
    readProjectOverride(projectId, chatHome),
    getProjectTrust(projectId, chatHome),
  ]);
  const project = trust.trusted ? declaredProject : { schemaVersion: 1 as const };
  const workflows: Record<string, ChatStoredWorkflowConfig> = { ...personal.workflows };
  for (const [workflowId, override] of Object.entries(project.workflows ?? {})) {
    workflows[workflowId] = {
      agents: {
        ...(personal.workflows[workflowId]?.agents ?? {}),
        ...override.agents,
      },
    };
  }
  return {
    personal,
    project: declaredProject,
    projectTrusted: trust.trusted,
    effective: {
      schemaVersion: 1,
      defaultWorkflowId: project.defaultWorkflowId ?? personal.defaultWorkflowId,
      workflows,
    },
  };
}

export function getStoredAgentConfigs(
  config: ChatRootConfig,
  workflowId: string,
): Readonly<Record<string, AgentConfigSelection>> | undefined {
  const agents = config.workflows[workflowId]?.agents;
  return agents === undefined || Object.keys(agents).length === 0 ? undefined : agents;
}
