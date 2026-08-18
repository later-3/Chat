import {
  BRIDGE_SCHEMA_VERSION,
  decisionRequestSchema,
  noteDecisionRequestSchema,
  type ChatApproval,
  type ChatNoteCandidate,
  type ChatPlan,
  type ChatRun,
  type DecisionRequest,
  type NoteDecisionRequest,
  type LifeosProjection,
  type LifeosWorkflowOption,
  type WorkflowSelection,
} from "./contracts.ts";
import { ChatProductApiError, ChatProductClient } from "./chat-client.ts";
import { sha256, stableCommandId } from "./adapter.ts";
import {
  AtomicBridgeStateStore,
  type PendingDecision,
  type PendingNoteDecision,
} from "./state-store.ts";

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

/**
 * Browser read model与HITL命令代理；它只转交意图和投影，不拥有产品事实。
 * Run、Plan、Approval和Decision的权威版本始终由Chat Product Store提交。
 */
export class LifeosBridgeService {
  constructor(
    private readonly chat: ChatProductClient,
    private readonly state: AtomicBridgeStateStore,
  ) {}

  async projection(dshSessionId: string, signal?: AbortSignal): Promise<LifeosProjection> {
    const binding = await this.state.readSession(dshSessionId);
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
        workflowSelection: binding?.workflowSelection ?? null,
      };
    }
    const run = await this.chat.getRun(current.productRunId, signal);
    let plan: ChatPlan | null = null;
    let approval: ChatApproval | null = null;
    let noteCandidate: ChatNoteCandidate | null = null;
    if (run.phase === "note_review" || current.pendingNoteDecision !== undefined) {
      noteCandidate = await this.chat.getNoteCandidate(current.productRunId, signal);
    } else if (
      PLANNING_PROJECTION_PHASES.has(run.phase) ||
      run.currentPlan !== undefined ||
      run.currentApprovalRequestId !== undefined ||
      current.pendingDecision !== undefined
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
      workflowSelection: binding?.workflowSelection ?? null,
    };
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
    await this.state.mutateSession(dshSessionId, createCommandId, (binding) => {
      if (selection === null) {
        delete binding.workflowSelection;
      } else {
        binding.workflowSelection = selection;
      }
    });
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
}
