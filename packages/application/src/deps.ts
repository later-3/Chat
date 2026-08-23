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
  ProjectBootstrapCandidateId,
  ProjectBootstrapDecisionId,
  ProjectBootstrapOperationId,
  ProjectWorkspaceBindingId,
  ExecutionTracePage,
  RunActivityEvent,
  AgentKey,
  AgentRuntimeBaselineDto,
} from "@chat/contracts";
import type { PromptFragmentId, PromptFragmentRevisionId } from "@chat/contracts";
import type { PromptCatalogPort } from "./prompt-catalog-port.js";
import type { PromptFileLibraryPort } from "./prompt-file-library-port.js";
import type { TraceEventInput } from "@chat/contracts";
import type { ProductStorePort } from "./product-store-port.js";
import type { MemoryBackendRegistryPort } from "./memory-ports.js";
import type { MemoryImportBackendRegistryPort } from "./memory-import-ports.js";
import type { WorkflowMemoryProviderRegistryPort } from "./workflow-memory-ports.js";
import type { MemorySessionSourceRegistryPort } from "./memory-session-source-port.js";
import type {
  ProjectIntakeUnderstandingPort,
  ProjectAdvancementUnderstandingPort,
  ProjectResourceRootRegistryPort,
} from "./project-ports.js";
import type { WorkflowRuntimeTraceReaderPort } from "./runtime-ports.js";
import type {
  ProjectManagementBootstrapPort,
  ProjectWorkspaceProvisionerPort,
} from "./project-bootstrap-ports.js";

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

/**
 * Agent运行时只读说明由真正执行该Agent的Adapter提供。Application负责把它与
 * Chat拥有的可写Prompt并排投影，但不会复制或重写上游Agent实现。
 */
export interface AgentRuntimeProfileReaderPort {
  read(agentKey: AgentKey, workspaceRootId?: string): Promise<AgentRuntimeBaselineDto | undefined>;
}

export interface ProjectBootstrapIdFactory {
  candidate(): ProjectBootstrapCandidateId;
  decision(): ProjectBootstrapDecisionId;
  operation(): ProjectBootstrapOperationId;
  binding(): ProjectWorkspaceBindingId;
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
  /** Vercel Workflow World的脱敏只读投影；不暴露任何Runtime私有身份。 */
  readonly workflowRuntimeTrace?: WorkflowRuntimeTraceReaderPort;
  /** 遗留Memory query Port；由服务端组合根按mode与新Provider共用同一Adapter实例。 */
  readonly memoryBackends?: MemoryBackendRegistryPort;
  /** 遗留import Port；只在Workflow Runtime装配，避免API直接跨越外部写副作用。 */
  readonly memoryImportBackends?: MemoryImportBackendRegistryPort;
  /** 当前Workflow query/write稳定边界；Provider集合由CHAT_MEMORY_MODE显式冻结。 */
  readonly workflowMemoryProviders?: WorkflowMemoryProviderRegistryPort;
  /** Chat Session由Product Store读取；Codex等外部Session只经按需只读Adapter进入。 */
  readonly memorySessionSources?: MemorySessionSourceRegistryPort;
  readonly projectRoots?: ProjectResourceRootRegistryPort;
  readonly projectIntakeUnderstanding?: ProjectIntakeUnderstandingPort;
  readonly projectAdvancementUnderstanding?: ProjectAdvancementUnderstandingPort;
  readonly projectIds?: ProjectIdFactory;
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
  readonly projectBootstrapIds?: ProjectBootstrapIdFactory;
}

/** 规划修订默认上限（任务书§9.2.7）。 */
export const DEFAULT_MAX_PLAN_REVISIONS = 5;

/** 首版审批窗口：24小时；到期时间作为Approval产品事实持久化。 */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
