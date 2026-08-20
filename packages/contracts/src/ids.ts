import { z } from "zod";

/**
 * 带前缀的产品ID合同。
 *
 * 不变量：
 * - ID由服务端Product Store分配，浏览器只持有、不构造权威ID。
 * - 浏览器可见的ID仅限此文件导出的产品身份；Workflow Run ID、Hook Token、
 *   Checkpoint ID和pi Runtime Session ID永远不会出现在公开合同中。
 */
const prefixedId = <Prefix extends string>(prefix: Prefix) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`), `expected id with prefix "${prefix}_"`)
    .brand(prefix);

export const productSessionIdSchema = prefixedId("psn");
export const interactionIdSchema = prefixedId("ixn");
export const messageIdSchema = prefixedId("msg");
export const productRunIdSchema = prefixedId("run");
export const runAttemptIdSchema = prefixedId("att");
export const approvalRequestIdSchema = prefixedId("apr");
export const commandIdSchema = prefixedId("cmd");
export const workflowDefinitionIdSchema = prefixedId("wfd");
export const workflowDefinitionRevisionIdSchema = prefixedId("wfr");
export const workflowRunSpecIdSchema = prefixedId("wrs");
export const workflowViewDefinitionIdSchema = prefixedId("wvd");
export const workflowNodeRunIdSchema = prefixedId("wnr");
export const nodeRunTransitionIdSchema = prefixedId("wnt");
export const nodeValueManifestIdSchema = prefixedId("wvm");
export const projectIdSchema = prefixedId("prj");

/* B2 规划—确认—执行纵向链新增的产品身份。 */
export const principalIdSchema = prefixedId("usr");
export const planIdSchema = prefixedId("pln");
export const planRevisionIdSchema = prefixedId("plr");
export const revisionInputIdSchema = prefixedId("rin");
export const decisionIdSchema = prefixedId("dec");
export const executionContractIdSchema = prefixedId("exc");
export const executionCandidateIdSchema = prefixedId("xcd");
export const validationResultIdSchema = prefixedId("val");
export const artifactIdSchema = prefixedId("art");
export const outboxEntryIdSchema = prefixedId("obx");

/* Prompt Review产品身份；与Pi Operation、Provider Request及Workflow Hook严格分离。 */
export const promptReviewRequestIdSchema = prefixedId("prr");
export const promptReviewDecisionIdSchema = prefixedId("prd");
/** Direct Agent候选产品身份；不能复用Plan或Execution Candidate身份。 */
export const directAgentCandidateIdSchema = prefixedId("drc");

/* Prompt Studio用户资产与内置Catalog使用同一公开身份形状，事实所有权由ownerKind区分。 */
export const promptFragmentIdSchema = prefixedId("pfg");
export const promptFragmentRevisionIdSchema = prefixedId("pfr");
/** 一次消息发送时冻结的Prompt组装事实；不是Workflow或Pi Runtime身份。 */
export const promptAssemblyIdSchema = prefixedId("pma");

/* C1 长期上下文新增身份。均由服务端根据已提交产品身份确定性派生。 */
export const contextRequestIdSchema = prefixedId("ctxr");
export const memoryQueryIdSchema = prefixedId("mqy");
export const memoryResultSnapshotIdSchema = prefixedId("mrs");
export const memoryAdoptionIdSchema = prefixedId("mad");
export const contextPackageIdSchema = prefixedId("ctxp");
export const memoryBackendIdSchema = prefixedId("mbk");
export const memoryImportIntentIdSchema = prefixedId("mii");
export const memoryImportResultIdSchema = prefixedId("mir");

/*
 * Workflow Memory v1 使用独立身份，避免把旧 context.memory/Memory Import 对象
 * 冒充成新节点事实。旧对象继续只为历史回放保留。
 */
export const workflowMemoryQueryIdSchema = prefixedId("wmq");
export const workflowMemorySnapshotIdSchema = prefixedId("wms");
export const workflowMemoryContextIdSchema = prefixedId("wmc");
export const memoryWriteIntentIdSchema = prefixedId("mwi");
export const memoryWriteResultIdSchema = prefixedId("mwr");

/* PS1 Project Solution新增身份；与Git、Workflow和pi私有身份严格分离。 */
export const projectMethodSnapshotIdSchema = prefixedId("pms");
export const projectStageIdSchema = prefixedId("pst");
export const projectResourceIdSchema = prefixedId("prs");
export const projectParticipantIdSchema = prefixedId("ppt");
export const projectWorkIdSchema = prefixedId("pwk");
export const projectActionIdSchema = prefixedId("pac");
export const projectContributionIdSchema = prefixedId("pct");
export const projectEvidenceIdSchema = prefixedId("pev");
export const projectDecisionIdSchema = prefixedId("pdc");
export const projectObservationIdSchema = prefixedId("pob");
export const projectCandidateIdSchema = prefixedId("pca");
/* PS2.1 阶段推进新增身份；正文事实和系统Trace身份不得混用。 */
export const projectMilestoneIdSchema = prefixedId("pml");
export const projectUpdateIdSchema = prefixedId("pup");
export const projectStateTransitionIdSchema = prefixedId("ptr");

/* Plane CE项目初始化身份；不是旧Project聚合、Plane UUID或本地目录身份。 */
export const projectBootstrapCandidateIdSchema = prefixedId("pbc");
export const projectBootstrapDecisionIdSchema = prefixedId("pbd");
export const projectBootstrapOperationIdSchema = prefixedId("pbo");
export const projectWorkspaceBindingIdSchema = prefixedId("pwb");

/* R1/R2 用户规则身份；Revision与Selection必须能独立冻结、回放和审计。 */
export const ruleIdSchema = prefixedId("rul");
export const ruleRevisionIdSchema = prefixedId("rrv");
export const ruleTagIdSchema = prefixedId("rtg");
export const ruleScopeIdSchema = prefixedId("rsc");
export const ruleDecisionIdSchema = prefixedId("rde");
export const ruleSelectionIdSchema = prefixedId("rsl");
/* Planning运行冻结的Project Context；不是Project聚合或Workflow Runtime身份。 */
export const planningProjectContextIdSchema = prefixedId("pcx");
/** Planning Memory Selection不能复用ProjectMethodSnapshot既有的pms_*身份。 */
export const planningMemorySelectionIdSchema = prefixedId("pmsl");
/** Workflow Policy Resolution是产品策略事实，不是human Decision或Rule Decision。 */
export const workflowPolicyResolutionIdSchema = prefixedId("wpr");

/* S5 Note Capture产品身份；Note不得复用Message、Artifact或Workflow Runtime身份。 */
export const noteIdSchema = prefixedId("nte");
export const noteRevisionIdSchema = prefixedId("ntr");
export const noteCandidateIdSchema = prefixedId("ntc");
export const noteDecisionIdSchema = prefixedId("ntd");

/**
 * 服务端请求ID。客户端可提议复用，但必须通过本Schema才被信任；
 * 否则服务端生成新的req_*并在响应头返回最终生效ID。
 */
export const requestIdSchema = prefixedId("req");
export type RequestId = z.infer<typeof requestIdSchema>;

export type ProductSessionId = z.infer<typeof productSessionIdSchema>;
export type InteractionId = z.infer<typeof interactionIdSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type ProductRunId = z.infer<typeof productRunIdSchema>;
export type RunAttemptId = z.infer<typeof runAttemptIdSchema>;
export type ApprovalRequestId = z.infer<typeof approvalRequestIdSchema>;
export type CommandId = z.infer<typeof commandIdSchema>;
export type WorkflowDefinitionId = z.infer<typeof workflowDefinitionIdSchema>;
export type WorkflowDefinitionRevisionId = z.infer<typeof workflowDefinitionRevisionIdSchema>;
export type WorkflowRunSpecId = z.infer<typeof workflowRunSpecIdSchema>;
export type WorkflowViewDefinitionId = z.infer<typeof workflowViewDefinitionIdSchema>;
export type WorkflowNodeRunId = z.infer<typeof workflowNodeRunIdSchema>;
export type NodeRunTransitionId = z.infer<typeof nodeRunTransitionIdSchema>;
export type NodeValueManifestId = z.infer<typeof nodeValueManifestIdSchema>;
export type ProjectId = z.infer<typeof projectIdSchema>;
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type PlanId = z.infer<typeof planIdSchema>;
export type PlanRevisionId = z.infer<typeof planRevisionIdSchema>;
export type RevisionInputId = z.infer<typeof revisionInputIdSchema>;
export type DecisionId = z.infer<typeof decisionIdSchema>;
export type ExecutionContractId = z.infer<typeof executionContractIdSchema>;
export type ExecutionCandidateId = z.infer<typeof executionCandidateIdSchema>;
export type ValidationResultId = z.infer<typeof validationResultIdSchema>;
export type ArtifactId = z.infer<typeof artifactIdSchema>;
export type OutboxEntryId = z.infer<typeof outboxEntryIdSchema>;
export type PromptReviewRequestId = z.infer<typeof promptReviewRequestIdSchema>;
export type PromptReviewDecisionId = z.infer<typeof promptReviewDecisionIdSchema>;
export type DirectAgentCandidateId = z.infer<typeof directAgentCandidateIdSchema>;
export type PromptFragmentId = z.infer<typeof promptFragmentIdSchema>;
export type PromptFragmentRevisionId = z.infer<typeof promptFragmentRevisionIdSchema>;
export type PromptAssemblyId = z.infer<typeof promptAssemblyIdSchema>;
export type ContextRequestId = z.infer<typeof contextRequestIdSchema>;
export type MemoryQueryId = z.infer<typeof memoryQueryIdSchema>;
export type MemoryResultSnapshotId = z.infer<typeof memoryResultSnapshotIdSchema>;
export type MemoryAdoptionId = z.infer<typeof memoryAdoptionIdSchema>;
export type ContextPackageId = z.infer<typeof contextPackageIdSchema>;
export type MemoryBackendId = z.infer<typeof memoryBackendIdSchema>;
export type MemoryImportIntentId = z.infer<typeof memoryImportIntentIdSchema>;
export type MemoryImportResultId = z.infer<typeof memoryImportResultIdSchema>;
export type WorkflowMemoryQueryId = z.infer<typeof workflowMemoryQueryIdSchema>;
export type WorkflowMemorySnapshotId = z.infer<typeof workflowMemorySnapshotIdSchema>;
export type WorkflowMemoryContextId = z.infer<typeof workflowMemoryContextIdSchema>;
export type MemoryWriteIntentId = z.infer<typeof memoryWriteIntentIdSchema>;
export type MemoryWriteResultId = z.infer<typeof memoryWriteResultIdSchema>;
export type ProjectMethodSnapshotId = z.infer<typeof projectMethodSnapshotIdSchema>;
export type ProjectStageId = z.infer<typeof projectStageIdSchema>;
export type ProjectResourceId = z.infer<typeof projectResourceIdSchema>;
export type ProjectParticipantId = z.infer<typeof projectParticipantIdSchema>;
export type ProjectWorkId = z.infer<typeof projectWorkIdSchema>;
export type ProjectActionId = z.infer<typeof projectActionIdSchema>;
export type ProjectContributionId = z.infer<typeof projectContributionIdSchema>;
export type ProjectEvidenceId = z.infer<typeof projectEvidenceIdSchema>;
export type ProjectDecisionId = z.infer<typeof projectDecisionIdSchema>;
export type ProjectObservationId = z.infer<typeof projectObservationIdSchema>;
export type ProjectCandidateId = z.infer<typeof projectCandidateIdSchema>;
export type ProjectMilestoneId = z.infer<typeof projectMilestoneIdSchema>;
export type ProjectUpdateId = z.infer<typeof projectUpdateIdSchema>;
export type ProjectStateTransitionId = z.infer<typeof projectStateTransitionIdSchema>;
export type ProjectBootstrapCandidateId = z.infer<typeof projectBootstrapCandidateIdSchema>;
export type ProjectBootstrapDecisionId = z.infer<typeof projectBootstrapDecisionIdSchema>;
export type ProjectBootstrapOperationId = z.infer<typeof projectBootstrapOperationIdSchema>;
export type ProjectWorkspaceBindingId = z.infer<typeof projectWorkspaceBindingIdSchema>;
export type RuleId = z.infer<typeof ruleIdSchema>;
export type RuleRevisionId = z.infer<typeof ruleRevisionIdSchema>;
export type RuleTagId = z.infer<typeof ruleTagIdSchema>;
export type RuleScopeId = z.infer<typeof ruleScopeIdSchema>;
export type RuleDecisionId = z.infer<typeof ruleDecisionIdSchema>;
export type RuleSelectionId = z.infer<typeof ruleSelectionIdSchema>;
export type PlanningProjectContextId = z.infer<typeof planningProjectContextIdSchema>;
export type PlanningMemorySelectionId = z.infer<typeof planningMemorySelectionIdSchema>;
export type WorkflowPolicyResolutionId = z.infer<typeof workflowPolicyResolutionIdSchema>;
export type NoteId = z.infer<typeof noteIdSchema>;
export type NoteRevisionId = z.infer<typeof noteRevisionIdSchema>;
export type NoteCandidateId = z.infer<typeof noteCandidateIdSchema>;
export type NoteDecisionId = z.infer<typeof noteDecisionIdSchema>;
