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
  ExecutionTracePage,
} from "@chat/contracts";
import type { PromptFragmentId, PromptFragmentRevisionId } from "@chat/contracts";
import type { PromptCatalogPort } from "./prompt-catalog-port.js";
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
import type { ProductRunTraceReaderPort, WorkflowRuntimeTraceReaderPort } from "./runtime-ports.js";

/** Trace发射器：由组合根提供（@chat/realtime Sink）；Application不依赖具体Sink。 */
export type TraceEmitter = (event: TraceEventInput) => void;

/** Runtime Trace只读Port；Application先校验Product Run所有权，再允许读取投影。 */
export interface ExecutionTraceReaderPort {
  read(input: {
    readonly productRunId: ProductRunId;
    readonly afterSequence: number;
    readonly limit: number;
  }): ExecutionTracePage;
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

export interface ApplicationDeps {
  readonly store: ProductStorePort;
  readonly now: () => string;
  readonly ids: IdFactory;
  /** 可选Trace发射；缺省时用例不产生Trace（骨架模式与部分纯规则测试）。 */
  readonly trace?: TraceEmitter;
  /** 可观察执行证据的只读投影；不拥有Product Run或终态。 */
  readonly executionTraceReader?: ExecutionTraceReaderPort;
  /** Vercel Workflow World的脱敏只读投影；不暴露任何Runtime私有身份。 */
  readonly workflowRuntimeTrace?: WorkflowRuntimeTraceReaderPort;
  /** 本地严格JSONL Trace的只读投影，用于聚合Pi Agent公开活动。 */
  readonly productRunTrace?: ProductRunTraceReaderPort;
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
  readonly noteIds?: NoteIdFactory;
  readonly ruleIds?: RuleIdFactory;
  readonly directAgentIds?: DirectAgentIdFactory;
  /** Prompt Studio的Git Catalog与用户产品身份；旧用例不被迫依赖。 */
  readonly promptCatalog?: PromptCatalogPort;
  readonly promptFragmentIds?: PromptFragmentIdFactory;
}

/** 规划修订默认上限（任务书§9.2.7）。 */
export const DEFAULT_MAX_PLAN_REVISIONS = 5;

/** 首版审批窗口：24小时；到期时间作为Approval产品事实持久化。 */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
