import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { assertAllowedBailianHost } from "./config.js";
import { assertExecutorWorkspacePath } from "./coding-agent-executor.js";
import type { PiDirectExecutorOperationStore } from "./direct-executor-operation-store.js";
import type { StartPiDirectExecutorOperationRequest } from "./direct-executor-service-contract.js";
import type { ProjectBootstrapProductPort } from "./direct-executor-service.js";
import { hashExecutorValue } from "./executor-operation-store.js";
import {
  DirectPromptReviewCoordinator,
  PromptReviewRejectedError,
  PromptReviewWaitInterruptedError,
} from "./prompt-review-gate.js";

/** P1固定运行配置；审核正文禁止隐藏推理字段，因此生成与默认值都关闭thinking。 */
export const P1_DIRECT_AGENT_PROFILE = {
  providerId: "dashscope-coding",
  modelId: "qwen3.7-plus",
  capabilityMode: "read_only",
  enabledTools: ["read", "grep", "find", "ls"],
  thinkingLevel: "off",
  retryEnabled: false,
  compactionEnabled: false,
  branchSummarySkipPrompt: true,
  noExtensions: true,
} as const;
const DIRECT_AGENT_APPEND_SYSTEM_PROMPT = [
  "你正在Chat的Direct Agent只读节点中工作。",
  "每次模型请求发送前都会暂停并等待用户审核最终Provider Payload。",
  "你只能读取当前Workspace，不能写文件、执行Shell或扩大任务范围。",
  "完成后给出完整可读结果；不要声称Product Run已经正式提交。",
].join("\n");
const PROJECT_BOOTSTRAP_TOOL = "project_bootstrap_prepare";

export class DirectAgentExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DirectAgentExecutionError";
  }
}

/** 等待态不是失败；Service保持Operation事实并让Workflow进入Prompt Review节点。 */
export class DirectAgentSuspendedError extends Error {
  readonly code = "direct_executor.waiting_prompt_review";

  constructor() {
    super("Direct Agent正在等待Prompt Review");
    this.name = "DirectAgentSuspendedError";
  }
}

export interface DirectAgentRunInput {
  readonly request: StartPiDirectExecutorOperationRequest;
  readonly prompt: string;
  readonly systemPromptAppend: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly store: PiDirectExecutorOperationStore;
  readonly capabilityMode: "read_only" | "project_bootstrap";
  readonly projectBootstrapContext?: {
    readonly providerKind: "plane_ce";
    readonly providerVersion: string;
    readonly planeWorkspaceSlugs: readonly string[];
    readonly creationRoots: readonly { readonly rootId: string; readonly displayName: string }[];
  };
  readonly projectBootstrapProduct?: ProjectBootstrapProductPort;
  readonly promptReview: DirectPromptReviewCoordinator;
  readonly promptReviewMode: "manual" | "off";
  readonly signal: AbortSignal;
  readonly resume: boolean;
  readonly pauseExecutionTimeout?: () => void;
  readonly resumeExecutionTimeout?: () => void;
}

export interface DirectAgentRunner {
  run(input: DirectAgentRunInput): Promise<string>;
}

function assistantText(message: AgentMessage | undefined): string | undefined {
  if (message?.role !== "assistant") return undefined;
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}

function createControlledJournalExtension(input: {
  readonly operationId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly store: PiDirectExecutorOperationStore;
  readonly allowedTools: readonly string[];
}): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event: ToolCallEvent) => {
      if (!input.allowedTools.includes(event.toolName)) {
        throw new DirectAgentExecutionError("direct_executor.tool_not_allowed");
      }
      if (P1_DIRECT_AGENT_PROFILE.enabledTools.includes(event.toolName as never)) {
        const path = "path" in event.input ? event.input.path : undefined;
        await assertExecutorWorkspacePath(path ?? ".", input.workspaceRoot);
      }
      await input.store.appendToolIntent({
        operationId: input.operationId,
        sessionId: input.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputSha256: hashExecutorValue(event.input),
      });
    });
    pi.on("tool_result", async (event: ToolResultEvent) => {
      await input.store.closeToolIntent({
        operationId: input.operationId,
        sessionId: input.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultSha256: hashExecutorValue({
          content: event.content,
          details: event.details,
          isError: event.isError,
          usage: event.usage,
        }),
        failed: event.isError,
      });
    });
  };
}

