import type {
  ApprovalRequestId,
  ArtifactId,
  DecisionId,
  ExecutionCandidateId,
  ExecutionContractId,
  MessageId,
  OutboxEntryId,
  PlanId,
  PlanRevisionId,
  ProductRunId,
  ProductSessionId,
  RevisionInputId,
  RunAttemptId,
  ValidationResultId,
  ProjectId,
  ProjectMethodSnapshotId,
  ProjectStageId,
  ProjectResourceId,
  ProjectParticipantId,
  ProjectWorkId,
  ProjectActionId,
  ProjectContributionId,
  ProjectEvidenceId,
  ProjectDecisionId,
  ProjectObservationId,
  ProjectCandidateId,
  ProjectMilestoneId,
  ProjectUpdateId,
  ProjectStateTransitionId,
  ProjectWorkBlockId,
  ProjectWorkClaimId,
  ProjectWorkHandoffId,
  ProjectPracticeRevisionId,
  ProjectWorkOutcomeId,
  ProjectContextMapId,
  ProjectProviderBindingId,
  ProjectProviderProjectionId,
  ProjectCoordinationOperationId,
  ProjectInboundChangeId,
  NoteId,
  NoteRevisionId,
  NoteCandidateId,
  NoteDecisionId,
  RuleId,
  RuleRevisionId,
  RuleTagId,
  RuleScopeId,
  RuleDecisionId,
  RuleSelectionId,
  PromptReviewRequestId,
  PromptReviewDecisionId,
  DirectAgentCandidateId,
  ProjectBootstrapCandidateId,
  ProjectBootstrapDecisionId,
  ProjectBootstrapOperationId,
  ProjectWorkspaceBindingId,
  ExecutionTracePage,
  RunActivityEvent,
  AgentProfileAgentKey,
  AgentRuntimeBaselineDto,
  ExecutionEvidenceRef,
  ExecutionEvidenceVerificationReceipt,
} from "@chat/contracts";
import type { PromptFragmentId, PromptFragmentRevisionId } from "@chat/contracts";
import type { PromptCatalogPort } from "./prompt-catalog-port.js";
import type { PromptFileLibraryPort } from "./prompt-file-library-port.js";
import type { TraceEventInput } from "@chat/contracts";
import type { ProductStorePort } from "./product-store-port.js";
import type { MemoryBackendRegistryPort } from "./memory-ports.js";
import type { MemoryImportBackendRegistryPort } from "./memory-import-ports.js";
import type { WorkflowMemoryProviderRegistryPort } from "./workflow-memory-ports.js";
import type {
  ProjectIntakeUnderstandingPort,
  ProjectAdvancementUnderstandingPort,
  ProjectResourceRootRegistryPort,
} from "./project-ports.js";
import type { WorkflowRuntimeTraceReaderPort } from "./runtime-ports.js";
import type {
  ProjectBootstrapExecutionCoordinatorPort,
  ProjectManagementBootstrapPort,
  ProjectWorkspaceProvisionerPort,
} from "./project-bootstrap-ports.js";
import type { PlaneProjectCoordinationPort } from "./plane-project-coordination-ports.js";
import type {
  PlaneProjectRolloutExecutionPort,
  PlaneProjectRolloutInspectionPort,
} from "./plane-project-rollout-ports.js";

/** Trace发射器：由组合根提供（@chat/realtime Sink）；Application不依赖具体Sink。 */
export type TraceEmitter = (event: TraceEventInput) => void;

