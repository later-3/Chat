import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  productSessionIdSchema,
  projectActionIdSchema,
  projectCandidateIdSchema,
  projectContributionIdSchema,
  projectDecisionIdSchema,
  projectEvidenceIdSchema,
  projectIdSchema,
  projectMilestoneIdSchema,
  projectObservationIdSchema,
  projectParticipantIdSchema,
  projectPracticeRevisionIdSchema,
  projectResourceIdSchema,
  projectStageIdSchema,
  projectUpdateIdSchema,
  projectWorkIdSchema,
  projectWorkBlockIdSchema,
  projectWorkClaimIdSchema,
  projectWorkHandoffIdSchema,
  projectWorkOutcomeIdSchema,
  projectContextMapIdSchema,
} from "./ids.js";
import {
  projectActionStatusSchema,
  projectAdvancementProposalSchema,
  projectHealthSchema,
  projectIntakeProposalSchema,
  projectManagementProposalSchema,
  projectMethodProfileIdSchema as projectMethodProfileV3IdSchema,
  projectResourceAdapterKindSchema as projectResourceAdapterKindV3Schema,
  projectStatusSchema,
  projectContentWorkStatusSchema,
  projectLegacyWorkStatusSchema,
  projectPracticeWorkStatusSchema,
  projectWorkKeySchema,
} from "./project.js";
import { projectRecoverableWorkStateSchema } from "./project-coordination.js";
import {
  projectMethodProfileIdSchema,
  projectResourceAdapterKindSchema,
  projectWorkStatusSchema,
} from "./project-api-v2-compat.js";

/**
 * main曾公开写出的v2网络身份。它只用于在边界先识别旧响应并路由到冻结兼容投影，
 * 不能被新响应继续写出；v3新增的Work/Context/Provider字段不得原地塞回v2。
 */
export const PROJECT_API_SCHEMA_VERSION = "chat-project-api.v2";
export const PROJECT_API_V3_SCHEMA_VERSION = "chat-project-api.v3";

export const beginProjectIntakePayloadSchema = z
  .object({
    sessionId: productSessionIdSchema,
    text: z.string().trim().min(1).max(4_000),
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
  })
  .strict();

export const beginProjectManagementCandidatePayloadSchema = z
  .object({
    sessionId: productSessionIdSchema,
    projectId: projectIdSchema,
    kind: z.enum(["action", "decision", "contribution"]),
    text: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const beginProjectAdvancementPayloadSchema = z
  .object({
    sessionId: productSessionIdSchema,
    projectId: projectIdSchema,
    text: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const projectAdvancementCandidateDecisionPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("revise"),
      candidateSha256: sha256Schema,
      proposal: projectAdvancementProposalSchema,
    })
    .strict(),
  z.object({ kind: z.literal("confirm"), candidateSha256: sha256Schema }).strict(),
  z
    .object({
      kind: z.literal("reject"),
      candidateSha256: sha256Schema,
      reason: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict(),
]);

export const projectManagementCandidateDecisionPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("revise"),
      candidateSha256: sha256Schema,
      proposal: projectManagementProposalSchema,
    })
    .strict(),
  z.object({ kind: z.literal("confirm"), candidateSha256: sha256Schema }).strict(),
  z
    .object({
      kind: z.literal("reject"),
      candidateSha256: sha256Schema,
      reason: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict(),
]);

export const projectCandidateDecisionPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("revise"),
      candidateSha256: sha256Schema,
      proposal: projectIntakeProposalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirm"),
      candidateSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reject"),
      candidateSha256: sha256Schema,
      reason: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict(),
]);

export const createProjectActionPayloadSchema = z
  .object({
    workId: projectWorkIdSchema,
    title: z.string().trim().min(1).max(240),
    ownerParticipantId: projectParticipantIdSchema,
    dueAt: z.iso.datetime().optional(),
  })
  .strict();

export const assignProjectActionPayloadSchema = z
  .object({ ownerParticipantId: projectParticipantIdSchema })
  .strict();

