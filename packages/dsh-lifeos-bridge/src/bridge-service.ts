import {
  BRIDGE_SCHEMA_VERSION,
  projectBootstrapPresetSchema,
  SESSION_RECORDS_SCHEMA_VERSION,
  decisionRequestSchema,
  dshBridgeSendPreviewSchema,
  noteDecisionRequestSchema,
  PROMPT_SELECTION_SCHEMA_VERSION,
  promptSelectionProjectionSchema,
  promptReviewDecisionRequestSchema,
  type ChatApproval,
  type ChatNoteCandidate,
  type ChatPlan,
  type ChatPromptReview,
  type ChatRun,
  type DecisionRequest,
  type DshSendReviewDecisionRequest,
  type BridgeChatDispatchReviewDecisionRequest,
  type NoteDecisionRequest,
  type PromptSelection,
  type PromptSelectionProjection,
  type PromptReviewDecisionRequest,
  type ProjectBootstrapDecisionRequest,
  type ProjectBootstrapPreset,
  type LifeosExecutionTrace,
  type LifeosProjection,
  type LifeosWorkflowOption,
  type SessionRecordsChatPage,
  type SessionRecordsDshPage,
  type SessionRecordsOverview,
  type SaveWorkflowAgentNodeConfigurationRequest,
  sessionRecordsChatPageSchema,
  sessionRecordsDshPageSchema,
  sessionRecordsOverviewSchema,
  type WorkflowSelection,
  type DshContextInjectionProjection,
  type DshAdapterRequestCapture,
} from "./contracts.ts";
import { ChatProductApiError, ChatProductClient } from "./chat-client.ts";
import { sha256, stableCommandId } from "./adapter.ts";
import {
  AtomicBridgeStateStore,
  type PendingDecision,
  type PendingNoteDecision,
  type PendingPromptReviewDecision,
  type SessionBinding,
} from "./state-store.ts";
import type { DshSessionHistoryPort } from "./dsh-session-history.ts";
import type { DshContextInjectionReader } from "./context-injection-reader.ts";
import type { DshSendReviewCoordinator } from "./dsh-send-review.ts";
import type { BridgeDispatchReviewCoordinator } from "./bridge-dispatch-review.ts";
import {
  promptSelectionForWorkspace,
  promptSelectionForWorkflow,
  type PromptWorkspaceResolver,
} from "./prompt-workspace-resolver.ts";
import { exactSectionsFromJson, lastDshUserInputMapping } from "./dsh-bridge-readable.ts";
import { bridgeChatSubmitPayload } from "./bridge-chat-dispatch.ts";
import { productSessionIdSchema } from "@chat/contracts/public";

export class BridgeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

function isDeterministicDecisionRejection(error: unknown): error is ChatProductApiError {
  return (
    error instanceof ChatProductApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !error.retryable
  );
}

function newestPlan<T extends { planRevision: number }>(plans: readonly T[]): T | null {
  return plans.reduce<T | null>(
    (latest, plan) => (latest === null || plan.planRevision > latest.planRevision ? plan : latest),
    null,
  );
}

function planForProjection(
  run: ChatRun,
  plans: readonly ChatPlan[],
  approval: ChatApproval | null,
): ChatPlan | null {
  const binding = approval ?? run.currentPlan;
  if (binding === undefined || binding === null) return newestPlan(plans);
  return (
    plans.find(
      (plan) =>
        plan.planId === binding.planId &&
        plan.planRevision === binding.planRevision &&
        plan.sha256 === ("planSha256" in binding ? binding.planSha256 : binding.sha256),
    ) ?? null
  );
}

const PLANNING_PROJECTION_PHASES = new Set<ChatRun["phase"]>([
  "planning",
  "plan_review",
  "executing",
  "validating",
]);

function decisionBodySha256(request: DecisionRequest): string {
  return sha256(JSON.stringify({ kind: request.kind, explanation: request.explanation ?? null }));
}

function isStableExecutionTrace(trace: LifeosExecutionTrace["trace"]): boolean {
  const runTerminal = ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(
    trace.run.status,
  );
  const nodesTerminal = trace.workflow.nodeRuns.every(
    (node) => !["pending", "running", "waiting_human"].includes(node.status),
  );
  const piTerminal = trace.piActivities.every((activity) => activity.status !== "running");
  return (
    runTerminal &&
    nodesTerminal &&
    piTerminal &&
    trace.runtime.availability === "available" &&
    !trace.runtime.isLive
  );
}

function pendingFrom(dshSessionId: string, request: DecisionRequest): PendingDecision {
  const bodySha256 = decisionBodySha256(request);
  const observed = request.binding;
  return {
    bodySha256,
    commandId: stableCommandId(
      "submit-decision",
      dshSessionId,
      observed.approvalRequestId,
      request.kind,
      bodySha256,
    ),
    productRunId: observed.productRunId,
    expectedRunRevision: observed.runRevision,
    approvalRequestId: observed.approvalRequestId,
    planId: observed.planId,
    planRevision: observed.planRevision,
    planSha256: observed.planSha256,
    request,
  };
}

function noteDecisionBodySha256(request: NoteDecisionRequest): string {
  return sha256(JSON.stringify({ kind: request.kind, explanation: request.explanation ?? null }));
}

function pendingNoteFrom(dshSessionId: string, request: NoteDecisionRequest): PendingNoteDecision {
  const bodySha256 = noteDecisionBodySha256(request);
  const observed = request.binding;
  return {
    bodySha256,
    commandId: stableCommandId(
      "submit-note-decision",
      dshSessionId,
      observed.noteCandidateId,
      request.kind,
      bodySha256,
    ),
    productRunId: observed.productRunId,
    expectedRunRevision: observed.runRevision,
    noteCandidateId: observed.noteCandidateId,
    candidateRevision: observed.candidateRevision,
    candidateSha256: observed.candidateSha256,
    request,
  };
}

function promptReviewDecisionBodySha256(request: PromptReviewDecisionRequest): string {
  return sha256(JSON.stringify({ kind: request.kind, explanation: request.explanation ?? null }));
}