/** Runtime Trace只读Port；Application先校验Product Run所有权，再允许读取投影。 */
export interface ExecutionTraceReaderPort {
  read(input: {
    readonly productRunId: ProductRunId;
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<ExecutionTracePage>;
}

/** Session Activity是Run级有序投影；它与Debug Trace、Product事实分别拥有存储边界。 */
export interface RunActivityReaderPort {
  read(input: { readonly productRunId: ProductRunId }): Promise<readonly RunActivityEvent[]>;
}

export interface ExecutionEvidenceVerifierPort {
  verify(input: {
    readonly executionAttemptId: string;
    readonly evidenceRefs: readonly ExecutionEvidenceRef[];
  }): Promise<ExecutionEvidenceVerificationReceipt>;
}

/**
 * Application用例的外部能力依赖。
 *
 * 时间与ID由组合根注入：用例本身不读全局时间/随机，保证可测试与可重放。
 * 所有ID在transact之前生成并随闭包捕获；幂等重放时mutate不会再次运行，
 * 未使用的ID不会进入产品事实。
 */
export interface IdFactory {
  session(): ProductSessionId;
  message(): MessageId;
  run(): ProductRunId;
  attempt(): RunAttemptId;
  plan(): PlanId;
  planRevision(): PlanRevisionId;
  revisionInput(): RevisionInputId;
  approval(): ApprovalRequestId;
  decision(): DecisionId;
  executionContract(): ExecutionContractId;
  executionCandidate(): ExecutionCandidateId;
  validationResult(): ValidationResultId;
  artifact(): ArtifactId;
  outbox(): OutboxEntryId;
}

/** Project Solution单独占有自己的ID空间，旧规划/Memory用例不被迫依赖它。 */
export interface ProjectIdFactory {
  project(): ProjectId;
  methodSnapshot(): ProjectMethodSnapshotId;
  stage(): ProjectStageId;
  resource(): ProjectResourceId;
  participant(): ProjectParticipantId;
  work(): ProjectWorkId;
  action(): ProjectActionId;
  contribution(): ProjectContributionId;
  evidence(): ProjectEvidenceId;
  decision(): ProjectDecisionId;
  observation(): ProjectObservationId;
  candidate(): ProjectCandidateId;
  milestone(): ProjectMilestoneId;
  update(): ProjectUpdateId;
  stateTransition(): ProjectStateTransitionId;
  workBlock?(): ProjectWorkBlockId;
  workClaim?(): ProjectWorkClaimId;
  workHandoff?(): ProjectWorkHandoffId;
  practiceRevision?(): ProjectPracticeRevisionId;
  workOutcome?(): ProjectWorkOutcomeId;
  contextMap?(): ProjectContextMapId;
  providerBinding?(): ProjectProviderBindingId;
  providerProjection?(): ProjectProviderProjectionId;
}

export interface NoteIdFactory {
  note(): NoteId;
  revision(): NoteRevisionId;
  candidate(): NoteCandidateId;
  decision(): NoteDecisionId;
}

export interface RuleIdFactory {
  rule(): RuleId;
  revision(): RuleRevisionId;
  tag(): RuleTagId;
  scope(): RuleScopeId;
  decision(): RuleDecisionId;
  selection(): RuleSelectionId;
}

/** Direct Agent独立身份空间，避免让既有Planning测试Fixture被新流程强制扩张。 */
export interface DirectAgentIdFactory {
  promptReviewRequest(): PromptReviewRequestId;
  promptReviewDecision(): PromptReviewDecisionId;
  candidate(): DirectAgentCandidateId;
}

export interface PromptFragmentIdFactory {
  fragment(): PromptFragmentId;
  revision(): PromptFragmentRevisionId;
}

/**
 * Agent运行时只读说明由真正执行该Agent的Adapter提供。Application负责把它与
 * Chat拥有的可写Prompt并排投影，但不会复制或重写上游Agent实现。
 */
export interface AgentRuntimeProfileReaderPort {
  read(
    agentKey: AgentProfileAgentKey,
    workspaceRootId?: string,
  ): Promise<AgentRuntimeBaselineDto | undefined>;
}

export interface ProjectBootstrapIdFactory {
  candidate(): ProjectBootstrapCandidateId;
  decision(): ProjectBootstrapDecisionId;
  operation(): ProjectBootstrapOperationId;
  binding(): ProjectWorkspaceBindingId;
}

/** Provider写Journal和入站漂移使用Chat Project身份，不复用Plane UUID或Runtime ID。 */
export interface PlaneProjectCoordinationIdFactory {
  operation(): ProjectCoordinationOperationId;
  inboundChange(): ProjectInboundChangeId;
}

export interface ApplicationDeps {
  readonly store: ProductStorePort;
  readonly now: () => string;
  readonly ids: IdFactory;
  /** 可选Trace发射；缺省时用例不产生Trace（骨架模式与部分纯规则测试）。 */
  readonly trace?: TraceEmitter;
  /** 可观察执行证据的只读投影；不拥有Product Run或终态。 */
  readonly executionTraceReader?: ExecutionTraceReaderPort;
  readonly runActivityReader?: RunActivityReaderPort;
  readonly executionEvidenceVerifier?: ExecutionEvidenceVerifierPort;
  /** Vercel Workflow World的脱敏只读投影；不暴露任何Runtime私有身份。 */
  readonly workflowRuntimeTrace?: WorkflowRuntimeTraceReaderPort;
  /** 配置在服务端组合根；浏览器只能选择公开 backendId。 */
  readonly memoryBackends?: MemoryBackendRegistryPort;
  /** 外部写入能力与Query分离，避免调用方忽略outcome_unknown。 */
  readonly memoryImportBackends?: MemoryImportBackendRegistryPort;
  /** 当前Workflow Memory稳定边界；首期活动Provider只有Tencent MemoryCore。 */
  readonly workflowMemoryProviders?: WorkflowMemoryProviderRegistryPort;
  readonly projectRoots?: ProjectResourceRootRegistryPort;
  readonly projectIntakeUnderstanding?: ProjectIntakeUnderstandingPort;
  readonly projectAdvancementUnderstanding?: ProjectAdvancementUnderstandingPort;
  readonly projectIds?: ProjectIdFactory;
  /** 未装配Provider只从普通读模型退出；原始Binding/Operation仍留在Product Store供历史审计。 */
  readonly disabledProjectProviderKinds?: readonly string[];
  readonly noteIds?: NoteIdFactory;
  readonly ruleIds?: RuleIdFactory;
  readonly directAgentIds?: DirectAgentIdFactory;
  /** Prompt Studio的Git Catalog与用户产品身份；旧用例不被迫依赖。 */
  readonly promptCatalog?: PromptCatalogPort;
  readonly promptFiles?: PromptFileLibraryPort;
  readonly promptFragmentIds?: PromptFragmentIdFactory;
  readonly agentRuntimeProfiles?: AgentRuntimeProfileReaderPort;
  /** Plane与本地Workspace只通过窄Port进入Application；Token和绝对路径不进产品事实。 */
  readonly projectManagementBootstrap?: ProjectManagementBootstrapPort;
  readonly projectWorkspaceProvisioner?: ProjectWorkspaceProvisionerPort;
  readonly projectBootstrapExecutionCoordinator?: ProjectBootstrapExecutionCoordinatorPort;
  readonly projectBootstrapIds?: ProjectBootstrapIdFactory;
  readonly planeProjectCoordination?: PlaneProjectCoordinationPort;
  readonly planeProjectCoordinationIds?: PlaneProjectCoordinationIdFactory;
  /** 一次性管理员Dry Run只读面；不进入Agent scoped Router，也不包含写方法。 */
  readonly planeProjectRolloutInspection?: PlaneProjectRolloutInspectionPort;
  /** 仅供显式授权的一次性管理员纵向；不挂载Agent或浏览器公开Router。 */
  readonly planeProjectRolloutExecution?: PlaneProjectRolloutExecutionPort;
}

/** 规划修订默认上限（任务书§9.2.7）。 */
export const DEFAULT_MAX_PLAN_REVISIONS = 5;

/** 首版审批窗口：24小时；到期时间作为Approval产品事实持久化。 */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
