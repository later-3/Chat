import {
  CHAT_WORKFLOW_IDS,
  DEFAULT_CHAT_WORKFLOW_ID,
  getChatWorkflowDefinition,
  type ChatWorkflowId,
} from "./workflows/registry.js";
import {
  parseAgentConfigSelection,
  type AgentConfigSelection,
} from "./workflows/agent-config.js";

export const MAX_WORKFLOW_PROMPT_CHARS = 100_000;

export {
  CHAT_WORKFLOW_IDS,
  DEFAULT_CHAT_WORKFLOW_ID,
  type ChatWorkflowId,
};

export interface ChatWorkflowHttpInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly workflow: ChatWorkflowId;
  readonly agentConfigs?: Readonly<Record<string, AgentConfigSelection>>;
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
  const prompt = value.prompt ?? defaults.prompt;
  const sessionId = value.sessionId ?? defaults.sessionId;
  const workflow = value.workflow ?? defaults.workflow;
  const rawAgentConfigs = value.agentConfigs;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error("cwd必须是非空字符串");
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("prompt必须是非空字符串");
  }
  if (prompt.length > MAX_WORKFLOW_PROMPT_CHARS) {
    throw new Error(`prompt不能超过${MAX_WORKFLOW_PROMPT_CHARS}个字符`);
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim() === "")) {
    throw new Error("sessionId必须是非空字符串");
  }
  if (typeof workflow !== "string" || getChatWorkflowDefinition(workflow) === undefined) {
    throw new Error(`workflow必须是${CHAT_WORKFLOW_IDS.join("或")}`);
  }
  let agentConfigs: Record<string, AgentConfigSelection> | undefined = defaults.agentConfigs === undefined
    ? undefined
    : { ...defaults.agentConfigs };
  if (rawAgentConfigs !== undefined) {
    if (!isRecord(rawAgentConfigs)) throw new Error("agentConfigs必须是对象");
    const definition = getChatWorkflowDefinition(workflow);
    const agentIds = new Set(definition?.agents.map((agent) => agent.id) ?? []);
    agentConfigs ??= {};
    for (const [agentId, selection] of Object.entries(rawAgentConfigs)) {
      if (!agentIds.has(agentId)) throw new Error(`Workflow ${workflow}不存在Agent: ${agentId}`);
      agentConfigs[agentId] = parseAgentConfigSelection(selection);
    }
  }

  return {
    cwd,
    prompt,
    workflow: workflow as ChatWorkflowId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentConfigs === undefined ? {} : { agentConfigs }),
  };
}