function createProjectBootstrapExtension(input: {
  readonly productRunId: string;
  readonly product: ProjectBootstrapProductPort;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool({
        name: PROJECT_BOOTSTRAP_TOOL,
        label: "准备项目初始化",
        description:
          "预检本地Workspace与Plane CE名称，生成需要用户确认的项目初始化候选；不会直接创建目录或Plane项目。",
        promptSnippet: "准备受控的Plane CE + Git Workspace项目初始化候选",
        promptGuidelines: [
          "先确认项目目标、Plane标识、本地目录和初始模块，再调用一次。",
          "工具返回prepared只表示候选已落盘；必须明确告诉用户仍需审核确认，不能声称项目已创建。",
        ],
        executionMode: "sequential",
        parameters: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 160 }),
            objective: Type.String({ minLength: 1, maxLength: 4000 }),
            planeWorkspaceSlug: Type.String({ minLength: 1, maxLength: 80 }),
            planeProjectIdentifier: Type.String({ minLength: 1, maxLength: 12 }),
            workspaceRootId: Type.String({ minLength: 1, maxLength: 120 }),
            directoryName: Type.String({ minLength: 1, maxLength: 120 }),
            initializerProfile: Type.Union([Type.Literal("blank"), Type.Literal("ai_learning")]),
            initialModules: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
              maxItems: 8,
            }),
          },
          { additionalProperties: false },
        ),
        async execute(toolCallId, params, signal) {
          if (signal?.aborted === true)
            throw new DirectAgentExecutionError("direct_executor.timeout");
          const commandId = `cmd_${createHash("sha256")
            .update(`${input.productRunId}\n${toolCallId}`, "utf8")
            .digest("hex")
            .slice(0, 48)}`;
          const candidate = await input.product.prepare({
            commandId,
            productRunId: input.productRunId,
            proposal: {
              name: params.name,
              objective: params.objective,
              planeWorkspaceSlug: params.planeWorkspaceSlug,
              planeProjectIdentifier: params.planeProjectIdentifier,
              workspaceRootId: params.workspaceRootId,
              directoryName: params.directoryName,
              initializerProfile: params.initializerProfile,
              initialModules: params.initialModules,
            },
          });
          const summary = {
            projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
            candidateRevision: candidate.revision,
            candidateSha256: candidate.sha256,
            status: candidate.status,
            preview: candidate.preview,
          };
          return {
            content: [
              {
                type: "text",
                text: `${JSON.stringify(summary)}\n候选已准备，尚未创建任何外部资源；请让用户审核确认。`,
              },
            ],
            details: summary,
          };
        },
      }),
    );
  };
}

/**
 * P1固定Direct Profile：真实AgentSession + read/grep/find/ls；自动重试、Compaction、
 * Branch Summary和外部Extension全部关闭，保证每个模型请求只能经过同一个Gate。
 */
