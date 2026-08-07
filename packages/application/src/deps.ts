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
} from "@chat/contracts";
import type { TraceEventInput } from "@chat/contracts";
import type { ProductStorePort } from "./product-store-port.js";

/** Trace发射器：由组合根提供（@chat/realtime Sink）；Application不依赖具体Sink。 */
export type TraceEmitter = (event: TraceEventInput) => void;

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

export interface ApplicationDeps {
  readonly store: ProductStorePort;
  readonly now: () => string;
  readonly ids: IdFactory;
  /** 可选Trace发射；缺省时用例不产生Trace（骨架模式与部分纯规则测试）。 */
  readonly trace?: TraceEmitter;
}

/** 规划修订默认上限（任务书§9.2.7）。 */
export const DEFAULT_MAX_PLAN_REVISIONS = 5;

/** 首版审批窗口：24小时；到期时间作为Approval产品事实持久化。 */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
