import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { PROVIDER_MODEL, PROVIDER_NAME } from "@chat/contracts";
import { classifyProviderError, type StableProviderErrorCode } from "./errors.js";

/**
 * 共享的pi Agent loop执行器。
 *
 * 边界：
 * - Planner/Executor都必须实际经过pi Agent loop；不得用普通OpenAI SDK请求冒充。
 * - 模型只看到system/user prompt与唯一的内部结果收集工具；
 *   工具execute内再次用Chat Zod合同校验，参数先经过pi/TypeBox入口校验。
 * - 付费调用不自动重试：每次运行最多一次Agent loop。
 * - 不记录Prompt、消息正文、工具参数正文或隐藏推理。
 */

export interface ProviderCallMeta {
  readonly httpStatus?: number;
  readonly providerRequestId?: string;
}

export interface AgentRunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type AgentRunResult<TCandidate> =
  | {
      readonly kind: "candidate";
      readonly candidate: TCandidate;
      readonly usage: AgentRunUsage;
      readonly durationMs: number;
      readonly providerMeta: ProviderCallMeta;
    }
  | {
      readonly kind: "invalid_candidate";
      readonly errorCode:
        "no_tool_call" | "multiple_tool_calls" | "schema_invalid" | "capability_violation";
      readonly durationMs: number;
      readonly providerMeta: ProviderCallMeta;
    }
  | {
      readonly kind: "provider_failed";
      readonly errorCode: StableProviderErrorCode;
      readonly durationMs: number;
      readonly providerMeta: ProviderCallMeta;
    };

export interface RunAgentWithToolOptions<TCandidate> {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly tool: AgentTool;
  /** 把工具参数转换为候选；schema非法与能力越界分别进入稳定错误码。 */
  readonly parseCandidate: (
    params: unknown,
  ) =>
    | { readonly ok: true; readonly candidate: TCandidate }
    | { readonly ok: false; readonly errorCode: "schema_invalid" | "capability_violation" };
  readonly timeoutMs: number;
  readonly maxTokens?: number;
  /** 确定性测试注入：替代真实百炼流；生产必须缺省，不得用于伪造真实验收。 */
  readonly streamFnOverride?: StreamFn;
}

export function buildBailianModel(baseUrl: string): Model<"openai-completions"> {
  return {
    id: PROVIDER_MODEL,
    name: "Qwen3.7 Plus",
    api: "openai-completions",
    provider: PROVIDER_NAME,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8_192,
  };
}

export async function runAgentWithTool<TCandidate>(
  options: RunAgentWithToolOptions<TCandidate>,
): Promise<AgentRunResult<TCandidate>> {
  const startedAt = performance.now();
  const providerMeta: { httpStatus?: number; providerRequestId?: string } = {};
  const model = buildBailianModel(options.baseUrl);

  const streamFn: StreamFn =
    options.streamFnOverride ??
    ((_streamModel, context, streamOptions) =>
      streamSimple(model, context, {
        ...streamOptions,
        apiKey: options.apiKey,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        onResponse: (response) => {
          providerMeta.httpStatus = response.status;
          const requestId = response.headers["x-request-id"];
          if (requestId !== undefined && /^[A-Za-z0-9-]{1,128}$/.test(requestId)) {
            providerMeta.providerRequestId = requestId;
          }
        },
      }));

  let validCalls = 0;
  let invalidSchemaCalls = 0;
  let capabilityViolations = 0;
  let candidate: TCandidate | undefined;

  const tool: AgentTool = {
    ...options.tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const parsed = options.parseCandidate(params);
      if (!parsed.ok) {
        if (parsed.errorCode === "capability_violation") capabilityViolations += 1;
        else invalidSchemaCalls += 1;
        // 非法候选不交给模型自我修正：整个运行按MODEL_CANDIDATE_INVALID失败关闭
        return {
          content: [{ type: "text", text: "candidate rejected by server contract" }],
          details: undefined,
          terminate: true,
        };
      }
      validCalls += 1;
      candidate = parsed.candidate;
      return options.tool.execute(toolCallId, params, signal, onUpdate);
    },
  };

  const agent = new Agent({
    initialState: { model, systemPrompt: options.systemPrompt, tools: [tool] },
    streamFn,
    getApiKey: () => options.apiKey,
    toolExecution: "sequential",
  });

  const timer = setTimeout(() => agent.abort(), options.timeoutMs);
  try {
    await agent.prompt(options.userPrompt);
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    return {
      kind: "provider_failed",
      errorCode: classifyProviderError(error instanceof Error ? error.message : String(error)),
      durationMs,
      providerMeta,
    };
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const messages = agent.state.messages;
  const lastAssistant = [...messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant");
  if (lastAssistant !== undefined && lastAssistant.stopReason === "error") {
    return {
      kind: "provider_failed",
      errorCode: classifyProviderError(lastAssistant.errorMessage ?? ""),
      durationMs,
      providerMeta,
    };
  }
  if (lastAssistant !== undefined && lastAssistant.stopReason === "aborted") {
    return {
      kind: "provider_failed",
      errorCode: "provider.timeout",
      durationMs,
      providerMeta,
    };
  }

  if (validCalls === 1 && candidate !== undefined) {
    const usage: AgentRunUsage = {
      inputTokens: lastAssistant?.usage.input ?? 0,
      outputTokens: lastAssistant?.usage.output ?? 0,
    };
    return { kind: "candidate", candidate, usage, durationMs, providerMeta };
  }
  if (validCalls > 1) {
    return {
      kind: "invalid_candidate",
      errorCode: "multiple_tool_calls",
      durationMs,
      providerMeta,
    };
  }
  if (capabilityViolations > 0) {
    return {
      kind: "invalid_candidate",
      errorCode: "capability_violation",
      durationMs,
      providerMeta,
    };
  }
  if (invalidSchemaCalls > 0) {
    return { kind: "invalid_candidate", errorCode: "schema_invalid", durationMs, providerMeta };
  }
  return { kind: "invalid_candidate", errorCode: "no_tool_call", durationMs, providerMeta };
}
