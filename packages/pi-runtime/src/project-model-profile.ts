import type { Model } from "@earendil-works/pi-ai";
import { BAILIAN_DEFAULT_BASE_URL } from "@chat/contracts";

export interface ProjectModelProfile {
  readonly profileVersion: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly endpointHost: string;
}

export class ProjectModelProfileError extends Error {
  readonly code = "project_model_profile_invalid";
  constructor(message: string) {
    super(message);
    this.name = "ProjectModelProfileError";
  }
}

/**
 * Project节点只依赖OpenAI-compatible模型Profile。默认Profile仍是本次验收使用的百炼，
 * 但provider/model/base URL/API Key来源均由服务端环境选择，不进入浏览器或产品合同。
 */
export function loadProjectModelProfile(
  env: Readonly<Record<string, string | undefined>>,
): ProjectModelProfile {
  const providerName = env.CHAT_PROJECT_MODEL_PROVIDER?.trim() || "bailian";
  const modelId = env.CHAT_PROJECT_MODEL_ID?.trim() || "qwen3.7-plus";
  const displayName = env.CHAT_PROJECT_MODEL_DISPLAY_NAME?.trim() || modelId;
  const profileVersion =
    env.CHAT_PROJECT_MODEL_PROFILE_VERSION?.trim() || `${providerName}.${modelId}.v1`;
  const baseUrl =
    env.CHAT_PROJECT_MODEL_BASE_URL?.trim() ||
    (providerName === "bailian" ? env.DASHSCOPE_BASE_URL?.trim() : undefined) ||
    BAILIAN_DEFAULT_BASE_URL;
  const apiKeyEnv = env.CHAT_PROJECT_MODEL_API_KEY_ENV?.trim() || "DASHSCOPE_API_KEY";
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(providerName)) {
    throw new ProjectModelProfileError("CHAT_PROJECT_MODEL_PROVIDER格式非法");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(modelId)) {
    throw new ProjectModelProfileError("CHAT_PROJECT_MODEL_ID格式非法");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+:/-]{0,127}$/u.test(displayName)) {
    throw new ProjectModelProfileError("CHAT_PROJECT_MODEL_DISPLAY_NAME格式非法");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(profileVersion)) {
    throw new ProjectModelProfileError("CHAT_PROJECT_MODEL_PROFILE_VERSION格式非法");
  }
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(apiKeyEnv)) {
    throw new ProjectModelProfileError("CHAT_PROJECT_MODEL_API_KEY_ENV格式非法");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProjectModelProfileError("CHAT_PROJECT_MODEL_BASE_URL不是合法URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new ProjectModelProfileError("Project模型Base URL必须是无凭据HTTPS URL");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ProjectModelProfileError("Project模型Base URL不能包含query或fragment");
  }
  const key = env[apiKeyEnv];
  return {
    profileVersion,
    providerName,
    modelId,
    displayName,
    apiKey: key !== undefined && key.trim() !== "" ? key : undefined,
    baseUrl,
    endpointHost: url.hostname,
  };
}

export function buildProjectModel(profile: ProjectModelProfile): Model<"openai-completions"> {
  const isQwen = profile.modelId.toLowerCase().includes("qwen");
  return {
    id: profile.modelId,
    name: profile.displayName,
    api: "openai-completions",
    provider: profile.providerName,
    baseUrl: profile.baseUrl,
    // Model只描述能力；候选节点通过请求选项统一关闭思考，确保强制结果工具可用。
    reasoning: isQwen,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8_192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      ...(isQwen ? { thinkingFormat: "qwen" as const } : {}),
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
      supportsLongCacheRetention: false,
    },
  };
}
