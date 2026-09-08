import {
  CHAT_WORKFLOW_IDS,
  DEFAULT_CHAT_WORKFLOW_ID,
  getChatWorkflowDefinition,
  type ChatWorkflowId,
} from "./workflows/registry.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  parseAgentConfigSelection,
  type AgentConfigSelection,
} from "./workflows/agent-config.js";
import { parseWorkflowImages } from "./workflows/image-input.js";

export const MAX_WORKFLOW_PROMPT_CHARS = 100_000;

export {
  CHAT_WORKFLOW_IDS,
  DEFAULT_CHAT_WORKFLOW_ID,
  type ChatWorkflowId,
};

export interface ChatWorkflowHttpInput {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly prompt: string;
  /** Optional image attachments (Pi ImageContent wire shape), execution-gated per Workflow. */
  readonly images?: readonly ImageContent[];
  readonly sessionId?: string;
  readonly workflow: ChatWorkflowId;
  readonly defaultAgentConfigs?: Readonly<Record<string, AgentConfigSelection>>;
  readonly agentConfigs?: Readonly<Record<string, AgentConfigSelection>>;
  /** Backend-internal provenance; the HTTP parser never accepts it from clients. */
  readonly delegatedByAgentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析启动Chat Workflow的JSON请求体。
 *
 * VS Code中的原有调试请求不发送请求体，因此继续使用默认Prompt和进程目录；
 * Pi Web会显式传入用户Prompt、工作目录和用户选择的Workflow。
 */
export function parseChatWorkflowHttpInput(
  value: unknown,
  defaults: ChatWorkflowHttpInput,
): ChatWorkflowHttpInput {
  if (value === undefined || value === null) return defaults;
  if (!isRecord(value)) throw new Error("请求体必须是JSON对象");

  const cwd = value.cwd ?? defaults.cwd;
  const projectId = value.projectId ?? defaults.projectId;
  const prompt = value.prompt ?? defaults.prompt;
  const sessionId = value.sessionId ?? defaults.sessionId;
  const workflow = value.workflow ?? defaults.workflow;
  const rawAgentConfigs = value.agentConfigs;
  const images = parseWorkflowImages(value.images);
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error("cwd必须是非空字符串");
  }
  if (projectId !== undefined && (typeof projectId !== "string" || projectId.trim() === "")) {
    throw new Error("projectId必须是非空字符串");
  }
  if (typeof prompt !== "string") {
    throw new Error("prompt必须是字符串");
  }
  const hasImages = images !== undefined && images.length > 0;
  // 图片可以单独成消息（纯图片输入），此时允许空文本Prompt。
  if (prompt.trim() === "" && !hasImages) {
    throw new Error("prompt必须是非空字符串");
  }
  if (prompt.length > MAX_WORKFLOW_PROMPT_CHARS) {
    throw new Error(`prompt不能超过${MAX_WORKFLOW_PROMPT_CHARS}个字符`);
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim() === "")) {
    throw new Error("sessionId必须是非空字符串");
  }
  if (typeof workflow !== "string") {
    throw new Error(`workflow必须是${CHAT_WORKFLOW_IDS.join("或")}`);
  }
  const definition = getChatWorkflowDefinition(workflow);
  if (definition === undefined) {
    throw new Error(`workflow必须是${CHAT_WORKFLOW_IDS.join("或")}`);
  }
  if (hasImages && definition.supportsImageInput !== true) {
    throw new Error(`Workflow ${workflow}暂不支持图片输入，请移除图片或切换Workflow后重试`);
  }
  let agentConfigs: Record<string, AgentConfigSelection> | undefined;
  if (rawAgentConfigs !== undefined) {
    if (!isRecord(rawAgentConfigs)) throw new Error("agentConfigs必须是对象");
    const agentIds = new Set(definition.agents.map((agent) => agent.id));
    agentConfigs = {};
    for (const [agentId, selection] of Object.entries(rawAgentConfigs)) {
      if (!agentIds.has(agentId)) throw new Error(`Workflow ${workflow}不存在Agent: ${agentId}`);
      agentConfigs[agentId] = parseAgentConfigSelection(selection);
    }
  }

  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(defaults.chatHome === undefined ? {} : { chatHome: defaults.chatHome }),
    cwd,
    prompt,
    workflow: workflow as ChatWorkflowId,
    ...(images === undefined ? {} : { images }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(defaults.defaultAgentConfigs === undefined ? {} : { defaultAgentConfigs: defaults.defaultAgentConfigs }),
    ...(agentConfigs === undefined ? {} : { agentConfigs }),
  };
}
