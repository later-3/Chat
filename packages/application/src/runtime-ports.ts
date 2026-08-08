import type {
  ApprovalRequestId,
  CommandId,
  DecisionId,
  ExecutionCandidate,
  ExecutionContextItemDto,
  ExecutionContract,
  PlanContent,
  PlanId,
  PrincipalId,
  ProductRunId,
  RevisionInputId,
  RunAttemptId,
} from "@chat/contracts";

/**
 * Workflow与pi的窄Port（任务书§10）。
 *
 * 所有权边界：
 * - 这些Port表达语义，不暴露文件、SDK对象、Hook Token或Workflow Run ID。
 * - M1只冻结签名；真实实现属于M2（packages/workflows与packages/pi-runtime）。
 * - 模型Step禁止Workflow自动重试；Provider结果未知不进入普通异常重试。
 */

export interface WorkflowStarterPort {
  start(input: StartPlanningExecutionInput): Promise<StartDispatchResult>;
}

export interface StartPlanningExecutionInput {
  readonly productRunId: ProductRunId;
  readonly outboxId: string;
  readonly workflowDefinitionVersion: string;
}

export type StartDispatchResult =
  | { readonly kind: "dispatched" }
  | { readonly kind: "outcome_unknown"; readonly errorCode: string }
  | { readonly kind: "failed_terminal"; readonly errorCode: string };

export interface WorkflowResumePort {
  resume(input: ResumeCommittedDecisionInput): Promise<ResumeDispatchResult>;
}

export interface ResumeCommittedDecisionInput {
  readonly productRunId: ProductRunId;
  readonly approvalRequestId: ApprovalRequestId;
  readonly decisionId: DecisionId;
  readonly outboxId: string;
}

export type ResumeDispatchResult =
  | { readonly kind: "dispatched" }
  | { readonly kind: "outcome_unknown"; readonly errorCode: string }
  | { readonly kind: "failed_terminal"; readonly errorCode: string };

/* ---------- pi Runtime ---------- */

export interface PiRuntimePort {
  plan(input: PlanningInput): Promise<PlanCandidateResult>;
  execute(input: ExecutionStepInput): Promise<ExecutionCandidateResult>;
}

export interface PlanningInput {
  readonly productRunId: ProductRunId;
  readonly attemptId: string;
  readonly sourceMessageRef: { readonly messageId: string; readonly sha256: string };
  readonly priorPlan?: {
    readonly planId: PlanId;
    readonly planRevision: number;
    readonly sha256: string;
  };
  readonly userRevisionInputRef?: { readonly revisionInputId: RevisionInputId };
  readonly planRevision: number;
  readonly limits: {
    readonly maxTurns: number;
    readonly timeoutMs: number;
    readonly tokenBudget?: number;
  };
}

export type PlanCandidateResult =
  | { readonly kind: "candidate"; readonly content: PlanContent; readonly usage?: ProviderUsage }
  | { readonly kind: "invalid_candidate"; readonly errorCode: string }
  | { readonly kind: "provider_failed"; readonly errorCode: string };

export interface ExecutionStepInput {
  readonly executionContract: ExecutionContract;
  readonly stepId: string;
  readonly attemptId: string;
  readonly contextItems: readonly ExecutionContextItemDto[];
}

export type ExecutionCandidateResult =
  | {
      readonly kind: "candidate";
      readonly candidate: Omit<
        ExecutionCandidate,
        "executionCandidateId" | "sha256" | "revision" | "createdAt" | "updatedAt" | "schemaVersion"
      >;
      readonly usage?: ProviderUsage;
    }
  | { readonly kind: "invalid_candidate"; readonly errorCode: string }
  | { readonly kind: "provider_failed"; readonly errorCode: string };

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/* ---------- Workflow私有Product Client ---------- */

/**
 * Workflow Step只能通过本Port经私有Application Command读写产品事实；
 * Workflow进程不得导入或实例化JSON Store。
 */
export interface WorkflowProductClientPort {
  compilePlanningInput(input: CompilePlanningInput): Promise<PlanningInput>;
  publishPlanForReview(input: PublishPlanInput): Promise<PublishedPlanReview>;
  loadCommittedDecision(input: LoadDecisionInput): Promise<CommittedDecision>;
  compileExecutionContract(input: CompileExecutionInput): Promise<ExecutionContract>;
  commitRejectedRun(input: CommitRejectedInput): Promise<CommittedRun>;
  commitExecutionResult(input: CommitResultInput): Promise<CommittedResult>;
}

export interface CompilePlanningInput {
  readonly productRunId: ProductRunId;
  readonly planRevision: number;
  readonly commandId: CommandId;
}

export interface PublishPlanInput {
  readonly productRunId: ProductRunId;
  readonly attemptId: RunAttemptId;
  readonly expectedRunRevision: number;
  readonly inputManifestSha256: string;
  readonly content: PlanContent;
  readonly commandId: CommandId;
}

export interface PublishedPlanReview {
  readonly planId: PlanId;
  readonly planRevision: number;
  readonly planSha256: string;
  readonly approvalRequestId: ApprovalRequestId;
}

export interface LoadDecisionInput {
  readonly productRunId: ProductRunId;
  readonly decisionId: DecisionId;
  readonly expectedPlanId: PlanId;
  readonly expectedPlanRevision: number;
  readonly expectedPlanSha256: string;
}

export interface CommittedDecision {
  readonly decisionId: DecisionId;
  readonly kind: "request_revision" | "approve" | "reject";
  readonly revisionInputId?: RevisionInputId;
  readonly principalId: PrincipalId;
}

export interface CompileExecutionInput {
  readonly productRunId: ProductRunId;
  readonly approvalDecisionId: DecisionId;
  readonly commandId: CommandId;
}

export interface CommitRejectedInput {
  readonly productRunId: ProductRunId;
  readonly decisionId: DecisionId;
  readonly commandId: CommandId;
}

export interface CommittedRun {
  readonly productRunId: ProductRunId;
  readonly status: string;
  readonly revision: number;
}

export interface CommitResultInput {
  readonly productRunId: ProductRunId;
  readonly executionContractId: string;
  readonly executionCandidateId: string;
  readonly validationResultId: string;
  readonly commandId: CommandId;
}

export interface CommittedResult {
  readonly productRunId: ProductRunId;
  readonly finalMessageId: string;
  readonly revision: number;
}
