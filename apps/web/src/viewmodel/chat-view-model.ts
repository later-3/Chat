/**
 * 会话区本地View Model。
 * P1.1消息只做本地即时上屏（内存态，刷新即丢），不代表服务端已保存；
 * 消息持久化属于P1.3，真实模型列表属于P1.7。
 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  localOnly?: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
}

/** 开发fixture：界面联调用的示例模型列表，未连接任何真实Provider。 */
export const MODEL_FIXTURES: readonly ModelOption[] = [
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gemini-3-pro", label: "Gemini 3 Pro" },
];

export const DEFAULT_MODEL_ID = MODEL_FIXTURES[0]?.id ?? "";

const MODEL_STORAGE_KEY = "chat-model";

/** 读取保存的模型偏好；不在fixture列表中则回退默认。 */
export function readStoredModelId(
  storage: Pick<Storage, "getItem">,
  models: readonly ModelOption[] = MODEL_FIXTURES,
): string {
  const value = storage.getItem(MODEL_STORAGE_KEY);
  if (value && models.some((model) => model.id === value)) {
    return value;
  }
  return models[0]?.id ?? "";
}

export function persistModelId(modelId: string, storage: Pick<Storage, "setItem">): void {
  storage.setItem(MODEL_STORAGE_KEY, modelId);
}
