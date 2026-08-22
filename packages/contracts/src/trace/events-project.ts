/**
 * Trace事件族。schema仅供union.ts组合；对外经../trace.js barrel的联合类型。
 */
import { z } from "zod";
import { sha256Schema } from "../hash.js";
import {
  commandIdSchema,
  productSessionIdSchema,
  projectCandidateIdSchema,
  projectActionIdSchema,
  projectContributionIdSchema,
  projectDecisionIdSchema,
  projectMilestoneIdSchema,
  projectIdSchema,
  projectObservationIdSchema,
  projectParticipantIdSchema,
  projectResourceIdSchema,
  projectStageIdSchema,
  projectStateTransitionIdSchema,
  projectUpdateIdSchema,
  projectWorkIdSchema,
} from "../ids.js";
import {
  TRACE_EVENT_NAMES,
  versionSchema,
  traceErrorSchema,
  revisionSchema,
  endpointHostSchema,
  providerRequestIdSchema,
  tokenUsageSchema,
  durationMsOptional,
  durationMsRequired,
  defineTraceEvent,
} from "./foundations.js";

export const projectIntakeStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectIntakeStarted,
  "unknown",
  {
    projectCandidateId: projectCandidateIdSchema,
    productSessionId: productSessionIdSchema,
    commandId: commandIdSchema,
    candidateRevision: revisionSchema,
    ...durationMsOptional,
  },
);

export const projectIntakeCandidatePublishedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectIntakeCandidatePublished,
  "success",
  {
    projectCandidateId: projectCandidateIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    observationSha256: sha256Schema,
    ...durationMsRequired,
  },
);

export const projectIntakeConfirmedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectIntakeConfirmed,
  "success",
  {
    projectCandidateId: projectCandidateIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    projectId: projectIdSchema,
    projectRevision: revisionSchema,
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectIntakeRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectIntakeRejected,
  "rejected",
  {
    projectCandidateId: projectCandidateIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectAdvancementStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectAdvancementStarted,
  "unknown",
  {
    projectCandidateId: projectCandidateIdSchema,
    projectId: projectIdSchema,
    projectStageId: projectStageIdSchema,
    boundProjectRevision: revisionSchema,
    boundStageRevision: revisionSchema,
    commandId: commandIdSchema,
    candidateRevision: revisionSchema,
    ...durationMsOptional,
  },
);

export const projectAdvancementCandidatePublishedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectAdvancementCandidatePublished,
  "success",
  {
    projectCandidateId: projectCandidateIdSchema,
    projectId: projectIdSchema,
    projectStageId: projectStageIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    ...durationMsRequired,
  },
);