export const transitionProjectActionPayloadSchema = z
  .object({
    status: projectActionStatusSchema,
    blockedReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const transitionProjectStagePayloadSchema = z
  .object({
    status: z.enum(["active", "review", "completed", "skipped"]),
    reason: z.string().trim().min(1).max(2_000),
    decidedByParticipantId: projectParticipantIdSchema,
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
  })
  .strict();

export const transitionProjectLifecyclePayloadSchema = z
  .object({
    status: projectStatusSchema,
    reason: z.string().trim().min(1).max(2_000),
    decidedByParticipantId: projectParticipantIdSchema,
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
  })
  .strict();

export const transitionProjectMilestonePayloadSchema = z
  .object({
    status: z.enum(["achieved", "cancelled"]),
    reason: z.string().trim().min(1).max(2_000),
    decidedByParticipantId: projectParticipantIdSchema,
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
  })
  .strict();

export const setProjectArchiveStatusPayloadSchema = z
  .object({ status: z.enum(["active", "archived"]) })
  .strict();

export const recordProjectDecisionPayloadSchema = z
  .object({
    question: z.string().trim().min(1).max(1_000),
    options: z.array(z.string().trim().min(1).max(1_000)).min(1).max(12),
    choice: z.string().trim().min(1).max(1_000),
    rationale: z.string().trim().min(1).max(2_000),
    decidedByParticipantId: projectParticipantIdSchema,
  })
  .strict();

export const recordProjectContributionPayloadSchema = z
  .object({
    participantId: projectParticipantIdSchema,
    workId: projectWorkIdSchema.optional(),
    actionId: projectActionIdSchema.optional(),
    kind: z.enum([
      "analysis",
      "code",
      "document",
      "script",
      "review",
      "test",
      "deployment",
      "coordination",
    ]),
    summary: z.string().trim().min(1).max(2_000),
    evidenceIds: z.array(z.string().regex(/^pev_[A-Za-z0-9]+$/u)).max(20),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const projectRootV3DtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_API_V3_SCHEMA_VERSION),
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    displayName: z.string().min(1).max(160),
    enabledAdapters: z.array(projectResourceAdapterKindV3Schema).min(1).max(3),
  })
  .strict();

const projectCandidateBaseDto = {
  schemaVersion: z.literal(PROJECT_API_V3_SCHEMA_VERSION),
  projectCandidateId: projectCandidateIdSchema,
  sessionId: productSessionIdSchema,
  candidateKind: z.literal("intake"),
  rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

const projectIntakeCandidateDtoSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...projectCandidateBaseDto,
      status: z.literal("queued"),
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...projectCandidateBaseDto,
      status: z.literal("failed"),
      failureCode: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u),
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...projectCandidateBaseDto,
      status: z.literal("under_review"),
      proposal: projectIntakeProposalSchema,
      resource: z
        .object({
          displayName: z.string().min(1).max(160),
          branch: z.string().min(1).max(240),
          headSha: z.string().regex(/^[0-9a-f]{40}$/u),
          dirty: z.boolean(),
          documentCount: z.number().int().nonnegative(),
          scriptCount: z.number().int().nonnegative(),
        })
        .strict(),
      candidateSha256: sha256Schema,
      allowedActions: z.tuple([z.literal("revise"), z.literal("confirm"), z.literal("reject")]),
    })
    .strict(),
  z
    .object({
      ...projectCandidateBaseDto,
      status: z.literal("confirmed"),
      proposal: projectIntakeProposalSchema,
      candidateSha256: sha256Schema,
      confirmedProjectId: projectIdSchema,
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...projectCandidateBaseDto,
      status: z.literal("rejected"),
      proposal: projectIntakeProposalSchema.optional(),
      candidateSha256: sha256Schema.optional(),
      allowedActions: z.tuple([]),
    })
    .strict(),
]);

const projectManagementCandidateDtoBase = {
  schemaVersion: z.literal(PROJECT_API_V3_SCHEMA_VERSION),
  projectCandidateId: projectCandidateIdSchema,
  sessionId: productSessionIdSchema,
  candidateKind: z.literal("management"),
  projectId: projectIdSchema,
  boundProjectRevision: z.number().int().positive(),
  proposal: projectManagementProposalSchema,
  candidateSha256: sha256Schema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

const projectManagementCandidateDtoSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...projectManagementCandidateDtoBase,
      status: z.literal("under_review"),
      allowedActions: z.tuple([z.literal("revise"), z.literal("confirm"), z.literal("reject")]),
    })
    .strict(),
  z
    .object({
      ...projectManagementCandidateDtoBase,
      status: z.literal("confirmed"),
      committedObjectId: z.string().regex(/^(pac|pdc|pct)_[A-Za-z0-9]+$/u),
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...projectManagementCandidateDtoBase,
      status: z.literal("rejected"),
      allowedActions: z.tuple([]),
    })
    .strict(),
]);

