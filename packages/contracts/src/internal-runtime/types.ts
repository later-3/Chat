/**
 * 内部Runtime合同 types 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  compilePlanningInputRequestSchema,
  planningInputDtoSchema,
  preparePlanningContextRequestSchema,
  memoryQueryDispatchDtoSchema,
  beginPlanningContextResponseSchema,
  memoryQueryExecutionResultSchema,
  persistPlanningContextResultRequestSchema,
  preparePlanningContextResponseSchema,
  beginWorkflowMemoryQueryRequestSchema,
  workflowMemoryQueryDispatchDtoSchema,
  workflowMemoryQueryExecutionResultSchema,
  beginWorkflowMemoryQueryResponseSchema,
  persistWorkflowMemoryQueryResultRequestSchema,
  persistWorkflowMemoryQueryResultResponseSchema,
  freezeWorkflowMemoryContextRequestSchema,
  freezeWorkflowMemoryContextResponseSchema,
  prepareMemoryWriteAgentInputRequestSchema,
  prepareMemoryWriteAgentInputResponseSchema,
  persistMemoryWriteAgentCandidateRequestSchema,
  persistMemoryWriteAgentCandidateResponseSchema,
  beginMemoryAgentOperationRequestSchema,
  beginMemoryAgentOperationResponseSchema,
  completeMemoryAgentOperationRequestSchema,
  markMemoryAgentOperationOutcomeUnknownRequestSchema,
  memoryAgentOperationResponseSchema,
} from "./planning.js";
import {
  publishPlanReviewRequestSchema,
  publishPlanReviewResponseSchema,
  loadCommittedDecisionRequestSchema,
  loadCommittedDecisionResponseSchema,
  compileExecutionContractRequestSchema,
  persistExecutionCandidateRequestSchema,
  persistValidationResultRequestSchema,
  commitExecutionResultRequestSchema,
  commitRejectedRunRequestSchema,
  commitRunFailureRequestSchema,
  commitRunOutcomeUnknownRuntimeRequestSchema,
  expireApprovalRequestSchema,
  executionContextItemDtoSchema,
  beginRunAttemptRequestSchema,
  beginRunAttemptResponseSchema,
  authorizeExecutorOperationRequestSchema,
  authorizeExecutorOperationResponseSchema,
  completeRunAttemptRequestSchema,
  loadWorkflowRunSpecRequestSchema,
  loadWorkflowRunSpecResponseSchema,
} from "./execution.js";
import {
  preparePlanningMemoryContextRequestSchema,
  preparePlanningMemoryContextResponseSchema,
  preparePlanningProjectContextRequestSchema,
  preparePlanningProjectContextResponseSchema,
  preparePlanningRulesContextRequestSchema,
  preparePlanningRulesContextResponseSchema,
} from "./context-prep.js";
import {
  governanceReviewInputDtoSchema,
  prepareGovernanceReviewInputRequestSchema,
  prepareGovernanceReviewInputResponseSchema,
} from "./governance.js";
import {
  publishNoteCandidateRuntimeRequestSchema,
  publishNoteCandidateRuntimeResponseSchema,
  prepareNoteCaptureInputRuntimeRequestSchema,
  prepareNoteCaptureInputRuntimeResponseSchema,
  loadNoteDecisionRuntimeRequestSchema,
  loadNoteDecisionRuntimeResponseSchema,
  commitConfirmedNoteRuntimeRequestSchema,
  commitConfirmedNoteRuntimeResponseSchema,
  transitionConfigurablePlanningNodeRequestSchema,
} from "./note.js";
import {
  workflowStartRequestSchema,
  workflowResumeRequestSchema,
  workflowReconcileResponseSchema,
} from "./dispatch.js";
import { loadMemoryImportRequestSchema, loadMemoryImportResponseSchema } from "./memory-import.js";
import {
  loadMemoryWriteRequestSchema,
  loadMemoryWriteResponseSchema,
  beginWorkflowMemoryWriteRequestSchema,
  beginWorkflowMemoryWriteResponseSchema,
  markMemoryWriteDispatchingRequestSchema,
  commitMemoryWriteAcceptedRequestSchema,
  commitMemoryWriteMaterializedRequestSchema,
  commitMemoryWriteFailedRequestSchema,
  commitMemoryWriteOutcomeUnknownRequestSchema,
} from "./memory-write.js";

export type CompilePlanningInputRequest = z.infer<typeof compilePlanningInputRequestSchema>;
export type PreparePlanningContextRequest = z.infer<typeof preparePlanningContextRequestSchema>;
export type BeginPlanningContextResponse = z.infer<typeof beginPlanningContextResponseSchema>;
export type PreparePlanningContextResponse = z.infer<typeof preparePlanningContextResponseSchema>;
export type MemoryQueryDispatchDto = z.infer<typeof memoryQueryDispatchDtoSchema>;
export type MemoryQueryExecutionResult = z.infer<typeof memoryQueryExecutionResultSchema>;
export type PersistPlanningContextResultRequest = z.infer<
  typeof persistPlanningContextResultRequestSchema
>;
export type BeginWorkflowMemoryQueryRequest = z.infer<typeof beginWorkflowMemoryQueryRequestSchema>;
export type BeginWorkflowMemoryQueryResponse = z.infer<
  typeof beginWorkflowMemoryQueryResponseSchema
>;
export type WorkflowMemoryQueryDispatchDto = z.infer<typeof workflowMemoryQueryDispatchDtoSchema>;
export type WorkflowMemoryQueryExecutionResult = z.infer<
  typeof workflowMemoryQueryExecutionResultSchema
>;
export type PersistWorkflowMemoryQueryResultRequest = z.infer<
  typeof persistWorkflowMemoryQueryResultRequestSchema
>;
export type PersistWorkflowMemoryQueryResultResponse = z.infer<
  typeof persistWorkflowMemoryQueryResultResponseSchema
>;
export type FreezeWorkflowMemoryContextRequest = z.infer<
  typeof freezeWorkflowMemoryContextRequestSchema
>;
export type FreezeWorkflowMemoryContextResponse = z.infer<
  typeof freezeWorkflowMemoryContextResponseSchema
>;
export type PrepareMemoryWriteAgentInputRequest = z.infer<
  typeof prepareMemoryWriteAgentInputRequestSchema
>;
export type PrepareMemoryWriteAgentInputResponse = z.infer<
  typeof prepareMemoryWriteAgentInputResponseSchema
>;
export type PersistMemoryWriteAgentCandidateRequest = z.infer<
  typeof persistMemoryWriteAgentCandidateRequestSchema
>;
export type PersistMemoryWriteAgentCandidateResponse = z.infer<
  typeof persistMemoryWriteAgentCandidateResponseSchema
>;
export type BeginMemoryAgentOperationRequest = z.infer<
  typeof beginMemoryAgentOperationRequestSchema
>;
export type BeginMemoryAgentOperationResponse = z.infer<
  typeof beginMemoryAgentOperationResponseSchema
>;
export type CompleteMemoryAgentOperationRequest = z.infer<
  typeof completeMemoryAgentOperationRequestSchema
>;
export type MarkMemoryAgentOperationOutcomeUnknownRequest = z.infer<
  typeof markMemoryAgentOperationOutcomeUnknownRequestSchema
>;
export type MemoryAgentOperationResponse = z.infer<typeof memoryAgentOperationResponseSchema>;
export type PlanningInputDto = z.infer<typeof planningInputDtoSchema>;
export type PublishPlanReviewRequest = z.infer<typeof publishPlanReviewRequestSchema>;
export type PublishPlanReviewResponse = z.infer<typeof publishPlanReviewResponseSchema>;
export type LoadCommittedDecisionRequest = z.infer<typeof loadCommittedDecisionRequestSchema>;
export type LoadCommittedDecisionResponse = z.infer<typeof loadCommittedDecisionResponseSchema>;
export type CompileExecutionContractRequest = z.infer<typeof compileExecutionContractRequestSchema>;
export type PersistExecutionCandidateRequest = z.infer<
  typeof persistExecutionCandidateRequestSchema
>;
export type PersistValidationResultRequest = z.infer<typeof persistValidationResultRequestSchema>;
export type CommitExecutionResultRequest = z.infer<typeof commitExecutionResultRequestSchema>;
export type CommitRejectedRunRequest = z.infer<typeof commitRejectedRunRequestSchema>;
export type LoadMemoryImportRequest = z.infer<typeof loadMemoryImportRequestSchema>;
export type LoadMemoryImportResponse = z.infer<typeof loadMemoryImportResponseSchema>;
export type LoadMemoryWriteRequest = z.infer<typeof loadMemoryWriteRequestSchema>;
export type LoadMemoryWriteResponse = z.infer<typeof loadMemoryWriteResponseSchema>;
export type BeginWorkflowMemoryWriteRequest = z.infer<typeof beginWorkflowMemoryWriteRequestSchema>;
export type BeginWorkflowMemoryWriteResponse = z.infer<
  typeof beginWorkflowMemoryWriteResponseSchema
>;
export type MarkMemoryWriteDispatchingRequest = z.infer<
  typeof markMemoryWriteDispatchingRequestSchema
>;
export type CommitMemoryWriteAcceptedRequest = z.infer<
  typeof commitMemoryWriteAcceptedRequestSchema
>;
export type CommitMemoryWriteMaterializedRequest = z.infer<
  typeof commitMemoryWriteMaterializedRequestSchema
>;
export type CommitMemoryWriteFailedRequest = z.infer<typeof commitMemoryWriteFailedRequestSchema>;
export type CommitMemoryWriteOutcomeUnknownRequest = z.infer<
  typeof commitMemoryWriteOutcomeUnknownRequestSchema
>;
export type CommitRunFailureRequest = z.infer<typeof commitRunFailureRequestSchema>;
export type CommitRunOutcomeUnknownRuntimeRequest = z.infer<
  typeof commitRunOutcomeUnknownRuntimeRequestSchema
>;
export type ExpireApprovalRequest = z.infer<typeof expireApprovalRequestSchema>;
export type BeginRunAttemptRequest = z.infer<typeof beginRunAttemptRequestSchema>;
export type BeginRunAttemptResponse = z.infer<typeof beginRunAttemptResponseSchema>;
export type AuthorizeExecutorOperationRequest = z.infer<
  typeof authorizeExecutorOperationRequestSchema
>;
export type AuthorizeExecutorOperationResponse = z.infer<
  typeof authorizeExecutorOperationResponseSchema
>;
export type CompleteRunAttemptRequest = z.infer<typeof completeRunAttemptRequestSchema>;
export type LoadWorkflowRunSpecRequest = z.infer<typeof loadWorkflowRunSpecRequestSchema>;
export type LoadWorkflowRunSpecResponse = z.infer<typeof loadWorkflowRunSpecResponseSchema>;
export type PreparePlanningMemoryContextRequest = z.infer<
  typeof preparePlanningMemoryContextRequestSchema
>;
export type PreparePlanningMemoryContextResponse = z.infer<
  typeof preparePlanningMemoryContextResponseSchema
>;
export type PreparePlanningProjectContextRequest = z.infer<
  typeof preparePlanningProjectContextRequestSchema
>;
export type PreparePlanningProjectContextResponse = z.infer<
  typeof preparePlanningProjectContextResponseSchema
>;
export type PreparePlanningRulesContextRequest = z.infer<
  typeof preparePlanningRulesContextRequestSchema
>;
export type PreparePlanningRulesContextResponse = z.infer<
  typeof preparePlanningRulesContextResponseSchema
>;
export type PrepareGovernanceReviewInputRequest = z.infer<
  typeof prepareGovernanceReviewInputRequestSchema
>;
export type PrepareGovernanceReviewInputResponse = z.infer<
  typeof prepareGovernanceReviewInputResponseSchema
>;
export type GovernanceReviewInputDto = z.infer<typeof governanceReviewInputDtoSchema>;
export type PublishNoteCandidateRuntimeRequest = z.infer<
  typeof publishNoteCandidateRuntimeRequestSchema
>;
export type PublishNoteCandidateRuntimeResponse = z.infer<
  typeof publishNoteCandidateRuntimeResponseSchema
>;
export type PrepareNoteCaptureInputRuntimeRequest = z.infer<
  typeof prepareNoteCaptureInputRuntimeRequestSchema
>;
export type PrepareNoteCaptureInputRuntimeResponse = z.infer<
  typeof prepareNoteCaptureInputRuntimeResponseSchema
>;
export type LoadNoteDecisionRuntimeRequest = z.infer<typeof loadNoteDecisionRuntimeRequestSchema>;
export type LoadNoteDecisionRuntimeResponse = z.infer<typeof loadNoteDecisionRuntimeResponseSchema>;
export type CommitConfirmedNoteRuntimeRequest = z.infer<
  typeof commitConfirmedNoteRuntimeRequestSchema
>;
export type CommitConfirmedNoteRuntimeResponse = z.infer<
  typeof commitConfirmedNoteRuntimeResponseSchema
>;
export type TransitionConfigurablePlanningNodeRequest = z.infer<
  typeof transitionConfigurablePlanningNodeRequestSchema
>;
export type ExecutionContextItemDto = z.infer<typeof executionContextItemDtoSchema>;
export type WorkflowStartRequest = z.infer<typeof workflowStartRequestSchema>;
export type WorkflowResumeRequest = z.infer<typeof workflowResumeRequestSchema>;
export type WorkflowReconcileResponse = z.infer<typeof workflowReconcileResponseSchema>;