function pendingPromptReviewFrom(
  dshSessionId: string,
  request: PromptReviewDecisionRequest,
): PendingPromptReviewDecision {
  const bodySha256 = promptReviewDecisionBodySha256(request);
  const observed = request.binding;
  return {
    bodySha256,
    commandId: stableCommandId(
      "submit-prompt-review-decision",
      dshSessionId,
      observed.promptReviewRequestId,
      request.kind,
      bodySha256,
    ),
    productRunId: observed.productRunId,
    expectedRunRevision: observed.runRevision,
    promptReviewRequestId: observed.promptReviewRequestId,
    requestRevision: observed.requestRevision,
    reviewSha256: observed.reviewSha256,
    payloadSha256: observed.payloadSha256,
    request,
  };
}

/**
 * Browser read model与HITL命令代理；它只转交意图和投影，不拥有产品事实。
 * Run、Plan、Approval和Decision的权威版本始终由Chat Product Store提交。
 */
export class LifeosBridgeService {
  private readonly stableExecutionTraces = new Map<string, LifeosExecutionTrace["trace"]>();
  private projectBootstrapConfiguration:
    ReturnType<ChatProductClient["getProjectBootstrapConfiguration"]> | undefined;

  constructor(
    private readonly chat: ChatProductClient,
    private readonly state: AtomicBridgeStateStore,
    private readonly dshHistory?: DshSessionHistoryPort,
    private readonly contextInjectionReader?: Pick<DshContextInjectionReader, "read">,
    private readonly promptWorkspaceResolver?: PromptWorkspaceResolver,
    private readonly dshSendReview?: DshSendReviewCoordinator,
    private readonly bridgeDispatchReview?: BridgeDispatchReviewCoordinator,
  ) {}

  private history(): DshSessionHistoryPort {
    if (this.dshHistory === undefined) {
      throw new BridgeRequestError(
        503,
        "lifeos_session_history_unavailable",
        "DSH Session历史服务不可用",
      );
    }
    return this.dshHistory;
  }