const projectAdvancementCandidateDtoBase = {
  schemaVersion: z.literal(PROJECT_API_V3_SCHEMA_VERSION),
  projectCandidateId: projectCandidateIdSchema,
  sessionId: productSessionIdSchema,
  candidateKind: z.literal("advancement"),
  projectId: projectIdSchema,
  boundProjectRevision: z.number().int().positive(),
  boundStageId: projectStageIdSchema,
  boundStageRevision: z.number().int().positive(),
  proposal: projectAdvancementProposalSchema.optional(),
  candidateSha256: sha256Schema.optional(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

const projectAdvancementCandidateDtoSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...projectAdvancementCandidateDtoBase,
      status: z.literal("queued"),
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...projectAdvancementCandidateDtoBase,
      status: z.literal("failed"),
      failureCode: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u),
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...projectAdvancementCandidateDtoBase,
      status: z.literal("under_review"),
      proposal: projectAdvancementProposalSchema,
      candidateSha256: sha256Schema,
      allowedActions: z.tuple([z.literal("revise"), z.literal("confirm"), z.literal("reject")]),
    })
    .strict(),
  z
    .object({
      ...projectAdvancementCandidateDtoBase,
      status: z.literal("confirmed"),
      proposal: projectAdvancementProposalSchema,
      candidateSha256: sha256Schema,
      committedStageId: projectStageIdSchema,
      committedMilestoneIds: z.array(projectMilestoneIdSchema).max(8),
      committedUpdateId: projectUpdateIdSchema,
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...projectAdvancementCandidateDtoBase,
      status: z.literal("rejected"),
      allowedActions: z.tuple([]),
    })
    .strict(),
]);

export const projectCandidateDtoSchema = z.union([
  projectIntakeCandidateDtoSchema,
  projectManagementCandidateDtoSchema,
  projectAdvancementCandidateDtoSchema,
]);

export const currentProjectCandidateResponseSchema = z
  .object({ candidate: projectCandidateDtoSchema.nullable() })
  .strict();

export const projectSummaryV3DtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_API_V3_SCHEMA_VERSION),
    projectId: projectIdSchema,
    name: z.string().min(1).max(120),
    summary: z.string().min(1).max(1_000),
    goal: z.string().min(1).max(4_000),
    status: projectStatusSchema,
    methodProfileId: projectMethodProfileV3IdSchema,
    stageName: z.string().min(1).max(120),
    activeWorkCount: z.number().int().nonnegative(),
    openActionCount: z.number().int().nonnegative(),
    participantCount: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const participantDtoSchema = z
  .object({
    projectParticipantId: projectParticipantIdSchema,
    kind: z.enum(["human", "agent", "automation", "external"]),
    displayName: z.string().min(1).max(120),
    role: z.string().min(1).max(120),
    status: z.enum(["active", "inactive"]),
  })
  .strict();

const actionDtoSchema = z
  .object({
    projectActionId: projectActionIdSchema,
    workId: projectWorkIdSchema,
    title: z.string().min(1).max(240),
    ownerParticipantId: projectParticipantIdSchema,
    status: projectActionStatusSchema,
    blockedReason: z.string().min(1).max(500).optional(),
    dueAt: z.iso.datetime().optional(),
    revision: z.number().int().positive(),
  })
  .strict();

const workBlockDtoSchema = z
  .object({
    projectWorkBlockId: projectWorkBlockIdSchema,
    previousState: projectRecoverableWorkStateSchema,
    reason: z.string().min(1).max(4_000),
    stoppedAt: z.string().min(1).max(4_000),
    recoveryConditions: z.array(z.string()).min(1).max(20),
    reportedByParticipantId: projectParticipantIdSchema,
    revision: z.number().int().positive(),
  })
  .strict();

const workClaimDtoSchema = z
  .object({
    projectWorkClaimId: projectWorkClaimIdSchema,
    participantId: projectParticipantIdSchema,
    acquiredAt: z.iso.datetime(),
    leaseExpiresAt: z.iso.datetime(),
    revision: z.number().int().positive(),
  })
  .strict();

const workHandoffDtoSchema = z
  .object({
    projectWorkHandoffId: projectWorkHandoffIdSchema,
    fromParticipantId: projectParticipantIdSchema,
    toParticipantId: projectParticipantIdSchema.optional(),
    completed: z.array(z.string()).max(20),
    remaining: z.array(z.string()).min(1).max(20),
    risks: z.array(z.string()).max(20),
    nextStep: z.string().min(1).max(500),
    requiredReads: z.array(z.string()).max(20),
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
    createdAt: z.iso.datetime(),
  })
  .strict();

