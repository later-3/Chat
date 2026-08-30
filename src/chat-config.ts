import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatDataLayout } from "./chat-data.js";
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

export function defaultChatRootConfig(): ChatRootConfig {
  return {
    schemaVersion: CHAT_CONFIG_SCHEMA_VERSION,
    defaultWorkflowId: DEFAULT_CHAT_WORKFLOW_ID,
    workflows: {},
  };
}

async function chatConfigPath(): Promise<string> {
  return resolve((await ensureChatDataLayout()).root, CHAT_CONFIG_FILE_NAME);
}

async function writeValidatedChatRootConfig(config: ChatRootConfig): Promise<void> {
  const path = await chatConfigPath();
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

export async function readChatRootConfig(): Promise<ChatRootConfig> {
  const path = await chatConfigPath();
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const config = defaultChatRootConfig();
    await writeValidatedChatRootConfig(config);
    return config;
  }
  try {
    return parseChatRootConfig(JSON.parse(content));
  } catch (error) {
    throw new Error(`Chat配置无效: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeChatRootConfig(value: unknown): Promise<ChatRootConfig> {
  const config = parseChatRootConfig(value);
  await writeValidatedChatRootConfig(config);
  return config;
}

export function getStoredAgentConfigs(
  config: ChatRootConfig,
  workflowId: string,
): Readonly<Record<string, AgentConfigSelection>> | undefined {
  const agents = config.workflows[workflowId]?.agents;
  return agents === undefined || Object.keys(agents).length === 0 ? undefined : agents;
}
