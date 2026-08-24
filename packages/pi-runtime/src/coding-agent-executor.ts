import { lstat, mkdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createBashToolDefinition,
  createLocalBashOperations,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ToolDefinition,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  EXECUTION_CAPABILITY_SHELL_EXECUTE,
  EXECUTION_CAPABILITY_WORKSPACE_READ,
  EXECUTION_CAPABILITY_WORKSPACE_WRITE,
} from "@chat/contracts";
import { assertAllowedBailianHost } from "./config.js";
import { projectExecutorStepCandidate, type ExecutorStepCandidate } from "./executor.js";
import {
  hashExecutorValue,
  type PiExecutorEventPayload,
  type PiExecutorOperationStore,
} from "./executor-operation-store.js";
import type { PiToolName, StartPiExecutorOperationRequest } from "./executor-service-contract.js";
import { buildExecutorUserPrompt } from "./executor.js";
import { governedUserPromptLayer } from "./prompt-layers.js";
import { CHAT_CODING_EXECUTOR_RUNTIME_PROMPT } from "./coding-agent-runtime-profile.js";

interface ProviderInFlight {
  readonly requestIndex: number;
  readonly inputSha256: string;
  readonly startedAtMs: number;
  httpStatus?: number;
  providerRequestId?: string;
}

interface ToolInFlight {
  readonly toolName: PiToolName;
  readonly startedAtMs: number;
  readonly inputSha256: string;
  readonly inputDisplay: string;
  readonly inputDisplayTruncated: boolean;
  readonly turnIndex: number;
}

export interface CodingExecutorJournalState {
  turnIndex: number;
  turnStartedAtMs: number;
  providerRequestCount: number;
  completionTokens: number;
  messageIndex: number;
  provider: ProviderInFlight | undefined;
  readonly tools: Map<string, ToolInFlight>;
  fatalError: PiCodingAgentExecutionError | undefined;
  readonly operationStartedAtMs: number;
}

const PI_CODING_PROVIDER = "dashscope-coding";
const PI_CODING_MODEL = "qwen3.7-plus";

export interface PiCodingAgentRunInput {
  readonly request: StartPiExecutorOperationRequest;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly store: PiExecutorOperationStore;
  readonly signal: AbortSignal;
}

export interface PiCodingAgentRunner {
  run(input: PiCodingAgentRunInput): Promise<ExecutorStepCandidate>;
}

export class PiCodingAgentExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PiCodingAgentExecutionError";
  }
}

export function createCodingExecutorJournalState(): CodingExecutorJournalState {
  const now = Date.now();
  return {
    turnIndex: 0,
    turnStartedAtMs: now,
    providerRequestCount: 0,
    completionTokens: 0,
    messageIndex: 0,
    provider: undefined,
    tools: new Map(),
    fatalError: undefined,
    operationStartedAtMs: now,
  };
}

function latchFatalJournalError(
  state: CodingExecutorJournalState,
  error: unknown,
  fallbackCode: string,
): PiCodingAgentExecutionError {
  const errorCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u.test(error.code)
      ? error.code
      : fallbackCode;
  state.fatalError ??= new PiCodingAgentExecutionError(errorCode);
  return state.fatalError;
}

/** Pi会把beforeToolCall异常转成普通Tool Error；Runner必须在返回Candidate前耐久熔断Operation。 */
export async function settleCodingExecutorFatal(input: {
  readonly operationId: string;
  readonly store: PiExecutorOperationStore;
  readonly state: CodingExecutorJournalState;
}): Promise<void> {
  const fatal = input.state.fatalError;
  if (fatal === undefined) return;
  await input.store.markOutcomeUnknown(
    input.operationId,
    fatal.code,
    Math.max(0, Date.now() - input.state.operationStartedAtMs),
  );
  throw fatal;
}