const workDtoCommon = {
  projectWorkId: projectWorkIdSchema,
  workKey: projectWorkKeySchema,
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(4_000),
  acceptanceCriteria: z.array(z.string()).min(1).max(20),
  dependsOn: z.array(projectWorkIdSchema).max(20),
  ownerParticipantId: projectParticipantIdSchema,
  practiceRevisionIds: z.array(projectPracticeRevisionIdSchema).max(20),
  resourceRefs: z.array(z.string()).max(50),
  activeBlock: workBlockDtoSchema.nullable(),
  activeClaim: workClaimDtoSchema.nullable(),
  latestHandoff: workHandoffDtoSchema.nullable(),
  revision: z.number().int().positive(),
  actions: z.array(actionDtoSchema).max(100),
};

const workV3DtoSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...workDtoCommon, kind: z.literal("generic"), status: projectLegacyWorkStatusSchema })
    .strict(),
  z
    .object({
      ...workDtoCommon,
      kind: z.literal("content_delivery"),
      status: projectContentWorkStatusSchema,
      content: z
        .object({
          targetPlatforms: z.array(z.string()).min(1).max(10),
          sourceRef: z.string().min(1).max(500),
          seriesKey: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...workDtoCommon,
      kind: z.literal("workflow_improvement"),
      status: projectPracticeWorkStatusSchema,
      practice: z
        .object({ practiceKey: z.string(), hypothesis: z.string().min(1).max(4_000) })
        .strict(),
    })
    .strict(),
]);

const practiceRevisionDtoSchema = z
  .object({
    projectPracticeRevisionId: projectPracticeRevisionIdSchema,
    practiceKey: z.string(),
    version: z.number().int().positive(),
    title: z.string().min(1).max(200),
    applicableWorkKinds: z.array(z.enum(["content_delivery", "workflow_improvement"])),
    artifactEvidenceId: projectEvidenceIdSchema,
    status: z.enum(["adopted", "superseded"]),
    sha256: sha256Schema,
    adoptedAt: z.iso.datetime(),
  })
  .strict();

const workOutcomeDtoSchema = z
  .object({
    projectWorkOutcomeId: projectWorkOutcomeIdSchema,
    workId: projectWorkIdSchema,
    kind: z.literal("content_publication"),
    platform: z.string(),
    contentRevisionEvidenceId: projectEvidenceIdSchema,
    publicationEvidenceId: projectEvidenceIdSchema,
    externalContentId: z.string().optional(),
    url: z.url().optional(),
    publishedAt: z.iso.datetime(),
    status: z.enum(["confirmed", "withdrawn", "invalidated"]),
    verification: z.enum(["user_confirmed", "provider_verified"]),
    revision: z.number().int().positive(),
  })
  .strict();

const contextMapDtoSchema = z
  .object({
    projectContextMapId: projectContextMapIdSchema,
    methodSnapshotId: z.string(),
    selectors: z.array(
      z
        .object({
          role: z.string(),
          resourceRef: z.string(),
          required: z.boolean(),
          maxItems: z.number().int().positive(),
          maxCharacters: z.number().int().positive(),
        })
        .strict(),
    ),
    historyViews: z.array(z.string()),
    authorityPolicyVersion: z.string(),
    evidencePolicyVersion: z.string(),
    sha256: sha256Schema,
    revision: z.number().int().positive(),
  })
  .strict();

