import { createHash } from "node:crypto";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import {
  commandIdSchema,
  productSessionIdSchema,
  workflowDefinitionRevisionIdSchema,
  workspaceInstructionsInputSchema,
  type WorkspaceInstructionsInput,
} from "@chat/contracts/public";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  assertExistingSessionMessageResponseBinding,
  assertFirstMessageResponseBinding,
  ChatProductApiError,
  ChatProductClient,
} from "./chat-client.ts";
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
import type { BridgeDispatchReviewCoordinator } from "./bridge-dispatch-review.ts";
import { prepareBridgeChatDispatch } from "./bridge-chat-dispatch.ts";
import { exactSectionsFromJson, lastDshUserInputMapping } from "./dsh-bridge-readable.ts";
import { DSH_BRIDGE_TRACE_EVENTS, type DshBridgeTraceEventInput } from "./debug-trace.ts";

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

interface UserPrompt {
  messageId: string;
  text: string;
  textSha256: string;
  requestKey: string;
}

interface PreparedRequestBinding extends RequestBinding {
  readonly submissionTarget: "first_message" | "existing_session";
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
 * 兼容读取器只投影DSH自己组装的agent-instructions，供宿主上下文面板审计。
 * Bridge当前不会把它自动转发给Chat；用户需要的指令必须经Prompt区域显式选择。
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

const DEFINITELY_UNCOMMITTED_MESSAGE_PROBLEM_CODES = new Set([
  "command_id_reused",
  "forbidden",
  "not_found",
  "policy_denied",
  "revision_conflict",
  "validation_failed",
]);

function isDefinitelyUncommittedMessageError(error: unknown): error is ChatProductApiError {
  return (
    error instanceof ChatProductApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    DEFINITELY_UNCOMMITTED_MESSAGE_PROBLEM_CODES.has(error.code)
  );
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
    private readonly bridgeDispatchReview?: BridgeDispatchReviewCoordinator,
    private readonly dshTrace?: (event: DshBridgeTraceEventInput) => void,
    private readonly bridgeTrace?: (event: DshBridgeTraceEventInput) => void,
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

    let pendingProductWrite:
      | {
          readonly dshSessionId: string;
          readonly requestKey: string;
        }
      | undefined;
    try {
      const dshSessionId = requireSessionId(options);
      const prompt = lastUserPrompt(options.messages);
      const diagnosticTraceId = `trd_${prompt.requestKey}`;
      // State Store的串行事务先原子检查/预留Request。不同B若遇到pending A，必须
      // 在任何Chat Query或Command之前失败，且回调抛错不会产生一次状态写入。
      await this.ensureRequest(dshSessionId, prompt);
      const binding = await this.state.readSession(dshSessionId);
      const request = binding?.requests[prompt.requestKey];
      if (request === undefined) {
        throw new Error("lifeos bridge request disappeared after lifecycle recovery");
      }
      if (request.submissionStatus === "definitely_uncommitted") {
        throw new LlmError(
          "本次消息已确认未提交，请发送一条新消息继续",
          "LIFEOS_MESSAGE_DEFINITELY_UNCOMMITTED",
        );
      }
      const submissionProductSessionId =
        request.submissionTarget === "first_message" ? undefined : binding?.chatSessionId;
      if (
        request.submissionTarget === "existing_session" &&
        submissionProductSessionId === undefined
      ) {
        throw new Error("Bridge existing-session request is missing its Product Session binding");
      }
      const dispatchPlan = prepareBridgeChatDispatch({
        requestKey: prompt.requestKey,
        ...(submissionProductSessionId === undefined
          ? {}
          : { productSessionId: submissionProductSessionId }),
        messageCommandId: request.messageCommandId,
        text: prompt.text,
        ...(request.workflowSelection === undefined
          ? {}
          : { workflowSelection: request.workflowSelection }),
        ...(request.promptSelection === undefined
          ? {}
          : { promptSelection: request.promptSelection }),
      });

      if (
        (request.submissionStatus === "prepared" ||
          request.submissionStatus === "outcome_unknown") &&
        (this.dshSendReview !== undefined || this.dshTrace !== undefined)
      ) {
        const adapterRequest = captureDshAdapterRequest(options);
        this.dshTrace?.({
          level: "info",
          eventName: DSH_BRIDGE_TRACE_EVENTS.dshAdapterRequestCaptured,
          outcome: "success",
          traceId: diagnosticTraceId,
          spanId: `spd_${sha256(`dsh\u0000${prompt.requestKey}`).slice(0, 32)}`,
          dshSessionIdSha256: sha256(dshSessionId),
          requestSha256: adapterRequest.requestSha256,
          userTextSha256: prompt.textSha256,
          sectionCount: exactSectionsFromJson(adapterRequest.requestJson).length,
        });
        if (this.dshSendReview !== undefined) {
          const decision = await this.dshSendReview.waitForDecision({
            dshSessionId,
            requestKey: prompt.requestKey,
            text: prompt.text,
            adapterRequest,
            ...(signal === undefined ? {} : { signal }),
          });
          if (decision === "reject") {
            if (request.submissionStatus === "prepared") {
              await this.state.markRequestDefinitelyUncommitted(
                dshSessionId,
                stableCommandId("create-session", dshSessionId),
                prompt.requestKey,
                { reason: "local_review_rejected" },
              );
            }
            throw new LlmError("用户取消了本次DSH发送", "LIFEOS_DSH_SEND_REJECTED");
          }
        }
      }

      this.bridgeTrace?.({
        level: "info",
        eventName: DSH_BRIDGE_TRACE_EVENTS.bridgeDispatchPrepared,
        outcome: "success",
        traceId: diagnosticTraceId,
        spanId: `spb_${sha256(`bridge\u0000${prompt.requestKey}`).slice(0, 32)}`,
        ...(this.dshTrace === undefined
          ? {}
          : { parentSpanId: `spd_${sha256(`dsh\u0000${prompt.requestKey}`).slice(0, 32)}` }),
        dshSessionIdSha256: sha256(dshSessionId),
        commandId: commandIdSchema.parse(request.messageCommandId),
        dispatchPlanSha256: dispatchPlan.planSha256,
        ...(request.promptSelection === undefined
          ? {}
          : { promptSelectionSha256: sha256(JSON.stringify(request.promptSelection)) }),
        ...(request.workflowSelection?.workflowDefinitionRevisionId === undefined
          ? {}
          : {
              workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema.parse(
                request.workflowSelection.workflowDefinitionRevisionId,
              ),
            }),
        ...(binding?.chatSessionId === undefined
          ? {}
          : { productSessionId: productSessionIdSchema.parse(binding.chatSessionId) }),
      });

      if (
        (request.submissionStatus === "prepared" ||
          request.submissionStatus === "outcome_unknown") &&
        this.bridgeDispatchReview !== undefined
      ) {
        const decision = await this.bridgeDispatchReview.waitForDecision({
          dshSessionId,
          plan: dispatchPlan,
          ...(signal === undefined ? {} : { signal }),
        });
        if (decision === "reject") {
          if (request.submissionStatus === "prepared") {
            await this.state.markRequestDefinitelyUncommitted(
              dshSessionId,
              stableCommandId("create-session", dshSessionId),
              prompt.requestKey,
              { reason: "local_review_rejected" },
            );
          }
          throw new LlmError(
            "用户取消了Bridge到Chat后端的本次发送",
            "LIFEOS_BRIDGE_DISPATCH_REJECTED",
          );
        }
      }

      let chatSessionId = binding?.chatSessionId;
      let run: ChatRun;
      if (request.productRunId === undefined) {
        // 这是唯一Product HTTP写边界：先把prepared原子提升为outcome_unknown。
        // 进程在此后任一点退出都只能用同一Command恢复，不能让另一条DSH消息越过。
        await this.state.markRequestOutcomeUnknown(
          dshSessionId,
          stableCommandId("create-session", dshSessionId),
          prompt.requestKey,
        );
        pendingProductWrite = {
          dshSessionId,
          requestKey: prompt.requestKey,
        };
        if (request.submissionTarget === "first_message") {
          const started = await this.chat.submitFirstMessageFromDispatch(
            dispatchPlan.submitMessage,
            signal,
          );
          assertFirstMessageResponseBinding(started);
          chatSessionId = await this.rememberFirstMessageSubmission(
            dshSessionId,
            prompt.requestKey,
            started.session.sessionId,
            started.run.productRunId,
            started.message.messageId,
          );
          run = started.run;
        } else {
          if (chatSessionId === undefined) {
            throw new Error("Bridge existing-session request lost its Product Session binding");
          }
          const submitted = await this.chat.submitMessageFromDispatch(
            chatSessionId,
            dispatchPlan.submitMessage,
            signal,
          );
          assertExistingSessionMessageResponseBinding(chatSessionId, submitted);
          await this.rememberRun(
            dshSessionId,
            prompt.requestKey,
            submitted.run.productRunId,
            submitted.message.messageId,
          );
          run = submitted.run;
        }
        pendingProductWrite = undefined;
      } else {
        if (chatSessionId === undefined) {
          throw new Error("Bridge Product Run binding is missing its Chat Product Session");
        }
        run = await this.chat.getRun(request.productRunId, signal);
        await this.rememberRun(
          dshSessionId,
          prompt.requestKey,
          run.productRunId,
          run.sourceMessageId,
        );
      }
      while (true) {
        if (TERMINAL_STATUSES.has(run.status)) break;
        await delay(signal);
        run = await this.chat.getRun(run.productRunId, signal);
      }
      if (run.status !== "succeeded" || run.finalMessageId === undefined) {
        const summary = run.failure?.summary ?? `Chat Product Run ended as ${run.status}`;
        throw new LlmError(summary, `LIFEOS_RUN_${run.status.toUpperCase()}`);
      }

      if (chatSessionId === undefined) {
        throw new Error("Bridge did not persist the Chat Product Session returned by Application");
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
      if (pendingProductWrite !== undefined && isDefinitelyUncommittedMessageError(error)) {
        // 白名单4xx Problem证明本次Message没有形成可按同Command恢复的响应未知结果。
        // transport、5xx与2xx响应合同损坏均可能发生在提交后，必须继续保留outcome_unknown。
        await this.state.markRequestDefinitelyUncommitted(
          pendingProductWrite.dshSessionId,
          stableCommandId("create-session", pendingProductWrite.dshSessionId),
          pendingProductWrite.requestKey,
          {
            reason: "product_definitely_uncommitted",
          },
        );
      }
      throw asLlmError(error);
    }
  }

  /**
   * 首轮Product响应中的Session、User Message与Run属于同一命令结果，必须在一次
   * Bridge原子写中绑定。否则进程若只保存Session便退出，同一Command重放会从
   * `/api/messages`漂移到既有Session路径并改变Product Receipt hash。
   */
  private async rememberFirstMessageSubmission(
    dshSessionId: string,
    requestKey: string,
    productSessionId: string,
    productRunId: string,
    productUserMessageId: string,
  ): Promise<string> {
    // v11持久字段仍叫createSessionCommandId，但它只是Bridge本地映射的CAS身份，
    // 不再被用于调用Chat创建Session。后续格式迁移再单独改名，避免破坏已有映射。
    const existing = await this.state.readSession(dshSessionId);
    const bindingCommandId =
      existing?.createSessionCommandId ?? stableCommandId("session-binding", dshSessionId);
    return await this.state.mutateSession(dshSessionId, bindingCommandId, (binding) => {
      if (binding.chatSessionId !== undefined && binding.chatSessionId !== productSessionId) {
        throw new Error(`lifeos bridge observed two Chat sessions for DSH session ${dshSessionId}`);
      }
      const request = binding.requests[requestKey];
      if (request === undefined) {
        throw new Error("lifeos bridge request disappeared before first-message binding");
      }
      this.bindRun(request, productRunId, productUserMessageId);
      binding.chatSessionId = productSessionId;
      return productSessionId;
    });
  }

  private async ensureRequest(
    dshSessionId: string,
    prompt: UserPrompt,
  ): Promise<PreparedRequestBinding> {
    const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
    return await this.state.mutateSession(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      (binding) => {
        const promptSelection = promptSelectionForWorkspace(binding.promptSelection, workspace);
        binding.promptSelection = promptSelection;
        let request = binding.requests[prompt.requestKey];
        if (request === undefined) {
          const pendingRequest = Object.entries(binding.requests).find(
            ([requestKey, candidate]) =>
              requestKey !== prompt.requestKey &&
              (candidate.submissionStatus === "prepared" ||
                candidate.submissionStatus === "outcome_unknown"),
          );
          if (pendingRequest !== undefined) {
            throw new LlmError(
              "上一条消息尚未完成提交恢复，请重试原消息后再发送新内容",
              "LIFEOS_PREVIOUS_REQUEST_PENDING",
            );
          }
          request = {
            dshMessageId: prompt.messageId,
            userTextSha256: prompt.textSha256,
            messageCommandId: stableCommandId(
              "submit-message",
              dshSessionId,
              prompt.messageId,
              prompt.textSha256,
            ),
            submissionTarget:
              binding.chatSessionId === undefined ? "first_message" : "existing_session",
            submissionStatus: "prepared",
            // 首次创建时冻结会话当前的选择草稿；之后用户再改草稿不影响本请求。
            ...(binding.sessionWorkflowSelection !== undefined
              ? { workflowSelection: binding.sessionWorkflowSelection }
              : {}),
            promptSelection,
          };
          binding.requests[prompt.requestKey] = request;
        }
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
        this.bindRun(request, productRunId, productUserMessageId);
      },
    );
  }

  private bindRun(
    request: RequestBinding,
    productRunId: string,
    productUserMessageId: string,
  ): void {
    if (request.submissionStatus !== "outcome_unknown" && request.submissionStatus !== "bound") {
      throw new Error(`lifeos bridge cannot bind request from ${request.submissionStatus}`);
    }
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
    request.submissionStatus = "bound";
    // 旧v5-v11状态可能仍带有DSH指令快照；新请求不再创建该旁路。
    delete request.workspaceInstructions;
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
