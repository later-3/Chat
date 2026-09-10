import type { KnownApi, ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Chat 支持的 Thinking Level 与模型 API 的唯一事实源。
 * Frontend、Backend 校验和模型配置编辑器都必须从这里（或 `/api/models`、
 * `/api/models-config` 的响应）获取，不允许在任何一端维护第二份清单。
 * 取值类型锚定 Pi 的枚举：Pi 移除或重命名取值时 TypeScript 编译失败；
 * Pi 新增取值时需要在这里显式评估后加入。
 */
export const CHAT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

export type ChatThinkingLevel = typeof CHAT_THINKING_LEVELS[number];

/**
 * 模型配置编辑器提供的 API 选项。models.json 仍允许 Pi Extension 注册的自定义
 * API 字符串（由 ModelRuntime 在读取时校验），这里只约束编辑器给出的候选。
 */
export const CHAT_MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
  "pi-messages",
] as const satisfies readonly KnownApi[];

export type ChatModelApi = typeof CHAT_MODEL_APIS[number];

/** `/api/models-config` 响应中随文档一起下发的编辑器能力清单。 */
export const CHAT_MODEL_CAPABILITIES = {
  thinkingLevels: CHAT_THINKING_LEVELS,
  modelApis: CHAT_MODEL_APIS,
} as const;
