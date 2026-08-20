import { createHash } from "node:crypto";
import { CallId, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import {
  workspaceInstructionsInputSchema,
  type ExecutionTraceItem,
  type WorkspaceInstructionsInput,
} from "@chat/contracts/public";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { ChatProductApiError, ChatProductClient } from "./chat-client.ts";
import {
  dshAdapterRequestCaptureSchema,
  dshSessionIdSchema,
  type ChatRun,
  type DshAdapterRequestCapture,
} from "./contracts.ts";
import { AtomicBridgeStateStore, type RequestBinding } from "./state-store.ts";
import {
  promptSelectionForWorkspace,
  type PromptWorkspaceResolver,
} from "./prompt-workspace-resolver.ts";
import type { DshSendReviewCoordinator } from "./dsh-send-review.ts";
import { exactSectionsFromJson, lastDshUserInputMapping } from "./dsh-bridge-readable.ts";
import { LIFEOS_TRACE_TOOL } from "./trace-tool.ts";

export const LIFEOS_PROVIDER = "lifeos";
export const LIFEOS_MODEL = "workflow";
const POLL_INTERVAL_MS = 750;
const TITLE_MAX_CHARACTERS = 72;
const PRODUCT_SESSION_TITLE_MAX_CHARACTERS = 200;
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

/**
 * DSH Agent Loop 已完成 system/messages/tools/模型参数组装后，Adapter 收到的
 * GenerateOptions 才是 DSH→Bridge 的真实内容边界。AbortSignal 只控制本地调用
 * 生命周期且无法序列化，因此原始视图明确排除它；其余可枚举字段按收到的值冻结。
 */
export function captureDshAdapterRequest(
  options: GenerateOptions,
): Extract<DshAdapterRequestCapture, { status: "captured" }> {
  const serializableRequest = Object.fromEntries(
    Object.entries(options).filter(([field]) => field !== "signal"),
  );
  let requestJson: string;
  try {
    requestJson = JSON.stringify(serializableRequest, null, 2);
  } catch (error) {
    throw new LlmError(
      "DSH发送请求包含无法序列化的字段，不能在审核前形成真实原始请求",
      "LIFEOS_DSH_REQUEST_NOT_SERIALIZABLE",
      { cause: error },
    );
  }
  const parsed = dshAdapterRequestCaptureSchema.safeParse({
    status: "captured",
    requestJson,
    requestSha256: sha256(requestJson),
  });
  if (!parsed.success || parsed.data.status !== "captured") {
    throw new LlmError(
      "DSH发送请求超过审核边界，不能用截断内容代替真实原始请求",
      "LIFEOS_DSH_REQUEST_TOO_LARGE",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export interface DshAdapterRequestTrace {
  readonly event: "lifeos.dsh_adapter_request.captured";
  readonly requestSha256: string;
  readonly excludedRuntimeFields: readonly ["signal"];
  readonly lastUserInput?: {
    readonly messageJsonPointer: string;
    readonly textJsonPointers: readonly string[];
    readonly textSha256: string;
  };
  readonly sections: readonly {
    readonly jsonPointer: string;
    readonly valueSha256: string;
    readonly valueCharacters: number;
  }[];
}

/**
 * Trace只记录原始请求和每个JSON Pointer值的Hash/长度。完整System、Messages和
 * Tool正文只存在于内存审核投影，不复制到日志、Bridge State或Product Store。
 */
export function dshAdapterRequestTraceOf(
  capture: Extract<DshAdapterRequestCapture, { status: "captured" }>,
): DshAdapterRequestTrace {
  const userInput = lastDshUserInputMapping(capture.requestJson);
  return {
    event: "lifeos.dsh_adapter_request.captured",
    requestSha256: capture.requestSha256,
    excludedRuntimeFields: ["signal"],
    ...(userInput === null
      ? {}
      : {
          lastUserInput: {
            messageJsonPointer: userInput.messageJsonPointer,
            textJsonPointers: userInput.textJsonPointers,
            textSha256: sha256(userInput.text),
          },
        }),
    sections: exactSectionsFromJson(capture.requestJson).map((section) => ({
      jsonPointer: section.jsonPointer,
      valueSha256: sha256(section.valueJson),
      valueCharacters: section.valueJson.length,
    })),
  };
}

function emitDshAdapterRequestTrace(
  capture: Extract<DshAdapterRequestCapture, { status: "captured" }>,
): void {
  console.info("[lifeos-bridge] dsh_adapter_request_captured", dshAdapterRequestTraceOf(capture));
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

/** Product Session标题取首条真实Prompt的单行全文边界，不再写入无信息的宿主名。 */
export function productSessionTitle(prompt: string): string {
  return boundedCharacters(
    prompt.replace(/\s+/gu, " ").trim(),
    PRODUCT_SESSION_TITLE_MAX_CHARACTERS,
  );
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

/**
 * DSH已经按原生Workspace语义完成AGENTS.md发现与层级组装；Bridge只转发
 * 仍在本次模型surface中的agent-instructions正文，不再猜目录或读取文件。
 */
export interface WorkspaceInstructionMessageLike {
  readonly role: string;
  readonly source: unknown;
  readonly content: readonly unknown[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function workspaceInstructionsOf(
  messages: readonly WorkspaceInstructionMessageLike[],
): WorkspaceInstructionsInput | undefined {
  const items = messages.flatMap((message) => {
    if (message.role !== "user" || recordOf(message.source)?.["kind"] !== "agent-instructions")
      return [];
    const content = message.content
      .flatMap((block) => {
        const record = recordOf(block);
        return record?.["type"] === "text" && typeof record["text"] === "string"
          ? [record["text"]]
          : [];
      })
      .join("\n");
    return content.trim() === "" ? [] : [{ content }];
  });
  if (items.length === 0) return undefined;
  const parsed = workspaceInstructionsInputSchema.safeParse({
    schemaVersion: "workspace-instructions-input.v1",
    items,
  });
  if (!parsed.success) {
    throw new LlmError(
      "当前Workspace的AGENTS.md上下文超过Chat可接受边界",
      "LIFEOS_WORKSPACE_INSTRUCTIONS_INVALID",
      { cause: parsed.error },
    );
  }
  return parsed.data;
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
    private readonly promptWorkspaceResolver?: PromptWorkspaceResolver,
    private readonly dshSendReview?: DshSendReviewCoordinator,
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
      const workspaceInstructions = workspaceInstructionsOf(options.messages);
      const request = await this.ensureRequest(dshSessionId, prompt, workspaceInstructions);

      if (request.productRunId === undefined && this.dshSendReview !== undefined) {
        const adapterRequest = captureDshAdapterRequest(options);
        emitDshAdapterRequestTrace(adapterRequest);
        const decision = await this.dshSendReview.waitForDecision({
          dshSessionId,
          requestKey: prompt.requestKey,
          text: prompt.text,
          adapterRequest,
          ...(signal === undefined ? {} : { signal }),
        });
        if (decision === "reject") {
          throw new LlmError("用户取消了本次DSH发送", "LIFEOS_DSH_SEND_REJECTED");
        }
      }

      const chatSessionId = await this.ensureChatSession(dshSessionId, prompt.text, signal);

      let run: ChatRun;
      if (request.productRunId === undefined) {
        const submitted = await this.chat.submitMessage(
          chatSessionId,
          request.messageCommandId,
          prompt.text,
          signal,
          request.workflowSelection,
          request.workspaceInstructions,
          request.promptSelection,
        );
        await this.rememberRun(
          dshSessionId,
          prompt.requestKey,
          submitted.run.productRunId,
          submitted.message.messageId,
        );
        run = submitted.run;
      } else {
        run = await this.chat.getRun(request.productRunId, signal);
        await this.rememberRun(
          dshSessionId,
          prompt.requestKey,
          run.productRunId,
          run.sourceMessageId,
        );
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
      await this.rememberAssistantMessage(dshSessionId, prompt.requestKey, final.messageId);
      const text = final.content.text;
      yield* textStream(text);
    } catch (error) {
      throw asLlmError(error);
    }
  }

  private async ensureChatSession(
    dshSessionId: string,
    firstPrompt: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const createCommandId = stableCommandId("create-session", dshSessionId);
    await this.state.mutateSession(dshSessionId, createCommandId, () => undefined);
    const existing = await this.state.readSession(dshSessionId);
    if (existing?.chatSessionId !== undefined) return existing.chatSessionId;
    const created = await this.chat.createSession(
      createCommandId,
      productSessionTitle(firstPrompt),
      signal,
    );
    return await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
      if (binding.chatSessionId !== undefined && binding.chatSessionId !== created.sessionId) {
        throw new Error(`lifeos bridge observed two Chat sessions for DSH session ${dshSessionId}`);
      }
      binding.chatSessionId = created.sessionId;
      return created.sessionId;
    });
  }

  private async ensureRequest(
    dshSessionId: string,
    prompt: UserPrompt,
    workspaceInstructions: WorkspaceInstructionsInput | undefined,
  ): Promise<RequestBinding> {
    const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
    return await this.state.mutateSession(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      (binding) => {
        const promptSelection = promptSelectionForWorkspace(binding.promptSelection, workspace);
        binding.promptSelection = promptSelection;
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
          promptSelection,
          ...(workspaceInstructions !== undefined ? { workspaceInstructions } : {}),
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
    productUserMessageId: string,
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
        if (
          request.productUserMessageId !== undefined &&
          request.productUserMessageId !== productUserMessageId
        ) {
          throw new Error("lifeos bridge observed two Product User Messages for one DSH message");
        }
        request.productRunId = productRunId;
        request.productUserMessageId = productUserMessageId;
        // Product Store已经冻结正式ContextRequest，Bridge不再长期复制AGENTS正文。
        delete request.workspaceInstructions;
      },
    );
  }

  private async rememberAssistantMessage(
    dshSessionId: string,
    requestKey: string,
    productAssistantMessageId: string,
  ): Promise<void> {
    await this.state.mutateSession(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      (binding) => {
        const request = binding.requests[requestKey];
        if (request?.productRunId === undefined) {
          throw new Error("lifeos bridge Run binding disappeared before Assistant Message");
        }
        if (
          request.productAssistantMessageId !== undefined &&
          request.productAssistantMessageId !== productAssistantMessageId
        ) {
          throw new Error("lifeos bridge observed two Product Assistant Messages for one Run");
        }
        request.productAssistantMessageId = productAssistantMessageId;
      },
    );
  }
}