export const projectWorkspaceV3DtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_API_V3_SCHEMA_VERSION),
    project: projectSummaryV3DtoSchema,
    scopeIn: z.array(z.string()).max(30),
    scopeOut: z.array(z.string()).max(30),
    successCriteria: z.array(z.string()).min(1).max(30),
    stage: z
      .object({
        projectStageId: projectStageIdSchema,
        name: z.string().min(1).max(120),
        goal: z.string().min(1).max(4_000),
        successCriteria: z.array(z.string()).min(1).max(20),
        status: z.enum(["planned", "active", "review", "completed", "skipped"]),
        revision: z.number().int().positive(),
      })
      .strict(),
    milestones: z
      .array(
        z
          .object({
            projectMilestoneId: projectMilestoneIdSchema,
            outcome: z.string().min(1).max(4_000),
            acceptanceCriteria: z.array(z.string()).min(1).max(20),
            status: z.enum(["planned", "achieved", "cancelled"]),
            targetAt: z.iso.datetime().optional(),
            revision: z.number().int().positive(),
          })
          .strict(),
      )
      .max(100),
    latestUpdate: z
      .object({
        projectUpdateId: projectUpdateIdSchema,
        authorParticipantId: projectParticipantIdSchema,
        health: projectHealthSchema,
        narrative: z.string().min(1).max(4_000),
        observedChanges: z.array(z.string()).max(20),
        blockers: z.array(z.string()).max(20),
        nextFocus: z.array(z.string()).min(1).max(20),
        publishedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    participants: z.array(participantDtoSchema).max(100),
    resources: z
      .array(
        z
          .object({
            projectResourceId: projectResourceIdSchema,
            displayName: z.string().min(1).max(160),
            status: z.enum(["active", "unavailable"]),
            latestObservationId: projectObservationIdSchema.optional(),
            latestObservationAt: z.iso.datetime().optional(),
          })
          .strict(),
      )
      .max(100),
    works: z.array(workV3DtoSchema).max(100),
    practices: z.array(practiceRevisionDtoSchema).max(100),
    publicationOutcomes: z.array(workOutcomeDtoSchema).max(500),
    contextMap: contextMapDtoSchema.nullable(),
    decisions: z
      .array(
        z
          .object({
            projectDecisionId: projectDecisionIdSchema,
            question: z.string().min(1).max(1_000),
            choice: z.string().min(1).max(1_000),
            rationale: z.string().min(1).max(2_000),
            decidedByParticipantId: projectParticipantIdSchema,
            status: z.enum(["active", "superseded", "revoked"]),
            createdAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(100),
    contributions: z
      .array(
        z
          .object({
            projectContributionId: projectContributionIdSchema,
            participantId: projectParticipantIdSchema,
            kind: z.string().min(1).max(40),
            summary: z.string().min(1).max(2_000),
            evidenceStatus: z.enum(["reported", "verified"]),
            occurredAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

/** main@ac8f9c06公开的v2只读合同；新响应只写下方v3类型。 */
export const projectRootDtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_API_SCHEMA_VERSION),
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    displayName: z.string().min(1).max(160),
    enabledAdapters: z.array(projectResourceAdapterKindSchema).min(1).max(3),
  })
  .strict();

export const projectSummaryDtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_API_SCHEMA_VERSION),
    projectId: projectIdSchema,
    name: z.string().min(1).max(120),
    summary: z.string().min(1).max(1_000),
    goal: z.string().min(1).max(4_000),
    status: projectStatusSchema,
    methodProfileId: projectMethodProfileIdSchema,
    stageName: z.string().min(1).max(120),
    activeWorkCount: z.number().int().nonnegative(),
    openActionCount: z.number().int().nonnegative(),
    participantCount: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const workDtoSchema = z
  .object({
    projectWorkId: projectWorkIdSchema,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
    acceptanceCriteria: z.array(z.string()).min(1).max(20),
    ownerParticipantId: projectParticipantIdSchema,
    status: projectWorkStatusSchema,
    revision: z.number().int().positive(),
    actions: z.array(actionDtoSchema).max(100),
  })
  .strict();

export const projectWorkspaceDtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_API_SCHEMA_VERSION),
    project: projectSummaryDtoSchema,
    scopeIn: z.array(z.string()).max(30),
    scopeOut: z.array(z.string()).max(30),
    successCriteria: z.array(z.string()).min(1).max(30),
    stage: z
      .object({
        projectStageId: projectStageIdSchema,
        name: z.string().min(1).max(120),
        goal: z.string().min(1).max(4_000),
        successCriteria: z.array(z.string()).min(1).max(20),
        status: z.enum(["planned", "active", "review", "completed", "skipped"]),
        revision: z.number().int().positive(),
      })
      .strict(),
    milestones: z
      .array(
        z
          .object({
            projectMilestoneId: projectMilestoneIdSchema,
            outcome: z.string().min(1).max(4_000),
            acceptanceCriteria: z.array(z.string()).min(1).max(20),
            status: z.enum(["planned", "achieved", "cancelled"]),
            targetAt: z.iso.datetime().optional(),
            revision: z.number().int().positive(),
          })
          .strict(),
      )
      .max(100),
    latestUpdate: z
      .object({
        projectUpdateId: projectUpdateIdSchema,
        authorParticipantId: projectParticipantIdSchema,
        health: projectHealthSchema,
        narrative: z.string().min(1).max(4_000),
        observedChanges: z.array(z.string()).max(20),
        blockers: z.array(z.string()).max(20),
        nextFocus: z.array(z.string()).min(1).max(20),
        publishedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    participants: z.array(participantDtoSchema).max(100),
    resources: z
      .array(
        z
          .object({
            projectResourceId: projectResourceIdSchema,
            displayName: z.string().min(1).max(160),
            status: z.enum(["active", "unavailable"]),
            latestObservationId: projectObservationIdSchema.optional(),
            latestObservationAt: z.iso.datetime().optional(),
          })
          .strict(),
      )
      .max(100),
    works: z.array(workDtoSchema).max(100),
    decisions: z
      .array(
        z
          .object({
            projectDecisionId: projectDecisionIdSchema,
            question: z.string().min(1).max(1_000),
            choice: z.string().min(1).max(1_000),
            rationale: z.string().min(1).max(2_000),
            decidedByParticipantId: projectParticipantIdSchema,
            status: z.enum(["active", "superseded", "revoked"]),
            createdAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(100),
    contributions: z
      .array(
        z
          .object({
            projectContributionId: projectContributionIdSchema,
            participantId: projectParticipantIdSchema,
            kind: z.string().min(1).max(40),
            summary: z.string().min(1).max(2_000),
            evidenceStatus: z.enum(["reported", "verified"]),
            occurredAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

/** Browser/兼容审计只读入口；服务端新响应仍只写v3。 */
export const projectWorkspaceCompatibleDtoSchema = z.union([
  projectWorkspaceDtoSchema.and(
    z.object({ schemaVersion: z.literal("chat-project-api.v2") }).strict(),
  ),
  projectWorkspaceV3DtoSchema.and(
    z.object({ schemaVersion: z.literal("chat-project-api.v3") }).strict(),
  ),
]);

export const projectTimelineItemDtoSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum([
      "project_created",
      "decision",
      "contribution",
      "resource_observation",
      "action",
      "state_transition",
      "project_update",
      "project_event",
    ]),
    actorParticipantId: projectParticipantIdSchema.optional(),
    title: z.string().min(1).max(240),
    occurredAt: z.iso.datetime(),
    objectRevision: z.number().int().positive(),
  })
  .strict();

export type BeginProjectIntakePayload = z.infer<typeof beginProjectIntakePayloadSchema>;
export type BeginProjectManagementCandidatePayload = z.infer<
  typeof beginProjectManagementCandidatePayloadSchema
>;
export type BeginProjectAdvancementPayload = z.infer<typeof beginProjectAdvancementPayloadSchema>;
export type ProjectAdvancementCandidateDecisionPayload = z.infer<
  typeof projectAdvancementCandidateDecisionPayloadSchema
>;
export type ProjectCandidateDecisionPayload = z.infer<typeof projectCandidateDecisionPayloadSchema>;
export type ProjectManagementCandidateDecisionPayload = z.infer<
  typeof projectManagementCandidateDecisionPayloadSchema
>;
export type CreateProjectActionPayload = z.infer<typeof createProjectActionPayloadSchema>;
export type AssignProjectActionPayload = z.infer<typeof assignProjectActionPayloadSchema>;
export type TransitionProjectActionPayload = z.infer<typeof transitionProjectActionPayloadSchema>;
export type TransitionProjectStagePayload = z.infer<typeof transitionProjectStagePayloadSchema>;
export type TransitionProjectLifecyclePayload = z.infer<
  typeof transitionProjectLifecyclePayloadSchema
>;
export type TransitionProjectMilestonePayload = z.infer<
  typeof transitionProjectMilestonePayloadSchema
>;
export type SetProjectArchiveStatusPayload = z.infer<typeof setProjectArchiveStatusPayloadSchema>;
export type RecordProjectDecisionPayload = z.infer<typeof recordProjectDecisionPayloadSchema>;
export type RecordProjectContributionPayload = z.infer<
  typeof recordProjectContributionPayloadSchema
>;
export type ProjectRootDto = z.infer<typeof projectRootV3DtoSchema>;
export type ProjectCandidateDto = z.infer<typeof projectCandidateDtoSchema>;
export type CurrentProjectCandidateResponse = z.infer<typeof currentProjectCandidateResponseSchema>;
export type ProjectSummaryDto = z.infer<typeof projectSummaryV3DtoSchema>;
export type ProjectWorkspaceDto = z.infer<typeof projectWorkspaceV3DtoSchema>;
export type ProjectTimelineItemDto = z.infer<typeof projectTimelineItemDtoSchema>;
