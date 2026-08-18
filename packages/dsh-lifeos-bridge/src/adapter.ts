import { createHash } from "node:crypto";
import { CallId, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import type { ExecutionTraceItem } from "@chat/contracts/public";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { ChatProductApiError, ChatProductClient } from "./chat-client.ts";
import { dshSessionIdSchema, type ChatRun } from "./contracts.ts";
import { AtomicBridgeStateStore, type RequestBinding } from "./state-store.ts";
import { LIFEOS_TRACE_TOOL } from "./trace-tool.ts";

export const LIFEOS_PROVIDER = "lifeos";
export const LIFEOS_MODEL = "workflow";
const POLL_INTERVAL_MS = 750;
const TITLE_MAX_CHARACTERS = 72;
const COMPACTION_MAX_CHARACTERS = 6_000;
const COMPACTION_MESSAGE_LIMIT = 12;
const COMPACTION_ITEM_MAX_CHARACTERS = 600;
const TERMINAL_STATUSES = new Set<ChatRun["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableCommandId(purpose: string, ...parts: string[]): string {
  return `cmd_${sha256(["chat-dsh-lifeos-bridge.v1", purpose, ...parts].join("\u0000")).slice(0, 48)}`;
}

interface UserPrompt {
  messageId: string;
  text: string;
  textSha256: string;
  requestKey: string;
}

function textOf(message: Message): string {
  return message.content
    .filter(
      (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function boundedCharacters(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return `${characters.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

export function localAuxiliaryText(options: GenerateOptions): string {
  if (options.purpose === "session-title") {
    const title = lastUserPrompt(options.messages).text.replace(/\s+/g, " ").trim();
    return boundedCharacters(title, TITLE_MAX_CHARACTERS);
  }
  if (options.purpose !== "compaction") {
    throw new LlmError("lifeos auxiliary purpose is invalid", "LIFEOS_AUXILIARY_INVALID");
  }
  const visible = options.messages
    .map((message) => ({ role: message.role, text: textOf(message).replace(/\s+/g, " ").trim() }))
    .filter((message) => message.text !== "")
    .slice(-COMPACTION_MESSAGE_LIMIT)
    .map((message) => {
      const role =
        message.role === "assistant" ? "助手" : message.role === "user" ? "用户" : "系统";
      return `- ${role}：${boundedCharacters(message.text, COMPACTION_ITEM_MAX_CHARACTERS)}`;
    });
  const summary = [
    "本地会话摘要（仅整理当前可见文本，不包含隐藏推理）：",
    ...(visible.length === 0 ? ["- 此会话尚无可见文本。"] : visible),
  ].join("\n");
  return boundedCharacters(summary, COMPACTION_MAX_CHARACTERS);
}

async function* textStream(text: string): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}

async function* traceToolStream(
  productRunId: string,
  item: Extract<ExecutionTraceItem, { type: "tool_call" }>,
): AsyncIterable<StreamChunk> {
  const id = CallId(`lifeos_${sha256(`${productRunId}\u0000${item.toolCallId}`).slice(0, 48)}`);
  const args = JSON.stringify({
    productRunId,
    sourceSequence: item.sequence,
    toolCallId: item.toolCallId,
    toolName: item.toolName,
    input: item.input,
    inputTruncated: item.inputTruncated,
  });
  const block = { type: "tool-call" as const, id, name: LIFEOS_TRACE_TOOL, arguments: args };
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield {
    type: "tool-call-delta",
    index: 0,
    id,
    name: LIFEOS_TRACE_TOOL,
    argumentsDelta: args,
  };
  yield { type: "block-end", index: 0, block };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

export function lastUserPrompt(messages: readonly Message[]): UserPrompt {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user" || message.source.kind !== "user")
      continue;
    const text = textOf(message);
    if (text === "") continue;
    const textSha256 = sha256(text);
    return {
      messageId: String(message.id),
      text,
      textSha256,
      requestKey: sha256(`${String(message.id)}\u0000${textSha256}`).slice(0, 48),
    };
  }
  throw new LlmError("lifeos workflow requires a final user text message", "LIFEOS_NO_USER_TEXT");
}

function requireSessionId(options: GenerateOptions): string {
  const sessionId = options.sessionId === undefined ? "" : String(options.sessionId).trim();
  if (!dshSessionIdSchema.safeParse(sessionId).success) {
    throw new LlmError(
      "lifeos workflow requires a DSH sessionId and does not accept unbound one-shot calls",
      "LIFEOS_SESSION_REQUIRED",
    );
  }
  return sessionId;
}

async function delay(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, POLL_INTERVAL_MS);
  });
}

function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof ChatProductApiError) {
    const retryableCode =
      error.status === 408 || error.status === 504
        ? "TIMEOUT"
        : error.status === 429
          ? "RATE_LIMIT"
          : error.code === "chat_api_unreachable"
            ? "TRANSPORT"
            : "SERVER";
    return new LlmError(
      error.message,
      error.retryable ? retryableCode : `LIFEOS_${error.code.toUpperCase()}`,
      {
        status: error.status,
        cause: error,
      },
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new LlmError("lifeos workflow request was aborted", "ABORTED", { cause: error });
  }
  return new LlmError("lifeos workflow bridge failed", "LIFEOS_BRIDGE_FAILED", {
    cause: error,
  });
}

/**
 * Adapter route whose model call is a Chat Product Run. Product Store仍拥有
 * Message/Run终态；DSH只接收已提交的Assistant Message，Plan和审批仍是Chat资源。
 */
export class LifeosLlmAdapter extends LlmAdapter {
  constructor(
    private readonly chat: ChatProductClient,
    private readonly state: AtomicBridgeStateStore,
    private readonly lifetimeSignal?: AbortSignal,
  ) {
    super();
  }

  override providerInfo(provider: string) {
    return { id: provider, name: "LifeOS" };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: LIFEOS_MODEL, name: "Chat Workflow", inputModalities: ["text"] }];
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: "Chat Workflow", inputModalities: ["text"] };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== LIFEOS_PROVIDER || options.model !== LIFEOS_MODEL) {
      throw new LlmError(
        `lifeos workflow accepts only ${LIFEOS_PROVIDER}/${LIFEOS_MODEL}`,
        "LIFEOS_ROUTE_MISMATCH",
      );
    }
    const signal =
      this.lifetimeSignal === undefined
        ? options.signal
        : options.signal === undefined
          ? this.lifetimeSignal
          : AbortSignal.any([this.lifetimeSignal, options.signal]);
    if (signal?.aborted === true) {
      throw new LlmError("lifeos workflow request was aborted", "ABORTED", {
        cause: signal.reason,
      });
    }
    // DSH title/compaction calls are auxiliary model work, not user commands.
    // A bounded, deterministic rendering preserves the native features while
    // returning before any bridge state or Chat Product API access.
    if (options.purpose !== undefined) {
      yield* textStream(localAuxiliaryText(options));
      return;
    }

    try {
      const dshSessionId = requireSessionId(options);
      const prompt = lastUserPrompt(options.messages);
      const chatSessionId = await this.ensureChatSession(dshSessionId, signal);
      const request = await this.ensureRequest(dshSessionId, prompt);

      let run: ChatRun;
      if (request.productRunId === undefined) {
        const submitted = await this.chat.submitMessage(
          chatSessionId,
          request.messageCommandId,
          prompt.text,
          signal,
          request.workflowSelection,
        );
        await this.rememberRun(dshSessionId, prompt.requestKey, submitted.run.productRunId);
        run = submitted.run;
      } else {
        run = await this.chat.getRun(request.productRunId, signal);
      }
      const trajectoryEnabled =
        options.tools?.some((tool) => tool.name === LIFEOS_TRACE_TOOL) === true;
      while (true) {
        if (trajectoryEnabled) {
          const traceCall = await this.nextTraceTool(
            dshSessionId,
            prompt.requestKey,
            run.productRunId,
            signal,
          );
          if (traceCall !== undefined) {
            yield* traceToolStream(run.productRunId, traceCall);
            return;
          }
        }
        if (TERMINAL_STATUSES.has(run.status)) break;
        await delay(signal);
        run = await this.chat.getRun(run.productRunId, signal);
      }
      if (run.status !== "succeeded" || run.finalMessageId === undefined) {
        const summary = run.failure?.summary ?? `Chat Product Run ended as ${run.status}`;
        throw new LlmError(summary, `LIFEOS_RUN_${run.status.toUpperCase()}`);
      }

      const final = await this.chat.getMessage(chatSessionId, run.finalMessageId, signal);
      if (final === null || final.role !== "assistant") {
        throw new LlmError(
          "Chat Product Run succeeded without its committed Assistant Message",
          "LIFEOS_FINAL_MESSAGE_MISSING",
        );
      }
      const text = final.content.text;
      yield* textStream(text);
    } catch (error) {
      throw asLlmError(error);
    }
  }

  private async ensureChatSession(
    dshSessionId: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const createCommandId = stableCommandId("create-session", dshSessionId);
    await this.state.mutateSession(dshSessionId, createCommandId, () => undefined);
    const existing = await this.state.readSession(dshSessionId);
    if (existing?.chatSessionId !== undefined) return existing.chatSessionId;
    const created = await this.chat.createSession(createCommandId, signal);
    return await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
      if (binding.chatSessionId !== undefined && binding.chatSessionId !== created.sessionId) {
        throw new Error(`lifeos bridge observed two Chat sessions for DSH session ${dshSessionId}`);
      }
      binding.chatSessionId = created.sessionId;
      return created.sessionId;
    });
  }

  private async ensureRequest(dshSessionId: string, prompt: UserPrompt): Promise<RequestBinding> {
    return await this.state.mutateSession(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      (binding) => {
        const request = (binding.requests[prompt.requestKey] ??= {
          dshMessageId: prompt.messageId,
          userTextSha256: prompt.textSha256,
          messageCommandId: stableCommandId(
            "submit-message",
            dshSessionId,
            prompt.messageId,
            prompt.textSha256,
          ),
          traceCursor: 0,
          // 首次创建时冻结会话当前的选择草稿；之后用户再改草稿不影响本请求。
          ...(binding.workflowSelection !== undefined
            ? { workflowSelection: binding.workflowSelection }
            : {}),
        });
        if (request.userTextSha256 !== prompt.textSha256) {
          throw new Error("lifeos bridge request key collision");
        }
        if (request.dshMessageId !== undefined && request.dshMessageId !== prompt.messageId) {
          throw new Error("lifeos bridge request message identity mismatch");
        }
        request.dshMessageId = prompt.messageId;
        binding.currentRequestKey = prompt.requestKey;
        return structuredClone(request);
      },
    );
  }

  /**
   * 读取下一条尚未镜像的Pi工具intent。非工具事件仍推进cursor；遇到intent时停住，
   * 由lifeos_trace工具在匹配result到达后越过它，保证DSH显示真实运行态。
   */
  private async nextTraceTool(
    dshSessionId: string,
    requestKey: string,
    productRunId: string,
    signal: AbortSignal | undefined,
  ): Promise<Extract<ExecutionTraceItem, { type: "tool_call" }> | undefined> {
    const binding = await this.state.readSession(dshSessionId);
    const request = binding?.requests[requestKey];
    if (request?.productRunId !== productRunId) {
      throw new Error("lifeos trace request is not bound to the Product Run");
    }
    let cursor = request.traceCursor ?? 0;
    while (true) {
      const page = await this.chat.getExecutionTrace(productRunId, cursor, signal);
      const next = page.items.find(
        (item): item is Extract<ExecutionTraceItem, { type: "tool_call" }> =>
          item.type === "tool_call",
      );
      if (next !== undefined) {
        if (next.sequence > cursor + 1) {
          await this.state.advanceTraceCursor(dshSessionId, productRunId, next.sequence - 1);
        }
        return next;
      }
      if (page.nextCursor > cursor) {
        await this.state.advanceTraceCursor(dshSessionId, productRunId, page.nextCursor);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) return undefined;
    }
  }

  private async rememberRun(
    dshSessionId: string,
    requestKey: string,
    productRunId: string,
  ): Promise<void> {
    await this.state.mutateSession(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      (binding) => {
        const request = binding.requests[requestKey];
        if (request === undefined)
          throw new Error("lifeos bridge request disappeared before Run binding");
        if (request.productRunId !== undefined && request.productRunId !== productRunId) {
          throw new Error("lifeos bridge observed two Product Runs for one DSH message");
        }
        request.productRunId = productRunId;
      },
    );
  }
}
