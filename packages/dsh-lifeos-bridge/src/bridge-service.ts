import {
  BRIDGE_SCHEMA_VERSION,
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
  type NoteDecisionRequest,
  type PromptSelection,
  type PromptSelectionProjection,
  type PromptReviewDecisionRequest,
  type LifeosExecutionTrace,
  type LifeosProjection,
  type LifeosWorkflowOption,
  type SessionRecordsChatPage,
  type SessionRecordsDshPage,
  type SessionRecordsOverview,
  sessionRecordsChatPageSchema,
  sessionRecordsDshPageSchema,
  sessionRecordsOverviewSchema,
  type WorkflowSelection,
  type DshContextInjectionProjection,
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
import {
  promptSelectionForWorkspace,
  type PromptWorkspaceResolver,
} from "./prompt-workspace-resolver.ts";

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

  constructor(
    private readonly chat: ChatProductClient,
    private readonly state: AtomicBridgeStateStore,
    private readonly dshHistory?: DshSessionHistoryPort,
    private readonly contextInjectionReader?: Pick<
      DshContextInjectionReader,
      "read" | "workspaceInstructions"
    >,
    private readonly promptWorkspaceResolver?: PromptWorkspaceResolver,
    private readonly dshSendReview?: DshSendReviewCoordinator,
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
   * 发送前只读投影。它复用Adapter的Workspace指令提取函数和ChatClient的Workflow
   * 分流政策，不创建Request Binding，也不提前提交Product Message。
   */
  async bridgeSendPreview(dshSessionId: string, text: string) {
    const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
    const [workflowSelection, storedPromptSelection] = await Promise.all([
      this.state.readWorkflowSelection(dshSessionId),
      this.state.readPromptSelection(dshSessionId),
    ]);
    const promptSelection = promptSelectionForWorkspace(storedPromptSelection, workspace);
    const contextInjections = this.contextInjections(dshSessionId);
    const workspaceInstructions = this.contextInjectionReader?.workspaceInstructions(dshSessionId);
    if (workspaceInstructions === null) {
      throw new BridgeRequestError(
        404,
        "lifeos_dsh_session_not_found",
        "当前 DSH 会话不存在或尚未恢复",
      );
    }
    const direct = workflowSelection?.blueprintKey === "direct";
    const promptConfiguration = direct
      ? await this.chat.previewPromptConfiguration({ selection: promptSelection })
      : null;
    const payload = {
      text,
      ...(workflowSelection === null
        ? {}
        : {
            workflowSelection: {
              kind: "published_revision" as const,
              workflowDefinitionRevisionId: workflowSelection.workflowDefinitionRevisionId,
              definitionSha256: workflowSelection.definitionSha256,
            },
          }),
      ...(!direct && workspaceInstructions !== undefined
        ? { context: { workspaceInstructions } }
        : {}),
      ...(direct ? { promptSelection } : {}),
    };
    return dshBridgeSendPreviewSchema.parse({
      schemaVersion: "chat-dsh-bridge-send-preview.v1",
      boundary: "dsh_to_lifeos_bridge",
      status: "pre_send_projection",
      workspace,
      workflowSelection,
      promptSelection,
      promptConfiguration,
      dshToBridge: {
        userInput: { text, sha256: sha256(text) },
        contextInjections,
      },
      bridgeToChat: {
        policy: direct ? "direct_prompt_selection" : "non_direct_workspace_instructions",
        payload,
      },
    });
  }

  async projection(dshSessionId: string, signal?: AbortSignal): Promise<LifeosProjection> {
    const binding = await this.state.readSession(dshSessionId);
    const workflowSelection = await this.state.readWorkflowSelection(dshSessionId);
    const dshSendReviewEnabled = await this.state.readDshSendReviewEnabled(dshSessionId);
    const dshSendReview = this.dshSendReview?.current(dshSessionId) ?? null;
    const executionTracesPromise = this.executionTraces(binding, signal);
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
        workflowSelection,
        executionTraces: await executionTracesPromise,
      };
    }
    const [run, executionTraces] = await Promise.all([
      this.chat.getRun(current.productRunId, signal),
      executionTracesPromise,
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
      workflowSelection,
      executionTraces,
    };
  }

  /**
   * 按Bridge中真实的DSH user/message → Product Run绑定恢复轨迹。单条轨迹暂时
   * 不可读时只缺席本轮展示，不能让Plan/HITL投影一起失败；下一次轮询会重试。
   */
  private async executionTraces(
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
        return { dshMessageId: request.dshMessageId, trace };
      }),
    );
    return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  /** 选择表面可用的已发布Workflow列表；权威过滤（active/published/所有权）在Chat侧完成。 */
  async workflows(signal?: AbortSignal): Promise<{ items: readonly LifeosWorkflowOption[] }> {
    return { items: await this.chat.listWorkflows(signal) };
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
    return await this.projection(dshSessionId, signal);
  }

  /** 会话Prompt草稿的Workspace身份每次都由Host重新解析，Browser不能指定别的项目。 */
  async promptSelection(dshSessionId: string): Promise<PromptSelectionProjection> {
    const workspace = this.promptWorkspaceResolver?.resolve(dshSessionId) ?? null;
    const stored = await this.state.readPromptSelection(dshSessionId);
    const promptSelection = promptSelectionForWorkspace(stored, workspace);
    return promptSelectionProjectionSchema.parse({
      schemaVersion: PROMPT_SELECTION_SCHEMA_VERSION,
      workspace,
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
    const normalized = promptSelectionForWorkspace(selection, workspace);
    await this.state.selectPrompt(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      normalized,
    );
    return promptSelectionProjectionSchema.parse({
      schemaVersion: PROMPT_SELECTION_SCHEMA_VERSION,
      workspace,
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