export class AgentSessionPiDirectAgentRunner implements DirectAgentRunner {
  async run(input: DirectAgentRunInput): Promise<string> {
    await mkdir(input.cwd, { recursive: true });
    await mkdir(input.agentDir, { recursive: true, mode: 0o700 });
    await mkdir(input.sessionsDir, { recursive: true, mode: 0o700 });

    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    const model = modelRuntime.getModel(
      P1_DIRECT_AGENT_PROFILE.providerId,
      P1_DIRECT_AGENT_PROFILE.modelId,
    );
    if (model === undefined)
      throw new DirectAgentExecutionError("provider.pre_request.model_missing");
    let modelUrl: URL;
    try {
      modelUrl = new URL(model.baseUrl);
    } catch {
      throw new DirectAgentExecutionError("provider.pre_request.model_endpoint_invalid");
    }
    if (modelUrl.protocol !== "https:") {
      throw new DirectAgentExecutionError("provider.pre_request.model_endpoint_invalid");
    }
    assertAllowedBailianHost(modelUrl.hostname);

    const settingsManager = SettingsManager.inMemory({
      retry: {
        enabled: P1_DIRECT_AGENT_PROFILE.retryEnabled,
        provider: { maxRetries: 0 },
      },
      compaction: { enabled: P1_DIRECT_AGENT_PROFILE.compactionEnabled },
      branchSummary: { skipPrompt: P1_DIRECT_AGENT_PROFILE.branchSummarySkipPrompt },
      defaultThinkingLevel: P1_DIRECT_AGENT_PROFILE.thinkingLevel,
    });
    const sessionId = `pis_${input.request.operationId.slice(4)}`;
    const allowedTools = [
      ...P1_DIRECT_AGENT_PROFILE.enabledTools,
      ...(input.capabilityMode === "project_bootstrap" ? [PROJECT_BOOTSTRAP_TOOL] : []),
    ];
    if (
      input.capabilityMode === "project_bootstrap" &&
      (input.projectBootstrapContext === undefined || input.projectBootstrapProduct === undefined)
    ) {
      throw new DirectAgentExecutionError("direct_executor.project_bootstrap_context_missing");
    }
    const journalExtension = createControlledJournalExtension({
      operationId: input.request.operationId,
      sessionId,
      workspaceRoot: input.cwd,
      store: input.store,
      allowedTools,
    });
    const projectBootstrapExtension =
      input.capabilityMode === "project_bootstrap"
        ? createProjectBootstrapExtension({
            productRunId: input.request.productRunId,
            product: input.projectBootstrapProduct!,
          })
        : undefined;
    const projectBootstrapPrompt =
      input.projectBootstrapContext === undefined
        ? undefined
        : [
            "你还可以准备一个受控的Plane CE项目初始化候选。",
            `Plane CE版本:${input.projectBootstrapContext.providerVersion}`,
            `允许的Plane Workspace:${input.projectBootstrapContext.planeWorkspaceSlugs.join(", ")}`,
            `允许的本地创建Root:${input.projectBootstrapContext.creationRoots
              .map((root) => `${root.rootId}(${root.displayName})`)
              .join(", ")}`,
            "project_bootstrap_prepare只预检并保存候选；候选必须由用户确认后，Chat Application才会创建Git Workspace和Plane项目。",
          ].join("\n");
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: input.agentDir,
      settingsManager,
      extensionFactories: [
        { name: "chat-direct-operation-journal", factory: journalExtension, hidden: true },
        ...(projectBootstrapExtension === undefined
          ? []
          : [
              {
                name: "chat-project-bootstrap-tools",
                factory: projectBootstrapExtension,
                hidden: true,
              },
            ]),
      ],
      noExtensions: P1_DIRECT_AGENT_PROFILE.noExtensions,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: "",
      appendSystemPrompt: [
        DIRECT_AGENT_APPEND_SYSTEM_PROMPT,
        ...(projectBootstrapPrompt === undefined ? [] : [projectBootstrapPrompt]),
        ...(input.systemPromptAppend === "" ? [] : [input.systemPromptAppend]),
      ],
      noThemes: true,
    });
    await resourceLoader.reload();

    let sessionManager: SessionManager;
    let resumedCheckpointSha256: string | undefined;
    if (input.resume) {
      const active = input.store.getActivePromptReview(input.request.operationId);
      if (active === undefined) {
        throw new DirectAgentExecutionError("direct_executor.prompt_review_checkpoint_missing");
      }
      sessionManager = await input.promptReview.openCheckpoint({
        checkpoint: active.checkpoint,
        cwd: input.cwd,
        sessionsDirectory: input.sessionsDir,
      });
      resumedCheckpointSha256 = active.checkpoint.fileSha256;
    } else {
      sessionManager = SessionManager.create(input.cwd, input.sessionsDir, { id: sessionId });
    }

    const sessionForProviderGate: { current?: AgentSession } = {};
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir: input.agentDir,
      modelRuntime,
      model,
      thinkingLevel: P1_DIRECT_AGENT_PROFILE.thinkingLevel,
      tools: allowedTools,
      resourceLoader,
      sessionManager,
      settingsManager,
      providerRequestGate: async (payload, payloadModel) => {
        const activeSession = sessionForProviderGate.current;
        if (activeSession === undefined) {
          throw new DirectAgentExecutionError("direct_executor.session_gate_not_ready");
        }
        let requestUrl: URL;
        try {
          requestUrl = new URL(payloadModel.baseUrl);
        } catch {
          throw new DirectAgentExecutionError("provider.pre_request.model_endpoint_invalid");
        }
        if (requestUrl.protocol !== "https:") {
          throw new DirectAgentExecutionError("provider.pre_request.model_endpoint_invalid");
        }
        assertAllowedBailianHost(requestUrl.hostname);
        return input.promptReview.intercept({
          operationId: input.request.operationId,
          providerId: payloadModel.provider,
          modelId: payloadModel.id,
          endpointHost: requestUrl.hostname,
          payload,
          session: activeSession,
          promptReviewMode: input.promptReviewMode,
          signal: input.signal,
          ...(input.pauseExecutionTimeout === undefined
            ? {}
            : { pauseExecutionTimeout: input.pauseExecutionTimeout }),
          ...(input.resumeExecutionTimeout === undefined
            ? {}
            : { resumeExecutionTimeout: input.resumeExecutionTimeout }),
        });
      },
    });
    sessionForProviderGate.current = session;
    await input.store.setSession({
      operationId: input.request.operationId,
      sessionId: session.sessionId,
      enabledTools: allowedTools,
      ...(resumedCheckpointSha256 === undefined
        ? {}
        : { resumedFromCheckpointSha256: resumedCheckpointSha256 }),
    });

    // Agent核心listener是awaited的；Provider响应只有在Assistant消息及Pi Session已经
    // 持久化后才从dispatching回到running。写入失败会让dispatching在重启时变unknown。
    const unsubscribeCritical = session.agent.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      if (input.store.getSnapshot(input.request.operationId).status !== "dispatching") return;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        // 若前一个成功Assistant已落provider.completed，只是Product结算listener失败，
        // 后续合成的error消息不能把已知Provider响应改写成Provider outcome_unknown。
        if (input.store.hasProviderCompletion(input.request.operationId)) return;
        await input.promptReview.markProviderOutcomeUnknown(
          input.request.operationId,
          "direct_executor.provider_outcome_unknown",
        );
        return;
      }
      await input.promptReview.markProviderSettled({
        operationId: input.request.operationId,
        completionTokens: event.message.usage.output,
        stopReason: event.message.stopReason === "pending" ? "error" : event.message.stopReason,
      });
    });
    const abort = () => {
      void session.abort();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.resume) await session.resumePendingTurn();
      else {
        await session.prompt(input.prompt, {
          expandPromptTemplates: false,
          source: "extension",
        });
      }
      const snapshot = input.store.getSnapshot(input.request.operationId);
      if (
        snapshot.status === "preparing_prompt_review" ||
        snapshot.status === "waiting_prompt_review"
      ) {
        throw new DirectAgentSuspendedError();
      }
      if (snapshot.status === "cancelled") throw new PromptReviewRejectedError();
      if (snapshot.status === "outcome_unknown") {
        throw new DirectAgentExecutionError(
          snapshot.errorCode ?? "direct_executor.operation_outcome_unknown",
        );
      }
      if (input.signal.aborted) throw new DirectAgentExecutionError("direct_executor.timeout");
      const output = assistantText(
        [...session.messages].reverse().find((message) => message.role === "assistant"),
      );
      if (output === undefined) {
        throw new DirectAgentExecutionError("direct_executor.final_output_missing");
      }
      return output;
    } catch (error) {
      if (
        error instanceof PromptReviewWaitInterruptedError ||
        input.store.getSnapshot(input.request.operationId).status === "waiting_prompt_review"
      ) {
        throw new DirectAgentSuspendedError();
      }
      throw error;
    } finally {
      input.signal.removeEventListener("abort", abort);
      unsubscribeCritical();
      session.dispose();
    }
  }
}