export const projectAdvancementConfirmedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectAdvancementConfirmed,
  "success",
  {
    projectCandidateId: projectCandidateIdSchema,
    projectId: projectIdSchema,
    projectStageId: projectStageIdSchema,
    projectUpdateId: projectUpdateIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    projectRevision: revisionSchema,
    stageRevision: revisionSchema,
    milestoneCount: z.number().int().nonnegative().max(8),
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectAdvancementRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectAdvancementRejected,
  "rejected",
  {
    projectCandidateId: projectCandidateIdSchema,
    projectId: projectIdSchema,
    projectStageId: projectStageIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectStageTransitionedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectStageTransitioned,
  "success",
  {
    projectId: projectIdSchema,
    projectStageId: projectStageIdSchema,
    projectStateTransitionId: projectStateTransitionIdSchema,
    projectDecisionId: projectDecisionIdSchema,
    fromStatus: z.enum(["planned", "active", "review", "completed", "skipped"]),
    toStatus: z.enum(["planned", "active", "review", "completed", "skipped"]),
    beforeRevision: revisionSchema,
    afterRevision: revisionSchema,
    evidenceCount: z.number().int().nonnegative().max(20),
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectLifecycleTransitionedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectLifecycleTransitioned,
  "success",
  {
    projectId: projectIdSchema,
    projectStateTransitionId: projectStateTransitionIdSchema,
    projectDecisionId: projectDecisionIdSchema,
    fromStatus: z.enum(["active", "paused", "completed", "archived"]),
    toStatus: z.enum(["active", "paused", "completed", "archived"]),
    beforeRevision: revisionSchema,
    afterRevision: revisionSchema,
    evidenceCount: z.number().int().nonnegative().max(20),
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectMilestoneTransitionedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectMilestoneTransitioned,
  "success",
  {
    projectId: projectIdSchema,
    projectMilestoneId: projectMilestoneIdSchema,
    projectStateTransitionId: projectStateTransitionIdSchema,
    projectDecisionId: projectDecisionIdSchema,
    fromStatus: z.enum(["planned", "achieved", "cancelled"]),
    toStatus: z.enum(["planned", "achieved", "cancelled"]),
    beforeRevision: revisionSchema,
    afterRevision: revisionSchema,
    evidenceCount: z.number().int().nonnegative().max(20),
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectUpdatePublishedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectUpdatePublished,
  "success",
  {
    projectId: projectIdSchema,
    projectStageId: projectStageIdSchema,
    projectUpdateId: projectUpdateIdSchema,
    projectRevision: revisionSchema,
    stageRevision: revisionSchema,
    updateRevision: revisionSchema,
    evidenceCount: z.number().int().nonnegative().max(20),
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectModelFields = {
  projectCandidateId: projectCandidateIdSchema,
  candidateRevision: revisionSchema,
  providerName: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u),
  endpointHost: endpointHostSchema,
  promptTemplateVersion: versionSchema,
  modelProfileVersion: versionSchema,
  inputManifestSha256: sha256Schema,
};

export const projectUnderstandingStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectUnderstandingStarted,
  "unknown",
  { ...projectModelFields, ...durationMsOptional },
);

export const projectUnderstandingCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectUnderstandingCompleted,
  "success",
  {
    ...projectModelFields,
    providerRequestId: providerRequestIdSchema.optional(),
    tokenUsage: tokenUsageSchema.optional(),
    ...durationMsRequired,
  },
);

export const projectUnderstandingFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectUnderstandingFailed,
  "failure",
  {
    ...projectModelFields,
    providerRequestId: providerRequestIdSchema.optional(),
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);

export const projectResourceObserveStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectResourceObserveStarted,
  "unknown",
  {
    projectId: projectIdSchema,
    projectResourceId: projectResourceIdSchema,
    adapterCount: z.number().int().positive().max(8),
    ...durationMsOptional,
  },
);

export const projectResourceObserveCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectResourceObserveCompleted,
  "success",
  {
    projectId: projectIdSchema,
    projectResourceId: projectResourceIdSchema,
    projectObservationId: projectObservationIdSchema,
    observationSha256: sha256Schema,
    adapterCount: z.number().int().positive().max(8),
    ...durationMsRequired,
  },
);

export const projectResourceObserveFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectResourceObserveFailed,
  "failure",
  {
    projectId: projectIdSchema.optional(),
    projectResourceId: projectResourceIdSchema.optional(),
    adapterCount: z.number().int().nonnegative().max(8),
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);

export const projectActionBaseFields = {
  projectId: projectIdSchema,
  projectActionId: projectActionIdSchema,
  projectWorkId: projectWorkIdSchema,
  ownerParticipantId: projectParticipantIdSchema,
  actionRevision: revisionSchema,
};

export const projectActionCreatedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectActionCreated,
  "success",
  { ...projectActionBaseFields, commandId: commandIdSchema, ...durationMsOptional },
);

export const projectActionAssignedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectActionAssigned,
  "success",
  { ...projectActionBaseFields, commandId: commandIdSchema, ...durationMsOptional },
);

export const projectActionTransitionedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectActionTransitioned,
  "success",
  {
    ...projectActionBaseFields,
    fromStatus: z.enum(["todo", "doing", "blocked", "done", "cancelled"]),
    toStatus: z.enum(["todo", "doing", "blocked", "done", "cancelled"]),
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectDecisionCandidateSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectDecisionCandidate,
  "unknown",
  {
    projectId: projectIdSchema,
    projectCandidateId: projectCandidateIdSchema,
    boundProjectRevision: revisionSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    ...durationMsOptional,
  },
);

export const projectDecisionCommittedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectDecisionCommitted,
  "success",
  {
    projectId: projectIdSchema,
    projectDecisionId: projectDecisionIdSchema,
    decidedByParticipantId: projectParticipantIdSchema,
    boundProjectRevision: revisionSchema,
    decisionRevision: revisionSchema,
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectDecisionRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectDecisionRejected,
  "rejected",
  {
    projectId: projectIdSchema,
    projectCandidateId: projectCandidateIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectContributionCandidateSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectContributionCandidate,
  "unknown",
  {
    projectId: projectIdSchema,
    projectCandidateId: projectCandidateIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    ...durationMsOptional,
  },
);

export const projectContributionCommittedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectContributionCommitted,
  "success",
  {
    projectId: projectIdSchema,
    projectContributionId: projectContributionIdSchema,
    participantId: projectParticipantIdSchema,
    contributionRevision: revisionSchema,
    evidenceStatus: z.enum(["reported", "verified"]),
    evidenceCount: z.number().int().nonnegative().max(20),
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

export const projectContributionRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.projectContributionRejected,
  "rejected",
  {
    projectId: projectIdSchema,
    projectCandidateId: projectCandidateIdSchema,
    candidateRevision: revisionSchema,
    candidateSha256: sha256Schema,
    commandId: commandIdSchema,
    ...durationMsOptional,
  },
);

// Workflow事件族：Run + Attempt + Definition版本；runMappingRef为后端私有映射引用，不是Hook Token。
