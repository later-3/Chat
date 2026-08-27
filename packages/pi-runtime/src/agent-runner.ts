import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  streamSimple,
  type OpenAICompletionsOptions,
} from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessage, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
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
  readonly providerStopReason?: AssistantMessage["stopReason"];
  readonly toolCallCount?: number;
}

export interface AgentRunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CandidateValidationDiagnostics {
  readonly stage: "tool_argument_schema" | "candidate_contract" | "capability_policy";
  /** 只允许合同字段名，不包含字段值、正文或Provider原始错误。 */
  readonly fields: readonly string[];
  readonly issueCodes: readonly string[];
}

export type AgentRunResult<TCandidate> =
  | {
      readonly kind: "candidate";
      readonly candidate: TCandidate;
      readonly usage?: AgentRunUsage;
      readonly durationMs: number;
      readonly providerCallCount: number;
      readonly providerMeta: ProviderCallMeta;
    }
  | {
      readonly kind: "invalid_candidate";
      readonly errorCode:
        "no_tool_call" | "multiple_tool_calls" | "schema_invalid" | "capability_violation";
      readonly durationMs: number;
      readonly providerCallCount: number;
      readonly usage?: AgentRunUsage;
      readonly providerMeta: ProviderCallMeta;
      readonly diagnostics?: CandidateValidationDiagnostics;
    }
  | {
      readonly kind: "provider_failed";
      readonly errorCode: StableProviderErrorCode;
      readonly durationMs: number;
      readonly providerCallCount: number;
      readonly usage?: AgentRunUsage;
      readonly providerMeta: ProviderCallMeta;
    };

export interface RunAgentWithToolOptions<TCandidate> {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** 缺省保持冻结的B2百炼模型；特殊节点可由服务端Model Profile注入。 */
  readonly model?: Model<"openai-completions">;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly tool: AgentTool;
  /** 把工具参数转换为候选；schema非法与能力越界分别进入稳定错误码。 */
  readonly parseCandidate: (params: unknown) =>
    | { readonly ok: true; readonly candidate: TCandidate }
    | {
        readonly ok: false;
        readonly errorCode: "schema_invalid" | "capability_violation";
        readonly diagnostics?: {
          readonly fields: readonly string[];
          readonly issueCodes: readonly string[];
        };
      };
  readonly timeoutMs: number;
  /** B2只允许单次Provider请求；工具无论成功或拒绝都terminate。 */
  readonly maxTurns: number;
  readonly maxProviderRequests: number;
  readonly maxTokens: number;
  /** 首个真实Provider流即将创建时触发；用于精确Trace/费用计数。 */
  readonly onProviderRequestStart?: () => void;
  /** 确定性测试注入：替代真实百炼流；生产必须缺省，不得用于伪造真实验收。 */
  readonly streamFnOverride?: StreamFn;
}

/**
 * pi的openai-completions运行时会从simple options转发toolChoice，但0.82.1的
 * SimpleStreamOptions声明尚未暴露该字段。这里用Provider专属类型补齐静态合同，
 * 避免把百炼兼容参数扩散到通用Agent Port。
 */
type ToolForcedStreamOptions = SimpleStreamOptions & Pick<OpenAICompletionsOptions, "toolChoice">;

export function buildBailianModel(baseUrl: string): Model<"openai-completions"> {
  return {
    id: PROVIDER_MODEL,
    name: "Qwen3.7 Plus",
    api: "openai-completions",
    provider: PROVIDER_NAME,
    baseUrl,
    // reasoning表示模型具备可切换思考能力；具体候选节点在请求选项中关闭它。
    reasoning: true,
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
      thinkingFormat: "qwen",
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
      supportsLongCacheRetention: false,
    },
  };
}

function usageFrom(message: AssistantMessage | undefined): AgentRunUsage | undefined {
  if (message === undefined) return undefined;
  const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  const outputTokens = message.usage.output;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, outputTokens };
}

function requestIdFrom(headers: Readonly<Record<string, string>>): string | undefined {
  for (const name of ["x-request-id", "x-dashscope-request-id", "request-id"]) {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    if (value !== undefined && /^[A-Za-z0-9-]{1,128}$/.test(value)) return value;
  }
  return undefined;
}