function enabledToolsForCapabilities(capabilities: readonly string[]): readonly PiToolName[] {
  const enabled = new Set<PiToolName>();
  if (
    capabilities.includes(EXECUTION_CAPABILITY_WORKSPACE_READ) ||
    capabilities.includes(EXECUTION_CAPABILITY_WORKSPACE_WRITE) ||
    capabilities.includes(EXECUTION_CAPABILITY_SHELL_EXECUTE)
  ) {
    for (const tool of ["read", "grep", "find", "ls"] as const) enabled.add(tool);
  }
  if (capabilities.includes(EXECUTION_CAPABILITY_WORKSPACE_WRITE)) {
    enabled.add("edit");
    enabled.add("write");
  }
  if (capabilities.includes(EXECUTION_CAPABILITY_SHELL_EXECUTE)) enabled.add("bash");
  return [...enabled];
}

function usageProjection(usage: Usage): {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
} {
  return {
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
  };
}

function assistantText(message: AgentMessage | undefined): string | undefined {
  if (message?.role !== "assistant") return undefined;
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}

function safeProviderRequestId(
  message: AssistantMessage,
  inFlight: ProviderInFlight,
  operationId: string,
): string {
  const candidate = message.responseId ?? inFlight.providerRequestId;
  if (candidate !== undefined && /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate)) return candidate;
  return `${operationId}-req-${String(inFlight.requestIndex)}`;
}

function responseRequestId(headers: Record<string, string>): string | undefined {
  for (const name of ["x-request-id", "request-id", "x-dashscope-request-id"]) {
    const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    if (value !== undefined && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)) return value;
  }
  return undefined;
}

function mapProviderFailure(message: AssistantMessage): string {
  if (message.stopReason === "aborted") return "provider.aborted";
  if (message.stopReason === "length") return "provider.length";
  return "provider.request_failed";
}

function toolResultHash(event: ToolResultEvent): string {
  return hashExecutorValue({
    content: event.content,
    details: event.details,
    isError: event.isError,
    usage: event.usage,
  });
}

const TRACE_DISPLAY_MAX_CHARACTERS = 32_000;

function redactObservableText(value: string): string {
  return value
    .replace(
      /((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?)[^\s"',}]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /("(?:authorization|proxy[_-]?authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key)"\s*:\s*")[^"]*(")/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY))=([^\s]+)/gu,
      "$1=[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_API_KEY]");
}

/** Pi CLI/Web同类的可见执行文本：有界且在进入Journal前脱敏。 */
export function toObservableTraceDisplay(value: unknown): {
  readonly text: string;
  readonly truncated: boolean;
} {
  let serialized: string;
  if (typeof value === "string") serialized = value;
  else {
    try {
      serialized = JSON.stringify(value, undefined, 2) ?? String(value);
    } catch {
      serialized = "[UNSERIALIZABLE_OBSERVABLE_VALUE]";
    }
  }
  const redacted = redactObservableText(serialized);
  const characters = Array.from(redacted);
  if (characters.length <= TRACE_DISPLAY_MAX_CHARACTERS) {
    return { text: redacted, truncated: false };
  }
  return {
    text: `${characters.slice(0, TRACE_DISPLAY_MAX_CHARACTERS - 1).join("")}…`,
    truncated: true,
  };
}

function toolResultDisplay(event: ToolResultEvent): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const content = event.content.map((part) =>
    part.type === "text" ? part.text : `[image:${part.mimeType}]`,
  );
  return toObservableTraceDisplay(content.join("\n"));
}

function isWithinRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function nearestExistingRealPath(target: string): Promise<string> {
  let cursor = target;
  while (true) {
    try {
      return await realpath(cursor);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

export async function assertExecutorWorkspacePath(
  rawPath: unknown,
  workspaceRoot: string,
): Promise<void> {
  if (typeof rawPath !== "string") {
    throw new PiCodingAgentExecutionError("executor.tool_path_invalid");
  }
  const stripped = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  if (stripped.startsWith("~")) {
    throw new PiCodingAgentExecutionError("executor.tool_path_outside_workspace");
  }
  const canonicalRoot = await realpath(workspaceRoot);
  const absolutePath = resolve(canonicalRoot, stripped || ".");
  if (!isWithinRoot(canonicalRoot, absolutePath)) {
    throw new PiCodingAgentExecutionError("executor.tool_path_outside_workspace");
  }
  try {
    if ((await lstat(absolutePath)).isSymbolicLink()) {
      const linkTarget = resolve(dirname(absolutePath), await readlink(absolutePath));
      if (!isWithinRoot(canonicalRoot, linkTarget)) {
        throw new PiCodingAgentExecutionError("executor.tool_path_outside_workspace");
      }
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const existingRealPath = await nearestExistingRealPath(absolutePath);
  if (!isWithinRoot(canonicalRoot, existingRealPath)) {
    throw new PiCodingAgentExecutionError("executor.tool_path_outside_workspace");
  }
}

async function assertToolScope(event: ToolCallEvent, workspaceRoot: string): Promise<void> {
  if (event.toolName === "bash") return;
  if (
    event.toolName === "read" ||
    event.toolName === "edit" ||
    event.toolName === "write" ||
    event.toolName === "grep" ||
    event.toolName === "find" ||
    event.toolName === "ls"
  ) {
    const path = "path" in event.input ? event.input.path : undefined;
    await assertExecutorWorkspacePath(
      path ??
        (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls"
          ? "."
          : path),
      workspaceRoot,
    );
    return;
  }
  throw new PiCodingAgentExecutionError("executor.tool_not_allowed");
}

export function executorShellEnvironment(agentDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: agentDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SHELL",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") environment[name] = value;
  }
  return environment;
}

/**
 * AgentSession公开Extension hook是当前审计接缝。只有执行前的tool_call hook会把失败
 * 传播回Tool边界；固定Pi 0.84.2会捕获before_provider_request、tool_result、message_end
 * 等其他handler异常并继续。因此除Tool Intent外的Journal目前只是观察证据，不能冒充
 * fail-closed授权栅栏。Prompt Review P0已证明必须在Extension链外包装Agent.onPayload。
 */
export function createCodingExecutorJournalExtension(input: {
  readonly request: StartPiExecutorOperationRequest;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly endpointHost: string;
  readonly store: PiExecutorOperationStore;
  readonly state: CodingExecutorJournalState;
}): ExtensionFactory {
  const operationId = input.request.operationId;
  const sessionId = input.sessionId;
  const append = (payload: PiExecutorEventPayload) => input.store.append(operationId, payload);
  return (pi) => {
    pi.on("turn_start", async (event) => {
      input.state.turnIndex = event.turnIndex;
      input.state.turnStartedAtMs = event.timestamp;
      await append({
        operationId,
        type: "turn.started",
        sessionId,
        turnIndex: event.turnIndex,
      });
    });
    pi.on("turn_end", async (event) => {
      await append({
        operationId,
        type: "turn.completed",
        sessionId,
        turnIndex: event.turnIndex,
        durationMs: Math.max(0, Date.now() - input.state.turnStartedAtMs),
      });
    });
    pi.on("before_provider_request", async (event) => {
      if (input.state.providerRequestCount >= input.request.contract.limits.maxTurnsPerStep) {
        throw new PiCodingAgentExecutionError("executor.turn_limit_exceeded");
      }
      if (
        input.state.completionTokens >=
        (input.request.contract.limits.tokenBudgetPerStep ?? Number.MAX_SAFE_INTEGER)
      ) {
        throw new PiCodingAgentExecutionError("executor.token_budget_exceeded");
      }
      input.state.providerRequestCount += 1;
      const provider: ProviderInFlight = {
        requestIndex: input.state.providerRequestCount,
        inputSha256: hashExecutorValue(event.payload),
        startedAtMs: Date.now(),
      };
      input.state.provider = provider;
      await append({
        operationId,
        type: "provider.started",
        sessionId,
        requestIndex: provider.requestIndex,
        endpointHost: input.endpointHost,
        inputSha256: provider.inputSha256,
      });
    });
    pi.on("after_provider_response", (event) => {
      const provider = input.state.provider;
      if (provider === undefined) return;
      provider.httpStatus = event.status;
      const providerRequestId = responseRequestId(event.headers);
      if (providerRequestId !== undefined) provider.providerRequestId = providerRequestId;
    });
    pi.on("message_end", async (event) => {
      const messageIndex = input.state.messageIndex;
      input.state.messageIndex += 1;
      const message = event.message;
      const usage = message.role === "assistant" ? usageProjection(message.usage) : undefined;
      const eventRole =
        message.role === "bashExecution" ||
        message.role === "branchSummary" ||
        message.role === "compactionSummary"
          ? "custom"
          : message.role;
      const visible = message.role === "assistant" ? assistantText(message) : undefined;
      const visibleDisplay = visible === undefined ? undefined : toObservableTraceDisplay(visible);
      await append({
        operationId,
        type: "message.completed",
        sessionId,
        messageIndex,
        role: eventRole,
        contentSha256: hashExecutorValue(message),
        ...(visible === undefined ? {} : { visibleTextSha256: hashExecutorValue(visible) }),
        ...(visibleDisplay !== undefined
          ? {
              visibleText: visibleDisplay.text,
              visibleTextTruncated: visibleDisplay.truncated,
            }
          : {}),
        ...(message.role === "assistant"
          ? {
              stopReason: message.stopReason === "pending" ? "error" : message.stopReason,
              usage,
            }
          : {}),
      });
      if (message.role !== "assistant") return;
      input.state.completionTokens += message.usage.output;
      const provider = input.state.provider;
      if (provider === undefined) return;
      input.state.provider = undefined;
      const durationMs = Math.max(0, Date.now() - provider.startedAtMs);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await append({
          operationId,
          type: "provider.failed",
          sessionId,
          requestIndex: provider.requestIndex,
          endpointHost: input.endpointHost,
          inputSha256: provider.inputSha256,
          ...(provider.httpStatus !== undefined ? { httpStatus: provider.httpStatus } : {}),
          providerRequestId: safeProviderRequestId(message, provider, operationId),
          errorCode: mapProviderFailure(message),
          durationMs,
        });
        return;
      }
      const stopReason = message.stopReason === "pending" ? "error" : message.stopReason;
      await append({
        operationId,
        type: "provider.completed",
        sessionId,
        requestIndex: provider.requestIndex,
        endpointHost: input.endpointHost,
        inputSha256: provider.inputSha256,
        httpStatus: provider.httpStatus ?? 200,
        providerRequestId: safeProviderRequestId(message, provider, operationId),
        usage: usageProjection(message.usage),
        stopReason,
        toolCallCount: message.content.filter((part) => part.type === "toolCall").length,
        durationMs,
      });
    });
    pi.on("tool_call", async (event: ToolCallEvent) => {
      if (input.state.fatalError !== undefined) throw input.state.fatalError;
      const toolName = event.toolName as PiToolName;
      const inputSha256 = hashExecutorValue(event.input);
      const inputDisplay = toObservableTraceDisplay(event.input);
      try {
        await assertToolScope(event, input.workspaceRoot);
      } catch (error) {
        const errorCode =
          error instanceof PiCodingAgentExecutionError ? error.code : "executor.tool_policy_failed";
        await append({
          operationId,
          type: "tool.blocked",
          sessionId,
          turnIndex: input.state.turnIndex,
          toolCallId: event.toolCallId,
          toolName,
          inputSha256,
          inputDisplay: inputDisplay.text,
          inputDisplayTruncated: inputDisplay.truncated,
          errorCode,
        });
        throw error;
      }
      const tool: ToolInFlight = {
        toolName,
        startedAtMs: Date.now(),
        inputSha256,
        inputDisplay: inputDisplay.text,
        inputDisplayTruncated: inputDisplay.truncated,
        turnIndex: input.state.turnIndex,
      };
      try {
        const capabilityId = `pi_planning:tool:builtin:${toolName}`;
        const capabilityRefSha256 = hashExecutorValue({ capabilityId, localName: toolName });
        await append({
          operationId,
          type: "tool.intent_persisted",
          sessionId,
          turnIndex: tool.turnIndex,
          toolCallId: event.toolCallId,
          toolName,
          capabilityId,
          capabilityRefSha256,
          inputSha256: tool.inputSha256,
          inputDisplay: tool.inputDisplay,
          inputDisplayTruncated: tool.inputDisplayTruncated,
        });
      } catch (error) {
        throw latchFatalJournalError(input.state, error, "executor.tool_intent_persist_failed");
      }
      // 只有唯一Intent耐久成功后才能建立内存Result关联；重复ID失败不能覆盖旧元数据。
      input.state.tools.set(event.toolCallId, tool);
    });
    pi.on("tool_result", async (event: ToolResultEvent) => {
      const tool = input.state.tools.get(event.toolCallId);
      const resultInputSha256 = hashExecutorValue(event.input);
      if (
        tool === undefined ||
        event.toolName !== tool.toolName ||
        resultInputSha256 !== tool.inputSha256
      ) {
        throw latchFatalJournalError(
          input.state,
          new PiCodingAgentExecutionError("executor.tool_result_intent_mismatch"),
          "executor.tool_result_intent_mismatch",
        );
      }
      const resultDisplay = toolResultDisplay(event);
      const common = {
        operationId,
        sessionId,
        turnIndex: tool.turnIndex,
        toolCallId: event.toolCallId,
        toolName: tool.toolName,
        capabilityId: `pi_planning:tool:builtin:${tool.toolName}`,
        capabilityRefSha256: hashExecutorValue({
          capabilityId: `pi_planning:tool:builtin:${tool.toolName}`,
          localName: tool.toolName,
        }),
        inputSha256: resultInputSha256,
        resultSha256: toolResultHash(event),
        resultDisplay: resultDisplay.text,
        resultDisplayTruncated: resultDisplay.truncated,
        durationMs: Math.max(0, Date.now() - tool.startedAtMs),
      } as const;
      try {
        await append(
          event.isError
            ? { ...common, type: "tool.failed", errorCode: "executor.tool_failed" }
            : { ...common, type: "tool.completed" },
        );
      } catch (error) {
        throw latchFatalJournalError(input.state, error, "executor.tool_result_persist_failed");
      }
      // 固定Pi会吞掉tool_result handler异常，因此只有持久Journal明确成功后才能
      // 从运行内存闭合Intent。写失败时保留该项，complete()还会从持久记录二次拒绝成功。
      input.state.tools.delete(event.toolCallId);
    });
    pi.on("session_before_compact", async (event) => {
      await append({
        operationId,
        type: "compaction.started",
        sessionId,
        reason: event.reason,
      });
    });
    pi.on("session_compact", async (event) => {
      await append({
        operationId,
        type: "compaction.completed",
        sessionId,
        reason: event.reason,
        aborted: false,
      });
    });
  };
}

export class AgentSessionPiCodingAgentRunner implements PiCodingAgentRunner {
  async run(input: PiCodingAgentRunInput): Promise<ExecutorStepCandidate> {
    const step = input.request.contract.steps.find(
      (candidate) => candidate.stepId === input.request.stepId,
    );
    if (step === undefined) throw new PiCodingAgentExecutionError("executor.step_not_found");
    const enabledTools = enabledToolsForCapabilities(step.capabilityRefs);
    const sessionId = `pis_${input.request.operationId.slice(4)}`;
    await mkdir(input.cwd, { recursive: true });
    await mkdir(input.agentDir, { recursive: true, mode: 0o700 });
    await mkdir(input.sessionsDir, { recursive: true, mode: 0o700 });

    const modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
    });
    // 执行层直接使用Pi标准models.json/auth.json。命令型apiKey由ModelRuntime
    // 在Provider请求边界解析，Chat不读取、复制或持久密钥正文。
    const model = modelRuntime.getModel(PI_CODING_PROVIDER, PI_CODING_MODEL);
    if (model === undefined)
      throw new PiCodingAgentExecutionError("provider.pre_request.model_missing");
    let modelUrl: URL;
    try {
      modelUrl = new URL(model.baseUrl);
    } catch {
      throw new PiCodingAgentExecutionError("provider.pre_request.model_endpoint_invalid");
    }
    if (modelUrl.protocol !== "https:") {
      throw new PiCodingAgentExecutionError("provider.pre_request.model_endpoint_invalid");
    }
    assertAllowedBailianHost(modelUrl.hostname);

    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      defaultThinkingLevel: "medium",
    });
    const state = createCodingExecutorJournalState();
    const journalExtension = createCodingExecutorJournalExtension({
      request: input.request,
      sessionId,
      workspaceRoot: input.cwd,
      endpointHost: modelUrl.hostname,
      store: input.store,
      state,
    });
    const userPromptLayer = governedUserPromptLayer(input.request.nodePrompt?.systemPromptAppend);
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: input.agentDir,
      settingsManager,
      extensionFactories: [
        { name: "chat-operation-journal", factory: journalExtension, hidden: true },
      ],
      // 外部Extension是任意本机代码，无法被Tool白名单和Journal约束；当前只加载
      // Chat内联审计Extension。Skills/AGENTS/Prompt Template统一关闭，用户层只接受
      // Application从冻结Prompt Assembly授权的正文。
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      // 显式拒绝Workspace/Agent目录的SYSTEM.md替换；undefined让Pi使用固定版本默认基础Prompt。
      systemPromptOverride: () =>
        input.request.nodePrompt?.piSystemPrompt?.mode === "replace"
          ? input.request.nodePrompt.piSystemPrompt.bodyMarkdown
          : undefined,
      appendSystemPrompt: [
        CHAT_CODING_EXECUTOR_RUNTIME_PROMPT,
        ...(userPromptLayer === undefined ? [] : [userPromptLayer]),
      ],
      noThemes: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.create(input.cwd, input.sessionsDir, { id: sessionId });
    const localBash = createLocalBashOperations();
    const customTools: ToolDefinition[] = enabledTools.includes("bash")
      ? [
          createBashToolDefinition(input.cwd, {
            exposeSessionEnvironment: false,
            operations: {
              exec: async (command, cwd, options) =>
                await localBash.exec(command, cwd, {
                  ...options,
                  env: executorShellEnvironment(input.agentDir),
                }),
            },
          }) as unknown as ToolDefinition,
        ]
      : [];
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir: input.agentDir,
      modelRuntime,
      model,
      thinkingLevel: "medium",
      tools: [...enabledTools],
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    await input.store.setSession(input.request.operationId, sessionId, enabledTools);

    const abort = () => {
      void session.abort();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      const prompt = buildExecutorUserPrompt(
        input.request.contract,
        input.request.stepId,
        input.request.contextItems,
        input.request.dependencyResults,
      );
      try {
        await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
      } catch (error) {
        if (state.fatalError !== undefined) {
          await settleCodingExecutorFatal({
            operationId: input.request.operationId,
            store: input.store,
            state,
          });
        }
        throw error;
      }
      await settleCodingExecutorFatal({
        operationId: input.request.operationId,
        store: input.store,
        state,
      });
      await input.store.append(input.request.operationId, {
        operationId: input.request.operationId,
        type: "session.settled",
        sessionId,
        turnCount: state.turnIndex + 1,
        providerRequestCount: state.providerRequestCount,
      });
      if (input.signal.aborted) throw new PiCodingAgentExecutionError("executor.timeout");
      const output = assistantText(
        [...session.messages].reverse().find((message) => message.role === "assistant"),
      );
      if (output === undefined)
        throw new PiCodingAgentExecutionError("executor.final_output_missing");
      return projectExecutorStepCandidate(
        { stepId: step.stepId, output },
        step,
        input.request.contract.completionCriteria,
        input.request.contract.steps.at(-1)?.stepId === step.stepId,
      );
    } finally {
      input.signal.removeEventListener("abort", abort);
      session.dispose();
    }
  }
}