  async projectBootstrapPreset(signal?: AbortSignal): Promise<ProjectBootstrapPreset> {
    const configuration = await this.loadProjectBootstrapConfiguration();
    if (!configuration.enabled) return { enabled: false };
    const workflows = await this.chat.listWorkflows(signal);
    const workflow = workflows.find(
      (item) => item.blueprintKey === "direct" && item.ownerKind === "system",
    );
    const capabilityNode = workflow?.configurableNodes.find((node) =>
      node.fields.some((field) => field.name === "capabilityMode"),
    );
    if (workflow === undefined || capabilityNode === undefined) {
      throw new BridgeRequestError(
        409,
        "lifeos_project_bootstrap_workflow_unavailable",
        "系统Direct Agent未发布project_bootstrap配置",
      );
    }
    return projectBootstrapPresetSchema.parse({
      enabled: true,
      configuration,
      workflowSelection: {
        workflowDefinitionRevisionId: workflow.workflowDefinitionRevisionId,
        definitionSha256: workflow.definitionSha256,
        title: workflow.title,
        blueprintKey: workflow.blueprintKey,
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "node_config",
              definitionNodeId: capabilityNode.definitionNodeId,
              field: "capabilityMode",
              value: "project_bootstrap",
            },
          ],
        },
      },
      promptSelection: {
        schemaVersion: "prompt-turn-selection-input.v1",
        regions: [],
      },
    });
  }

  private async loadProjectBootstrapConfiguration() {
    this.projectBootstrapConfiguration ??= this.chat.getProjectBootstrapConfiguration();
    try {
      return await this.projectBootstrapConfiguration;
    } catch (error) {
      this.projectBootstrapConfiguration = undefined;
      throw error;
    }
  }

  private async currentProjectBootstrap(productSessionId: string, signal?: AbortSignal) {
    const read = this.chat.getCurrentProjectBootstrap;
    if (typeof read !== "function") return null;
    return read.call(this.chat, productSessionId, signal);
  }

  private async projectBootstrapTargets(
    projectBootstrap: Awaited<ReturnType<ChatProductClient["getCurrentProjectBootstrap"]>>,
  ): Promise<{ workspaceCwd?: string; planeUrl?: string } | null> {
    if (projectBootstrap?.binding === undefined) return null;
    const configuration = await this.loadProjectBootstrapConfiguration();
    const workspaceCwd = await this.promptWorkspaceResolver?.resolveCreationTarget?.(
      projectBootstrap.binding.workspaceRootId,
      projectBootstrap.binding.directoryName,
    );
    const planeUrl = configuration.enabled
      ? new URL(
          `${encodeURIComponent(projectBootstrap.binding.planeWorkspaceSlug)}/projects/${encodeURIComponent(projectBootstrap.binding.planeProjectId)}/issues`,
          `${configuration.providerWebBaseUrl.replace(/\/$/u, "")}/`,
        ).toString()
      : undefined;
    return {
      ...(workspaceCwd === undefined ? {} : { workspaceCwd }),
      ...(planeUrl === undefined ? {} : { planeUrl }),
    };
  }

  async initializeProjectBootstrapSession(
    dshSessionId: string,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    const preset = await this.projectBootstrapPreset(signal);
    if (!preset.enabled) {
      throw new BridgeRequestError(
        409,
        "lifeos_project_bootstrap_disabled",
        "当前部署未配置Plane CE项目初始化能力",
      );
    }
    const createCommandId = stableCommandId("create-session", dshSessionId);
    const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
    const promptSelection: PromptSelection = {
      ...preset.promptSelection,
      ...(workspace === null ? {} : { workspaceRootId: workspace.rootId }),
    };
    await this.state.selectWorkflowForSession(
      dshSessionId,
      createCommandId,
      preset.workflowSelection,
    );
    await this.state.selectPrompt(dshSessionId, createCommandId, promptSelection);
    return this.projection(dshSessionId, signal);
  }

  /**
   * DSH专属统一会话读模型：只在查询时组合两侧事实。Product Session和DSH
   * Session仍各自持久化、各自拥有revision/lifecycle，不生成第三个会话实体。
   */
  async sessionRecordsOverview(
    dshSessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionRecordsOverview> {
    const [dsh, binding] = await Promise.all([
      this.history().describe(dshSessionId, signal),
      this.state.readSession(dshSessionId),
    ]);
    const chat =
      binding?.chatSessionId === undefined
        ? null
        : await this.chat.getSession(binding.chatSessionId, signal);
    const requests = Object.values(binding?.requests ?? {});
    const current =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    return sessionRecordsOverviewSchema.parse({
      schemaVersion: SESSION_RECORDS_SCHEMA_VERSION,
      dsh,
      chat,
      binding: {
        status: binding?.chatSessionId === undefined ? "draft" : "bound",
        productSessionId: binding?.chatSessionId ?? null,
        requestCount: requests.length,
        linkedUserMessageCount: requests.filter(
          (request) => request.productUserMessageId !== undefined,
        ).length,
        linkedAssistantMessageCount: requests.filter(
          (request) => request.productAssistantMessageId !== undefined,
        ).length,
        currentProductRunId: current?.productRunId ?? null,
      },
      capabilities: {
        continueConversation: !dsh.archived && (chat === null || chat.status === "active"),
        archiveKeepsData: true,
        permanentDelete: false,
      },
    });
  }

  /** Chat正式Message的完整cursor页；link只是Bridge身份投影，不复制Message正文。 */
  async sessionRecordsChatPage(
    dshSessionId: string,
    cursor: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SessionRecordsChatPage> {
    const [, binding] = await Promise.all([
      this.history().assertAccessible(dshSessionId, signal),
      this.state.readSession(dshSessionId),
    ]);
    if (binding?.chatSessionId === undefined) {
      return sessionRecordsChatPageSchema.parse({
        schemaVersion: SESSION_RECORDS_SCHEMA_VERSION,
        dshSessionId,
        productSessionId: null,
        messages: { items: [] },
      });
    }
    const page = await this.chat.getMessages(binding.chatSessionId, cursor, limit, signal);
    const linksByMessageId = new Map<string, { dshMessageId?: string; productRunId?: string }>();
    for (const request of Object.values(binding.requests)) {
      if (request.productUserMessageId !== undefined) {
        linksByMessageId.set(request.productUserMessageId, {
          ...(request.dshMessageId === undefined ? {} : { dshMessageId: request.dshMessageId }),
          ...(request.productRunId === undefined ? {} : { productRunId: request.productRunId }),
        });
      }
      if (request.productAssistantMessageId !== undefined) {
        linksByMessageId.set(request.productAssistantMessageId, {
          ...(request.productRunId === undefined ? {} : { productRunId: request.productRunId }),
        });
      }
    }
    return sessionRecordsChatPageSchema.parse({
      schemaVersion: SESSION_RECORDS_SCHEMA_VERSION,
      dshSessionId,
      productSessionId: binding.chatSessionId,
      messages: {
        items: page.items.map((message) => ({
          message,
          link:
            linksByMessageId.get(message.messageId) ??
            (message.sourceRunId === undefined ? {} : { productRunId: message.sourceRunId }),
        })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    });
  }

  /** DSH Session完整原始事件的seq页；只分页，不裁剪任何单条事件。 */
  async sessionRecordsDshPage(
    dshSessionId: string,
    afterSeq: number | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SessionRecordsDshPage> {
    const page = await this.history().readEvents(dshSessionId, afterSeq, limit, signal);
    return sessionRecordsDshPageSchema.parse({
      schemaVersion: SESSION_RECORDS_SCHEMA_VERSION,
      dshSessionId,
      header: page.header,
      items: page.items,
      hasMore: page.hasMore,
      ...(page.nextAfterSeq === undefined ? {} : { nextAfterSeq: page.nextAfterSeq }),
    });
  }

  /** DSH 自己的模型上下文只读投影；它不是 Chat Product Store 事实。 */
  contextInjections(dshSessionId: string): DshContextInjectionProjection {
    const projection = this.contextInjectionReader?.read(dshSessionId) ?? null;
    if (projection === null) {
      throw new BridgeRequestError(
        404,
        "lifeos_dsh_session_not_found",
        "当前 DSH 会话不存在或尚未恢复",
      );
    }
    return projection;
  }

  /**
   * 发送前只读投影。DSH Context只作为边界证据展示；实际Chat payload只采用
   * 当前User、Workflow选择和Prompt选择，不创建Request Binding或产品事实。
   */
  async bridgeSendPreview(
    dshSessionId: string,
    text: string,
    adapterRequest: DshAdapterRequestCapture = {
      status: "not_captured",
      reason: "native_send_not_started",
    },
  ) {
    const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
    const [binding, workflowSelection, storedPromptSelection] = await Promise.all([
      this.state.readSession(dshSessionId),
      this.state.readWorkflowSelection(dshSessionId),
      this.state.readPromptSelection(dshSessionId),
    ]);
    const promptSelection = promptSelectionForWorkspace(storedPromptSelection, workspace);
    const contextInjections = this.contextInjections(dshSessionId);
    const payload = bridgeChatSubmitPayload({
      text,
      ...(workflowSelection === null ? {} : { workflowSelection }),
      promptSelection,
    });
    const [promptConfiguration, promptTurnPreview] = await Promise.all([
      this.chat.previewPromptConfiguration({ selection: promptSelection }),
      this.chat.previewPromptTurn({
        ...(binding?.chatSessionId === undefined
          ? {}
          : { sessionId: productSessionIdSchema.parse(binding.chatSessionId) }),
        message: payload,
      }),
    ]);
    const payloadJson = JSON.stringify(payload, null, 2);
    const payloadSha256 = sha256(payloadJson);
    if (adapterRequest.status === "captured") {
      const rawUserInput = lastDshUserInputMapping(adapterRequest.requestJson);
      if (rawUserInput === null || rawUserInput.text !== text) {
        throw new BridgeRequestError(
          500,
          "lifeos_dsh_raw_mapping_mismatch",
          "DSH原始请求与Bridge提取的用户输入不一致，已停止发送",
        );
      }
      console.info("[lifeos-bridge] dsh_to_chat_payload_projected", {
        event: "lifeos.dsh_to_chat_payload.projected",
        dshRequestSha256: adapterRequest.requestSha256,
        bridgePayloadSha256: payloadSha256,
        userInputSha256: sha256(text),
        payloadTextMatchesExtractedUserInput: payload.text === text,
        dshRawUserInput:
          rawUserInput === null
            ? null
            : {
                messageJsonPointer: rawUserInput.messageJsonPointer,
                textJsonPointers: rawUserInput.textJsonPointers,
                textSha256: sha256(rawUserInput.text),
              },
        payloadTextMatchesDshRawUserInput:
          rawUserInput !== null && payload.text === rawUserInput.text,
        sections: exactSectionsFromJson(payloadJson).map((section) => ({
          jsonPointer: section.jsonPointer,
          valueSha256: sha256(section.valueJson),
          valueCharacters: section.valueJson.length,
        })),
      });
    }
    return dshBridgeSendPreviewSchema.parse({
      schemaVersion: "chat-dsh-bridge-send-preview.v2",
      boundary: "dsh_to_lifeos_bridge",
      status: "pre_send_projection",
      workspace,
      workflowSelection,
      promptSelection,
      promptConfiguration,
      promptTurnPreview,
      dshToBridge: {
        adapterRequest,
        userInput: { text, sha256: sha256(text) },
        contextInjections,
      },
      bridgeToChat: {
        policy: "workflow_prompt_selection",
        payload,
        payloadJson,
        payloadSha256,
      },
    });
  }

  async projection(dshSessionId: string, signal?: AbortSignal): Promise<LifeosProjection> {
    const binding = await this.state.readSession(dshSessionId);
    const workflowSelection = await this.state.readWorkflowSelection(dshSessionId);
    const dshSendReviewEnabled = await this.state.readDshSendReviewEnabled(dshSessionId);
    const dshSendReview = this.dshSendReview?.current(dshSessionId) ?? null;
    const bridgeDispatchReviewEnabled =
      await this.state.readBridgeDispatchReviewEnabled(dshSessionId);
    const bridgeDispatchReview = this.bridgeDispatchReview?.current(dshSessionId) ?? null;
    const executionTracesPromise = this.executionTraces(dshSessionId, binding, signal);
    const projectBootstrapPromise =
      binding?.chatSessionId === undefined
        ? Promise.resolve(null)
        : this.currentProjectBootstrap(binding.chatSessionId, signal);
    const projectBootstrapTargetsPromise = projectBootstrapPromise.then((projectBootstrap) =>
      this.projectBootstrapTargets(projectBootstrap),
    );
    const current =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    if (current?.productRunId === undefined) {
      return {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        dshSessionId,
        run: null,
        plan: null,
        approval: null,
        pendingDecision: current?.pendingDecision?.request ?? null,
        noteCandidate: null,
        pendingNoteDecision: current?.pendingNoteDecision?.request ?? null,
        promptReview: null,
        pendingPromptReviewDecision: current?.pendingPromptReviewDecision?.request ?? null,
        dshSendReviewEnabled,
        dshSendReview,
        bridgeDispatchReviewEnabled,
        bridgeDispatchReview,
        projectBootstrap: await projectBootstrapPromise,
        projectBootstrapTargets: await projectBootstrapTargetsPromise,
        workflowSelection,
        executionTraces: await executionTracesPromise,
      };
    }
    const [run, executionTraces, projectBootstrap, projectBootstrapTargets] = await Promise.all([
      this.chat.getRun(current.productRunId, signal),
      executionTracesPromise,
      projectBootstrapPromise,
      projectBootstrapTargetsPromise,
    ]);
    let plan: ChatPlan | null = null;
    let approval: ChatApproval | null = null;
    let noteCandidate: ChatNoteCandidate | null = null;
    let promptReview: ChatPromptReview | null = null;
    if (run.phase === "prompt_review" || current.pendingPromptReviewDecision !== undefined) {
      promptReview = await this.chat.getCurrentPromptReview(current.productRunId, signal);
    } else if (run.phase === "note_review" || current.pendingNoteDecision !== undefined) {
      noteCandidate = await this.chat.getNoteCandidate(current.productRunId, signal);
    } else if (
      run.runKind === "planning" &&
      (PLANNING_PROJECTION_PHASES.has(run.phase) ||
        run.currentPlan !== undefined ||
        run.currentApprovalRequestId !== undefined ||
        current.pendingDecision !== undefined)
    ) {
      const [plans, currentApproval] = await Promise.all([
        this.chat.getPlans(current.productRunId, signal),
        this.chat.getApproval(current.productRunId, signal),
      ]);
      plan = planForProjection(run, plans, currentApproval);
      approval = currentApproval;
    }
    return {
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      dshSessionId,
      run: {
        productRunId: run.productRunId,
        status: run.status,
        phase: run.phase,
        ...(run.failure === undefined ? {} : { failure: run.failure }),
        allowedActions: run.allowedActions,
        revision: run.revision,
        updatedAt: run.updatedAt,
      },
      plan,
      approval,
      pendingDecision: current.pendingDecision?.request ?? null,
      noteCandidate,
      pendingNoteDecision: current.pendingNoteDecision?.request ?? null,
      promptReview,
      pendingPromptReviewDecision: current.pendingPromptReviewDecision?.request ?? null,
      dshSendReviewEnabled,
      dshSendReview,
      bridgeDispatchReviewEnabled,
      bridgeDispatchReview,
      projectBootstrap,
      projectBootstrapTargets,
      workflowSelection,
      executionTraces,
    };
  }

  async decideProjectBootstrap(
    dshSessionId: string,
    request: ProjectBootstrapDecisionRequest,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    const binding = await this.state.readSession(dshSessionId);
    if (binding?.chatSessionId === undefined) {
      throw new BridgeRequestError(
        409,
        "lifeos_project_bootstrap_session_missing",
        "建项会话尚未绑定Chat Session",
      );
    }
    const current = await this.chat.getCurrentProjectBootstrap(binding.chatSessionId, signal);
    if (
      current === null ||
      current.candidate.projectBootstrapCandidateId !==
        request.binding.projectBootstrapCandidateId ||
      current.candidate.sha256 !== request.binding.candidateSha256
    ) {
      throw new BridgeRequestError(
        409,
        "lifeos_project_bootstrap_stale",
        "建项候选已经变化，请刷新后重试",
      );
    }
    if (request.kind === "retry") {
      if (current.operation === undefined || current.operation.status === "ready") {
        throw new BridgeRequestError(
          409,
          "lifeos_project_bootstrap_not_retryable",
          "当前建项操作不需要重试",
        );
      }
      await this.chat.executeProjectBootstrap(
        current.operation.projectBootstrapOperationId,
        stableCommandId(
          "project-bootstrap-reconcile",
          dshSessionId,
          current.operation.projectBootstrapOperationId,
          String(current.operation.revision),
        ),
        signal,
      );
      return this.projection(dshSessionId, signal);
    }
    const decisionCommandId = stableCommandId(
      "project-bootstrap-decision",
      dshSessionId,
      request.binding.projectBootstrapCandidateId,
      String(request.binding.candidateRevision),
      request.binding.candidateSha256,
      request.kind,
      sha256(request.explanation ?? ""),
    );
    const decided = await this.chat.decideProjectBootstrap(
      {
        projectBootstrapCandidateId: request.binding.projectBootstrapCandidateId,
        revision: request.binding.candidateRevision,
        sha256: request.binding.candidateSha256,
      },
      decisionCommandId,
      request.kind,
      request.explanation,
      signal,
    );
    if (request.kind === "confirm" && decided.operation !== undefined) {
      const operation = decided.operation;
      if (operation.status !== "ready") {
        await this.chat.executeProjectBootstrap(
          operation.projectBootstrapOperationId,
          stableCommandId(
            "project-bootstrap-execute",
            dshSessionId,
            operation.projectBootstrapOperationId,
            String(operation.revision),
          ),
          signal,
        );
      }
    }
    return this.projection(dshSessionId, signal);
  }

  /**
   * 按Bridge中真实的DSH user/message → Product Run绑定恢复轨迹。单条轨迹暂时
   * 不可读时只缺席本轮展示，不能让Plan/HITL投影一起失败；下一次轮询会重试。
   */
  private async executionTraces(
    dshSessionId: string,
    binding: SessionBinding | undefined,
    signal?: AbortSignal,
  ): Promise<LifeosExecutionTrace[]> {
    if (binding === undefined) return [];
    const requests = Object.values(binding.requests)
      .filter(
        (
          request,
        ): request is typeof request & {
          dshMessageId: string;
          productRunId: string;
        } => request.dshMessageId !== undefined && request.productRunId !== undefined,
      )
      .slice(-100);
    const settled = await Promise.allSettled(
      requests.map(async (request): Promise<LifeosExecutionTrace> => {
        const trace =
          this.stableExecutionTraces.get(request.productRunId) ??
          (await this.chat.getWorkflowExecutionTrace(request.productRunId, signal));
        if (String(trace.productRunId) !== request.productRunId) {
          throw new Error("lifeos execution trace run identity mismatch");
        }
        if (isStableExecutionTrace(trace)) {
          this.stableExecutionTraces.set(request.productRunId, trace);
        }
        return {
          dshMessageId: request.dshMessageId,
          boundaries: {
            dsh: {
              dshSessionId,
              dshMessageId: request.dshMessageId,
              userTextSha256: request.userTextSha256,
            },
            bridge: {
              messageCommandId: request.messageCommandId,
              ...(request.productUserMessageId === undefined
                ? {}
                : { productUserMessageId: request.productUserMessageId }),
              ...(request.productAssistantMessageId === undefined
                ? {}
                : { productAssistantMessageId: request.productAssistantMessageId }),
              ...(request.workflowSelection?.workflowDefinitionRevisionId === undefined
                ? {}
                : {
                    workflowDefinitionRevisionId:
                      request.workflowSelection.workflowDefinitionRevisionId,
                  }),
              ...(request.promptSelection === undefined
                ? {}
                : { promptSelectionSha256: sha256(JSON.stringify(request.promptSelection)) }),
            },
          },
          trace,
        };
      }),
    );
    return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  /** 选择表面可用的已发布Workflow列表；权威过滤（active/published/所有权）在Chat侧完成。 */
  async workflows(signal?: AbortSignal): Promise<{ items: readonly LifeosWorkflowOption[] }> {
    return { items: await this.chat.listWorkflows(signal) };
  }

  async saveWorkflowAgentNodeConfiguration(
    request: SaveWorkflowAgentNodeConfigurationRequest,
    signal?: AbortSignal,
  ): Promise<{ workflow: LifeosWorkflowOption; items: readonly LifeosWorkflowOption[] }> {
    const result = await this.chat.saveWorkflowAgentNodeConfiguration(
      request.commandId,
      request.payload,
      signal,
    );
    const revisionId = result.affectedRevision?.workflowDefinitionRevisionId;
    const items = await this.chat.listWorkflows(signal);
    const workflow = items.find((item) => item.workflowDefinitionRevisionId === revisionId);
    if (workflow === undefined) {
      throw new BridgeRequestError(
        500,
        "lifeos_workflow_agent_configuration_projection_missing",
        "保存后的Workflow投影不可用",
      );
    }
    return { workflow, items };
  }

  /**
   * 写入或清除会话级Workflow选择草稿。它只是发送前草稿：真正的
   * published/active/Hash校验发生在下一次消息提交的Chat命令边界；
   * 草稿过期只会让该次发送得到可处理的definition_stale失败。
   */
  async selectWorkflow(
    dshSessionId: string,
    selection: WorkflowSelection | null,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    const createCommandId = stableCommandId("create-session", dshSessionId);
    await this.state.selectWorkflow(dshSessionId, createCommandId, selection);
    const storedPrompt = await this.state.readPromptSelection(dshSessionId);
    if (storedPrompt?.schemaVersion === "prompt-turn-selection-input.v2") {
      const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
      const workspaceSelection = promptSelectionForWorkspace(storedPrompt, workspace);
      const normalized =
        selection === null
          ? {
              schemaVersion: "prompt-turn-selection-input.v1" as const,
              ...(workspaceSelection.workspaceRootId === undefined
                ? {}
                : { workspaceRootId: workspaceSelection.workspaceRootId }),
              regions: workspaceSelection.regions,
            }
          : promptSelectionForWorkflow(workspaceSelection, {
              workflowDefinitionRevisionId: selection.workflowDefinitionRevisionId,
              promptNodeIds: [],
            });
      await this.state.selectPrompt(dshSessionId, createCommandId, normalized);
    }
    return await this.projection(dshSessionId, signal);
  }

  private async promptWorkflow(dshSessionId: string) {
    if (typeof this.chat.listWorkflows !== "function") return null;
    const [selection, workflows] = await Promise.all([
      this.state.readWorkflowSelection(dshSessionId),
      this.chat.listWorkflows().catch(() => []),
    ]);
    return (
      workflows.find(
        (item) => item.workflowDefinitionRevisionId === selection?.workflowDefinitionRevisionId,
      ) ??
      workflows.find((item) => item.isDefault) ??
      null
    );
  }

  /** 会话Prompt草稿的Workspace身份每次都由Host重新解析，Browser不能指定别的项目。 */
  async promptSelection(dshSessionId: string): Promise<PromptSelectionProjection> {
    const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
    const [stored, workflow] = await Promise.all([
      this.state.readPromptSelection(dshSessionId),
      this.promptWorkflow(dshSessionId),
    ]);
    const workspaceSelection = promptSelectionForWorkspace(stored, workspace);
    const promptSelection =
      workflow === null
        ? workspaceSelection
        : promptSelectionForWorkflow(workspaceSelection, {
            workflowDefinitionRevisionId: workflow.workflowDefinitionRevisionId,
            promptNodeIds: [],
          });
    return promptSelectionProjectionSchema.parse({
      schemaVersion: PROMPT_SELECTION_SCHEMA_VERSION,
      workspace,
      workflow:
        workflow === null
          ? null
          : {
              workflowDefinitionRevisionId: workflow.workflowDefinitionRevisionId,
              title: workflow.title,
            },
      promptSelection,
    });
  }

  async selectPrompt(
    dshSessionId: string,
    selection: PromptSelection,
  ): Promise<PromptSelectionProjection> {
    const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
    if (selection.workspaceRootId !== workspace?.rootId) {
      throw new BridgeRequestError(
        409,
        "lifeos_prompt_workspace_stale",
        "当前会话Workspace已变化，请刷新提示词选择后重试",
      );
    }
    const workflow = await this.promptWorkflow(dshSessionId);
    const workspaceSelection = promptSelectionForWorkspace(selection, workspace);
    const normalized =
      workflow === null
        ? workspaceSelection
        : promptSelectionForWorkflow(workspaceSelection, {
            workflowDefinitionRevisionId: workflow.workflowDefinitionRevisionId,
            promptNodeIds: [],
          });
    await this.state.selectPrompt(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      normalized,
    );
    return promptSelectionProjectionSchema.parse({
      schemaVersion: PROMPT_SELECTION_SCHEMA_VERSION,
      workspace,
      workflow:
        workflow === null
          ? null
          : {
              workflowDefinitionRevisionId: workflow.workflowDefinitionRevisionId,
              title: workflow.title,
            },
      promptSelection: normalized,
    });
  }

  async setDshSendReviewEnabled(
    dshSessionId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    await this.state.setDshSendReviewEnabled(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      enabled,
    );
    if (!enabled) this.dshSendReview?.approveCurrent(dshSessionId);
    return await this.projection(dshSessionId, signal);
  }

  async decideDshSendReview(
    dshSessionId: string,
    request: DshSendReviewDecisionRequest,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    if (this.dshSendReview?.decide(dshSessionId, request.reviewId, request.kind) !== true) {
      throw new BridgeRequestError(
        409,
        "lifeos_dsh_send_review_stale",
        "该DSH发送审核已处理或不再有效",
      );
    }
    return await this.projection(dshSessionId, signal);
  }

  async setBridgeDispatchReviewEnabled(
    dshSessionId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    await this.state.setBridgeDispatchReviewEnabled(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      enabled,
    );
    if (!enabled) this.bridgeDispatchReview?.approveCurrent(dshSessionId);
    return await this.projection(dshSessionId, signal);
  }

  async decideBridgeDispatchReview(
    dshSessionId: string,
    request: BridgeChatDispatchReviewDecisionRequest,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    if (
      this.bridgeDispatchReview?.decide(
        dshSessionId,
        request.reviewId,
        request.planSha256,
        request.kind,
      ) !== true
    ) {
      throw new BridgeRequestError(
        409,
        "lifeos_bridge_dispatch_review_stale",
        "该Bridge出口审核已处理、正文已变化或不再有效",
      );
    }
    return await this.projection(dshSessionId, signal);
  }

  async decide(
    dshSessionId: string,
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    const normalizedRequest = decisionRequestSchema.parse(request);
    const createCommandId = stableCommandId("create-session", dshSessionId);
    const existing = await this.state.readSession(dshSessionId);
    const requestKey = existing?.currentRequestKey;
    if (existing === undefined || requestKey === undefined) {
      throw new BridgeRequestError(404, "lifeos_run_not_found", "当前 DSH 会话没有 LifeOS Run");
    }
    const requestBinding = existing.requests[requestKey];
    if (requestBinding?.productRunId === undefined) {
      throw new BridgeRequestError(409, "lifeos_run_not_ready", "LifeOS Run 尚未建立");
    }
    if (requestBinding.productRunId !== normalizedRequest.binding.productRunId) {
      throw new BridgeRequestError(
        409,
        "lifeos_decision_stale",
        "Run 已变化，请查看当前计划后重试",
      );
    }
    const bodySha256 = decisionBodySha256(normalizedRequest);
    let pending = requestBinding.pendingDecision;
    if (pending !== undefined && pending.bodySha256 !== bodySha256) {
      throw new BridgeRequestError(
        409,
        "lifeos_decision_outcome_unknown",
        "上一决定结果仍未知；只能用相同内容重试",
      );
    }
    if (pending === undefined) {
      const [run, approval] = await Promise.all([
        this.chat.getRun(requestBinding.productRunId, signal),
        this.chat.getApproval(requestBinding.productRunId, signal),
      ]);
      if (approval === null || approval.status !== "open") {
        throw new BridgeRequestError(409, "lifeos_approval_not_open", "当前没有可决定的审批");
      }
      const observed = normalizedRequest.binding;
      if (
        run.productRunId !== observed.productRunId ||
        run.revision !== observed.runRevision ||
        approval.approvalRequestId !== observed.approvalRequestId ||
        approval.productRunId !== observed.productRunId ||
        approval.planId !== observed.planId ||
        approval.planRevision !== observed.planRevision ||
        approval.planSha256 !== observed.planSha256
      ) {
        throw new BridgeRequestError(
          409,
          "lifeos_decision_stale",
          "计划或审批已变化，请查看当前版本后重试",
        );
      }
      if (!run.allowedActions.includes(normalizedRequest.kind)) {
        throw new BridgeRequestError(409, "lifeos_decision_not_allowed", "当前 Run 不允许该决定");
      }
      const candidate = pendingFrom(dshSessionId, normalizedRequest);
      pending = await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
        const target = binding.requests[requestKey];
        if (target?.productRunId === undefined) {
          throw new BridgeRequestError(409, "lifeos_run_changed", "当前 Run 已变化，请刷新后重试");
        }
        if (target.pendingDecision !== undefined) {
          if (target.pendingDecision.bodySha256 !== bodySha256) {
            throw new BridgeRequestError(
              409,
              "lifeos_decision_outcome_unknown",
              "上一决定结果仍未知；只能用相同内容重试",
            );
          }
          return structuredClone(target.pendingDecision);
        }
        target.pendingDecision = candidate;
        return structuredClone(candidate);
      });
    }

    const decision = pending;
    if (decision === undefined) {
      throw new BridgeRequestError(409, "lifeos_decision_missing", "决定绑定未建立");
    }
    try {
      await this.chat.submitDecision(decision, decision.request, signal);
    } catch (error) {
      // A received, non-retryable 4xx proves that Chat rejected the command and
      // no unknown outcome remains. Transport/5xx/retryable failures keep the
      // exact request+command binding so the browser can only retry verbatim.
      if (isDeterministicDecisionRejection(error)) {
        await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
          const target = binding.requests[requestKey];
          if (target?.pendingDecision?.commandId === decision.commandId) {
            delete target.pendingDecision;
          }
        });
      }
      throw error;
    }
    await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
      const target = binding.requests[requestKey];
      if (target?.pendingDecision?.commandId === decision.commandId) {
        delete target.pendingDecision;
      }
    });
    return await this.projection(dshSessionId, signal);
  }

  async decideNote(
    dshSessionId: string,
    request: NoteDecisionRequest,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    const normalizedRequest = noteDecisionRequestSchema.parse(request);
    const createCommandId = stableCommandId("create-session", dshSessionId);
    const existing = await this.state.readSession(dshSessionId);
    const requestKey = existing?.currentRequestKey;
    if (existing === undefined || requestKey === undefined) {
      throw new BridgeRequestError(404, "lifeos_run_not_found", "当前 DSH 会话没有 LifeOS Run");
    }
    const requestBinding = existing.requests[requestKey];
    if (requestBinding?.productRunId === undefined) {
      throw new BridgeRequestError(409, "lifeos_run_not_ready", "LifeOS Run 尚未建立");
    }
    if (requestBinding.productRunId !== normalizedRequest.binding.productRunId) {
      throw new BridgeRequestError(
        409,
        "lifeos_note_decision_stale",
        "Run 已变化，请查看当前笔记候选后重试",
      );
    }
    if (requestBinding.pendingDecision !== undefined) {
      throw new BridgeRequestError(
        409,
        "lifeos_decision_outcome_unknown",
        "上一计划决定结果仍未知，不能提交笔记决定",
      );
    }
    const bodySha256 = noteDecisionBodySha256(normalizedRequest);
    let pending = requestBinding.pendingNoteDecision;
    if (pending !== undefined && pending.bodySha256 !== bodySha256) {
      throw new BridgeRequestError(
        409,
        "lifeos_note_decision_outcome_unknown",
        "上一笔记决定结果仍未知；只能用相同内容重试",
      );
    }
    if (pending === undefined) {
      const [run, candidate] = await Promise.all([
        this.chat.getRun(requestBinding.productRunId, signal),
        this.chat.getNoteCandidate(requestBinding.productRunId, signal),
      ]);
      if (candidate === null || candidate.status !== "under_review") {
        throw new BridgeRequestError(
          409,
          "lifeos_note_candidate_not_open",
          "当前没有可决定的笔记候选",
        );
      }
      const observed = normalizedRequest.binding;
      if (
        run.productRunId !== observed.productRunId ||
        run.revision !== observed.runRevision ||
        run.status !== "waiting_human" ||
        run.phase !== "note_review" ||
        candidate.productRunId !== observed.productRunId ||
        candidate.noteCandidateId !== observed.noteCandidateId ||
        candidate.revision !== observed.candidateRevision ||
        candidate.sha256 !== observed.candidateSha256
      ) {
        throw new BridgeRequestError(
          409,
          "lifeos_note_decision_stale",
          "Run 或笔记候选已变化，请查看当前版本后重试",
        );
      }
      if (!candidate.allowedActions.includes(normalizedRequest.kind)) {
        throw new BridgeRequestError(
          409,
          "lifeos_note_decision_not_allowed",
          "当前笔记候选不允许该决定",
        );
      }
      const next = pendingNoteFrom(dshSessionId, normalizedRequest);
      pending = await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
        const target = binding.requests[requestKey];
        if (target?.productRunId === undefined) {
          throw new BridgeRequestError(409, "lifeos_run_changed", "当前 Run 已变化，请刷新后重试");
        }
        if (target.pendingDecision !== undefined) {
          throw new BridgeRequestError(
            409,
            "lifeos_decision_outcome_unknown",
            "上一计划决定结果仍未知，不能提交笔记决定",
          );
        }
        if (target.pendingNoteDecision !== undefined) {
          if (target.pendingNoteDecision.bodySha256 !== bodySha256) {
            throw new BridgeRequestError(
              409,
              "lifeos_note_decision_outcome_unknown",
              "上一笔记决定结果仍未知；只能用相同内容重试",
            );
          }
          return structuredClone(target.pendingNoteDecision);
        }
        target.pendingNoteDecision = next;
        return structuredClone(next);
      });
    }
    const decision = pending;
    if (decision === undefined) {
      throw new BridgeRequestError(409, "lifeos_note_decision_missing", "笔记决定绑定未建立");
    }
    try {
      await this.chat.submitNoteDecision(decision, decision.request, signal);
    } catch (error) {
      if (isDeterministicDecisionRejection(error)) {
        await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
          const target = binding.requests[requestKey];
          if (target?.pendingNoteDecision?.commandId === decision.commandId) {
            delete target.pendingNoteDecision;
          }
        });
      }
      throw error;
    }
    await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
      const target = binding.requests[requestKey];
      if (target?.pendingNoteDecision?.commandId === decision.commandId) {
        delete target.pendingNoteDecision;
      }
    });
    return await this.projection(dshSessionId, signal);
  }

  async decidePromptReview(
    dshSessionId: string,
    request: PromptReviewDecisionRequest,
    signal?: AbortSignal,
  ): Promise<LifeosProjection> {
    const normalizedRequest = promptReviewDecisionRequestSchema.parse(request);
    const createCommandId = stableCommandId("create-session", dshSessionId);
    const existing = await this.state.readSession(dshSessionId);
    const requestKey = existing?.currentRequestKey;
    if (existing === undefined || requestKey === undefined) {
      throw new BridgeRequestError(404, "lifeos_run_not_found", "当前 DSH 会话没有 LifeOS Run");
    }
    const requestBinding = existing.requests[requestKey];
    if (requestBinding?.productRunId === undefined) {
      throw new BridgeRequestError(409, "lifeos_run_not_ready", "LifeOS Run 尚未建立");
    }
    if (requestBinding.productRunId !== normalizedRequest.binding.productRunId) {
      throw new BridgeRequestError(409, "lifeos_prompt_review_stale", "Run 已变化，请刷新后重试");
    }
    if (
      requestBinding.pendingDecision !== undefined ||
      requestBinding.pendingNoteDecision !== undefined
    ) {
      throw new BridgeRequestError(
        409,
        "lifeos_decision_outcome_unknown",
        "上一产品决定结果仍未知，不能提交提示词决定",
      );
    }
    const bodySha256 = promptReviewDecisionBodySha256(normalizedRequest);
    let pending = requestBinding.pendingPromptReviewDecision;
    if (pending !== undefined && pending.bodySha256 !== bodySha256) {
      throw new BridgeRequestError(
        409,
        "lifeos_prompt_review_decision_outcome_unknown",
        "上一提示词决定结果仍未知；只能用相同内容重试",
      );
    }
    if (pending === undefined) {
      const [run, review] = await Promise.all([
        this.chat.getRun(requestBinding.productRunId, signal),
        this.chat.getCurrentPromptReview(requestBinding.productRunId, signal),
      ]);
      const observed = normalizedRequest.binding;
      if (
        review === null ||
        review.status !== "open" ||
        run.productRunId !== observed.productRunId ||
        run.revision !== observed.runRevision ||
        run.status !== "waiting_human" ||
        run.phase !== "prompt_review" ||
        review.productRunId !== observed.productRunId ||
        review.promptReviewRequestId !== observed.promptReviewRequestId ||
        review.requestRevision !== observed.requestRevision ||
        review.reviewSha256 !== observed.reviewSha256 ||
        review.payloadSha256 !== observed.payloadSha256
      ) {
        throw new BridgeRequestError(
          409,
          "lifeos_prompt_review_stale",
          "Run 或提示词请求已变化，请查看当前版本后重试",
        );
      }
      if (!review.allowedActions.includes(normalizedRequest.kind)) {
        throw new BridgeRequestError(
          409,
          "lifeos_prompt_review_decision_not_allowed",
          "当前提示词请求不允许该决定",
        );
      }
      const next = pendingPromptReviewFrom(dshSessionId, normalizedRequest);
      pending = await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
        const target = binding.requests[requestKey];
        if (target?.productRunId === undefined) {
          throw new BridgeRequestError(409, "lifeos_run_changed", "当前 Run 已变化，请刷新后重试");
        }
        if (target.pendingDecision !== undefined || target.pendingNoteDecision !== undefined) {
          throw new BridgeRequestError(
            409,
            "lifeos_decision_outcome_unknown",
            "上一产品决定结果仍未知，不能提交提示词决定",
          );
        }
        if (target.pendingPromptReviewDecision !== undefined) {
          if (target.pendingPromptReviewDecision.bodySha256 !== bodySha256) {
            throw new BridgeRequestError(
              409,
              "lifeos_prompt_review_decision_outcome_unknown",
              "上一提示词决定结果仍未知；只能用相同内容重试",
            );
          }
          return structuredClone(target.pendingPromptReviewDecision);
        }
        target.pendingPromptReviewDecision = next;
        return structuredClone(next);
      });
    }
    if (pending === undefined) {
      throw new BridgeRequestError(
        409,
        "lifeos_prompt_review_decision_missing",
        "提示词决定绑定未建立",
      );
    }
    try {
      await this.chat.submitPromptReviewDecision(pending, pending.request, signal);
    } catch (error) {
      if (isDeterministicDecisionRejection(error)) {
        await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
          const target = binding.requests[requestKey];
          if (target?.pendingPromptReviewDecision?.commandId === pending?.commandId) {
            delete target.pendingPromptReviewDecision;
          }
        });
      }
      throw error;
    }
    await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
      const target = binding.requests[requestKey];
      if (target?.pendingPromptReviewDecision?.commandId === pending?.commandId) {
        delete target.pendingPromptReviewDecision;
      }
    });
    return await this.projection(dshSessionId, signal);
  }
}