function responseIdFrom(message: AssistantMessage): string | undefined {
  const value = message.responseId;
  return value !== undefined && /^[A-Za-z0-9-]{1,128}$/.test(value) ? value : undefined;
}

function safeCandidateDiagnostics(
  stage: CandidateValidationDiagnostics["stage"],
  value?: { readonly fields: readonly string[]; readonly issueCodes: readonly string[] },
): CandidateValidationDiagnostics {
  const safe = (items: readonly string[]) =>
    [...new Set(items)].filter((item) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item)).slice(0, 12);
  return {
    stage,
    fields: safe(value?.fields ?? []),
    issueCodes: safe(value?.issueCodes ?? []),
  };
}

export async function runAgentWithTool<TCandidate>(
  options: RunAgentWithToolOptions<TCandidate>,
): Promise<AgentRunResult<TCandidate>> {
  if (options.maxTurns !== 1 || options.maxProviderRequests !== 1) {
    throw new Error("B2 pi节点只允许一次Turn和一次Provider请求");
  }
  if (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0) {
    throw new Error("B2 pi节点必须配置正整数maxTokens");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("B2 pi节点必须配置正整数timeoutMs");
  }
  const startedAt = performance.now();
  const providerMeta: {
    httpStatus?: number;
    providerRequestId?: string;
    providerStopReason?: AssistantMessage["stopReason"];
    toolCallCount?: number;
  } = {};
  const model = options.model ?? buildBailianModel(options.baseUrl);
  let providerCallCount = 0;
  let providerRequestLimitExceeded = false;
  let lastProviderResult: Promise<AssistantMessage> | undefined;
  const providerStreamFn: StreamFn =
    options.streamFnOverride ??
    ((_streamModel, context, streamOptions) => streamSimple(model, context, streamOptions));
  const streamFn: StreamFn = (streamModel, context, streamOptions) => {
    if (providerCallCount >= options.maxProviderRequests) {
      providerRequestLimitExceeded = true;
      // 这是Provider请求前的本地硬门；绝不把第二次请求交给Provider实现。
      // 如果pi因上一响应length截断尝试续轮，保留真实根因而非误报普通limit。
      if (lastProviderResult !== undefined) {
        return lastProviderResult.then<never>((message) => {
          if (message.stopReason === "length") {
            throw new Error("provider stream interrupted after length truncation");
          }
          throw new Error("provider request limit exceeded before dispatch");
        });
      }
      throw new Error("provider request limit exceeded before dispatch");
    }
    providerCallCount += 1;
    options.onProviderRequestStart?.();
    const providerOptions: ToolForcedStreamOptions = {
      ...streamOptions,
      apiKey: options.apiKey,
      // 所有Chat候选节点都只暴露一个结果收集工具。百炼Chat兼容接口支持
      // 指定function的tool_choice；强制它可消除模型偶发返回普通文本而不调用工具。
      toolChoice: { type: "function", function: { name: options.tool.name } },
      // 百炼qwen3.7-plus默认可能进入思考模式，而思考模式拒绝强制tool_choice。
      // 不提供reasoning level时，pi会根据Qwen Model能力发送enable_thinking:false；
      // 其他不声明thinkingFormat的模型不会收到这个Provider专属字段。
      maxTokens: options.maxTokens,
      temperature: 0,
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
      maxRetryDelayMs: 0,
      cacheRetention: "none",
      onResponse: async (response, responseModel) => {
        providerMeta.httpStatus = response.status;
        const requestId = requestIdFrom(response.headers);
        if (requestId !== undefined) providerMeta.providerRequestId = requestId;
        await streamOptions?.onResponse?.(response, responseModel);
      },
    };
    const stream = providerStreamFn(streamModel, context, providerOptions);
    // StreamFn既可能同步也可能异步返回事件流；保存真实Provider终止结果，
    // 供pi随后触发第二轮但被本地栅栏拒绝时恢复第一轮根因。
    lastProviderResult = Promise.resolve(stream)
      .then((eventStream) => eventStream.result())
      .then((message) => {
        providerMeta.providerStopReason = message.stopReason;
        providerMeta.toolCallCount = message.content.filter(
          (content) => content.type === "toolCall",
        ).length;
        if (providerMeta.providerRequestId === undefined) {
          const responseId = responseIdFrom(message);
          if (responseId !== undefined) providerMeta.providerRequestId = responseId;
        }
        return message;
      });
    return stream;
  };

  let validCalls = 0;
  let invalidSchemaCalls = 0;
  let capabilityViolations = 0;
  let candidate: TCandidate | undefined;
  let candidateDiagnostics: CandidateValidationDiagnostics | undefined;
  const executedToolCallIds = new Set<string>();

  const tool: AgentTool = {
    ...options.tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      executedToolCallIds.add(toolCallId);
      const parsed = options.parseCandidate(params);
      if (!parsed.ok) {
        if (parsed.errorCode === "capability_violation") {
          capabilityViolations += 1;
          candidateDiagnostics ??= safeCandidateDiagnostics(
            "capability_policy",
            parsed.diagnostics,
          );
        } else {
          invalidSchemaCalls += 1;
          candidateDiagnostics ??= safeCandidateDiagnostics(
            "candidate_contract",
            parsed.diagnostics,
          );
        }
        // 非法候选不交给模型自我修正：整个运行按MODEL_CANDIDATE_INVALID失败关闭
        return {
          content: [{ type: "text", text: "candidate rejected by server contract" }],
          details: undefined,
          terminate: true,
        };
      }
      validCalls += 1;
      candidate = parsed.candidate;
      const result = await options.tool.execute(toolCallId, params, signal, onUpdate);
      return { ...result, terminate: true };
    },
  };

  const abortController = new AbortController();
  let loopMessages: AgentMessage[] = [];
  const timer = setTimeout(() => abortController.abort(), options.timeoutMs);
  try {
    const prompt: Message = {
      role: "user",
      content: [{ type: "text", text: options.userPrompt }],
      timestamp: Date.now(),
    };
    loopMessages = await runAgentLoop(
      [prompt],
      { systemPrompt: options.systemPrompt, messages: [], tools: [tool] },
      {
        model,
        convertToLlm: (messages) =>
          messages.filter(
            (message): message is Message =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          ),
        getApiKey: () => options.apiKey,
        toolExecution: "sequential",
        // Agent类当前没有暴露shouldStopAfterTurn；直接使用同一pi Agent loop的
        // 官方低层入口，保证TypeBox在execute前拒绝参数时也不会触发第二次付费请求。
        shouldStopAfterTurn: ({ message, toolResults }) => {
          if (toolResults.length === 0) return false;
          for (const content of message.content) {
            if (content.type !== "toolCall" || executedToolCallIds.has(content.id)) continue;
            if (content.name !== tool.name) {
              invalidSchemaCalls += 1;
              candidateDiagnostics ??= safeCandidateDiagnostics("tool_argument_schema", {
                fields: [],
                issueCodes: ["unknown_tool"],
              });
              continue;
            }
            const parsed = options.parseCandidate(content.arguments);
            if (!parsed.ok && parsed.errorCode === "capability_violation") {
              capabilityViolations += 1;
              candidateDiagnostics ??= safeCandidateDiagnostics(
                "tool_argument_schema",
                parsed.diagnostics,
              );
            } else {
              // 包括“Chat Schema合法但pi/TypeBox入口更严格”的情况；它依然是
              // 模型候选不符合本节点工具合同，而不是Provider故障。
              invalidSchemaCalls += 1;
              candidateDiagnostics ??= safeCandidateDiagnostics(
                "tool_argument_schema",
                parsed.ok ? undefined : parsed.diagnostics,
              );
            }
          }
          return true;
        },
      },
      async () => undefined,
      abortController.signal,
      streamFn,
    );
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    const classifiedError = classifyProviderError(
      error instanceof Error ? error.message : String(error),
    );
    let interruptedByLength = [...loopMessages]
      .reverse()
      .some((message) => message.role === "assistant" && message.stopReason === "length");
    if (!interruptedByLength && lastProviderResult !== undefined) {
      try {
        const providerResult = await lastProviderResult;
        interruptedByLength = providerResult.stopReason === "length";
      } catch {
        // 原始Provider异常仍由下方稳定错误分类处理。
      }
    }
    return {
      kind: "provider_failed",
      errorCode: interruptedByLength
        ? "provider.stream_interrupted"
        : providerRequestLimitExceeded && classifiedError !== "provider.stream_interrupted"
          ? "provider.request_failed"
          : classifiedError,
      durationMs,
      providerCallCount,
      providerMeta,
    };
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const lastAssistant = [...loopMessages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant");
  const usage = usageFrom(lastAssistant);
  let lastProviderMessage: AssistantMessage | undefined;
  if (lastProviderResult !== undefined) {
    try {
      lastProviderMessage = await lastProviderResult;
    } catch {
      // 真实Provider错误由Agent消息/异常分类，不把原始内容向外传播。
    }
  }
  // 长度截断即使携带了完整工具参数也不是完整Provider结果；优先于随后被
  // 本地单请求栅栏拒绝的潜在续轮，避免把根因误报为普通请求失败。
  if (lastAssistant?.stopReason === "length" || lastProviderMessage?.stopReason === "length") {
    return {
      kind: "provider_failed",
      errorCode: "provider.stream_interrupted",
      durationMs,
      providerCallCount,
      ...(usage !== undefined ? { usage } : {}),
      providerMeta,
    };
  }
  if (providerRequestLimitExceeded) {
    return {
      kind: "provider_failed",
      errorCode: "provider.request_failed",
      durationMs,
      providerCallCount,
      ...(usage !== undefined ? { usage } : {}),
      providerMeta,
    };
  }
  if (lastAssistant !== undefined && lastAssistant.stopReason === "error") {
    return {
      kind: "provider_failed",
      errorCode: classifyProviderError(lastAssistant.errorMessage ?? ""),
      durationMs,
      providerCallCount,
      ...(usage !== undefined ? { usage } : {}),
      providerMeta,
    };
  }
  if (lastAssistant !== undefined && lastAssistant.stopReason === "aborted") {
    return {
      kind: "provider_failed",
      errorCode: "provider.timeout",
      durationMs,
      providerCallCount,
      ...(usage !== undefined ? { usage } : {}),
      providerMeta,
    };
  }

  if (lastAssistant === undefined) {
    return {
      kind: "provider_failed",
      errorCode: "provider.stream_interrupted",
      durationMs,
      providerCallCount,
      ...(usage !== undefined ? { usage } : {}),
      providerMeta,
    };
  }

  if ((providerMeta.toolCallCount ?? 0) > 1) {
    return {
      kind: "invalid_candidate",
      errorCode: "multiple_tool_calls",
      durationMs,
      providerCallCount,
      ...(usage !== undefined ? { usage } : {}),
      providerMeta,
    };
  }
  if (validCalls === 1 && candidate !== undefined) {
    return {
      kind: "candidate",
      candidate,
      ...(usage !== undefined ? { usage } : {}),
      durationMs,
      providerCallCount,
      providerMeta,
    };
  }
  if (capabilityViolations > 0) {
    return {
      kind: "invalid_candidate",
      errorCode: "capability_violation",
      durationMs,
      providerCallCount,
      ...(usage !== undefined ? { usage } : {}),
      providerMeta,
      ...(candidateDiagnostics !== undefined ? { diagnostics: candidateDiagnostics } : {}),
    };
  }
  if (invalidSchemaCalls > 0) {
    return {
      kind: "invalid_candidate",
      errorCode: "schema_invalid",
      durationMs,
      providerCallCount,
      ...(usage !== undefined ? { usage } : {}),
      providerMeta,
      ...(candidateDiagnostics !== undefined ? { diagnostics: candidateDiagnostics } : {}),
    };
  }
  return {
    kind: "invalid_candidate",
    errorCode: "no_tool_call",
    durationMs,
    providerCallCount,
    ...(usage !== undefined ? { usage } : {}),
    providerMeta,
  };
}
