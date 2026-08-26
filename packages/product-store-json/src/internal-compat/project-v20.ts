import { z } from "zod";
import {
  sha256Schema,
  commandIdSchema,
  messageIdSchema,
  principalIdSchema,
  productSessionIdSchema,
  projectActionIdSchema,
  projectCandidateIdSchema,
  projectContributionIdSchema,
  projectDecisionIdSchema,
  projectEvidenceIdSchema,
  projectIdSchema,
  projectMethodSnapshotIdSchema,
  projectMilestoneIdSchema,
  projectObservationIdSchema,
  projectParticipantIdSchema,
  projectResourceIdSchema,
  projectStageIdSchema,
  projectStateTransitionIdSchema,
  projectUpdateIdSchema,
  projectWorkIdSchema,
} from "@chat/contracts";

const isoDateTimeSchema = z.iso.datetime();
const entityBase = {
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(4_000);

/** 模型无关的临时理解结果；只作为Candidate编译输入，不是项目事实。 */
export const projectIntakeUnderstandingSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    goal: longText,
    summary: z.string().trim().min(1).max(1_000),
    scopeHints: z.array(shortText).max(20),
    successCriteriaHints: z.array(shortText).max(20),
    initialWorkHints: z.array(shortText).min(1).max(12),
    openQuestions: z.array(shortText).max(12),
  })
  .strict();

export const projectMethodProfileIdSchema = z.enum([
  "small-project.v1",
  "software-delivery.v1",
  "lightweight.v1",
]);

export const projectMethodPolicySchema = z
  .object({
    shaping: z.boolean(),
    stagedDelivery: z.boolean(),
    boundedIteration: z.boolean(),
    evidenceRequired: z.boolean(),
  })
  .strict();

const methodDecisionRequirementSchema = z.enum(["required", "optional"]);

/**
 * Method Snapshot v2不是可解释DSL，而是Domain已编译的完整策略结果。
 * 字段只覆盖PS2真正执行的门，后续能力通过新版本演进。
 */
export const projectMethodSnapshotPoliciesSchema = z
  .object({
    stage: z
      .object({
        singleActive: z.literal(true),
        completionDecision: methodDecisionRequirementSchema,
        completionEvidence: methodDecisionRequirementSchema,
      })
      .strict(),
    iteration: z
      .object({
        enabled: z.boolean(),
        singleActive: z.literal(true),
        appetiteKind: z.enum(["timebox_days", "review_trigger"]),
        minDays: z.number().int().positive().optional(),
        maxDays: z.number().int().positive().optional(),
        circuitBreaker: z.boolean(),
      })
      .strict(),
    work: z
      .object({
        scopeEnabled: z.boolean(),
        readyGate: methodDecisionRequirementSchema,
        doneGate: methodDecisionRequirementSchema,
      })
      .strict(),
    artifact: z
      .object({
        requiredRoles: z.array(z.enum(["requirements", "architecture", "testing_strategy"])).max(3),
      })
      .strict(),
    quality: z
      .object({
        evidenceRequired: z.boolean(),
        waiverRequiresApproverAndExpiry: z.literal(true),
      })
      .strict(),
    change: z
      .object({
        stageTransitionDecision: methodDecisionRequirementSchema,
        iterationCommitmentDecision: methodDecisionRequirementSchema,
      })
      .strict(),
  })
  .strict();

export const projectMethodSnapshotSchema = z
  .object({
    schemaVersion: z.literal("project-method-snapshot.v2"),
    projectMethodSnapshotId: projectMethodSnapshotIdSchema,
    projectId: projectIdSchema,
    profileId: projectMethodProfileIdSchema,
    rationale: z.string().min(1).max(2_000),
    policies: projectMethodSnapshotPoliciesSchema,
    source: z.enum(["project_intake", "migrated_v1", "user_tailored"]),
    sha256: sha256Schema,
    ...entityBase,
  })
  .strict();

export const projectStatusSchema = z.enum(["active", "paused", "completed", "archived"]);
export const projectSchema = z
  .object({
    schemaVersion: z.literal("project.v2"),
    projectId: projectIdSchema,
    ownerPrincipalId: principalIdSchema,
    name: z.string().min(1).max(120),
    summary: z.string().min(1).max(1_000),
    goal: longText,
    scopeIn: z.array(shortText).max(30),
    scopeOut: z.array(shortText).max(30),
    successCriteria: z.array(shortText).min(1).max(30),
    status: projectStatusSchema,
    methodSnapshotId: projectMethodSnapshotIdSchema,
    currentStageId: projectStageIdSchema,
    ...entityBase,
  })
  .strict();

export const projectStageSchema = z
  .object({
    schemaVersion: z.literal("project-stage.v2"),
    projectStageId: projectStageIdSchema,
    projectId: projectIdSchema,
    methodSnapshotId: projectMethodSnapshotIdSchema,
    key: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u),
    name: z.string().min(1).max(120),
    goal: longText,
    successCriteria: z.array(shortText).min(1).max(20),
    status: z.enum(["planned", "active", "review", "completed", "skipped"]),
    sequence: z.number().int().positive(),
    startedAt: isoDateTimeSchema.optional(),
    completedAt: isoDateTimeSchema.optional(),
    completionDecisionId: projectDecisionIdSchema.optional(),
    completionEvidenceIds: z.array(projectEvidenceIdSchema).max(20),
    ...entityBase,
  })
  .strict();

export const projectMilestoneStatusSchema = z.enum(["planned", "achieved", "cancelled"]);
export const projectMilestoneSchema = z
  .object({
    schemaVersion: z.literal("project-milestone.v1"),
    projectMilestoneId: projectMilestoneIdSchema,
    projectId: projectIdSchema,
    stageId: projectStageIdSchema.optional(),
    outcome: longText,
    acceptanceCriteria: z.array(shortText).min(1).max(20),
    targetAt: isoDateTimeSchema.optional(),
    status: projectMilestoneStatusSchema,
    achievedDecisionId: projectDecisionIdSchema.optional(),
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
    ...entityBase,
  })
  .strict();

export const projectHealthSchema = z.enum(["on_track", "at_risk", "off_track", "unknown"]);
export const projectUpdateSchema = z
  .object({
    schemaVersion: z.literal("project-update.v1"),
    projectUpdateId: projectUpdateIdSchema,
    projectId: projectIdSchema,
    stageId: projectStageIdSchema,
    authorParticipantId: projectParticipantIdSchema,
    confirmedByPrincipalId: principalIdSchema,
    health: projectHealthSchema,
    narrative: longText,
    observedChanges: z.array(shortText).max(20),
    blockers: z.array(shortText).max(20),
    nextFocus: z.array(shortText).min(1).max(20),
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
    boundProjectRevision: z.number().int().positive(),
    boundStageRevision: z.number().int().positive(),
    publishedAt: isoDateTimeSchema,
    supersedesUpdateId: projectUpdateIdSchema.optional(),
    commandId: commandIdSchema,
    ...entityBase,
  })
  .strict();

const projectTransitionCommon = {
  schemaVersion: z.literal("project-state-transition.v1"),
  projectStateTransitionId: projectStateTransitionIdSchema,
  projectId: projectIdSchema,
  actorParticipantId: projectParticipantIdSchema,
  commandId: commandIdSchema,
  beforeRevision: z.number().int().positive(),
  afterRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
  decisionId: projectDecisionIdSchema,
  evidenceIds: z.array(projectEvidenceIdSchema).max(20),
  occurredAt: isoDateTimeSchema,
  ...entityBase,
};

/** 严格状态历史只记录转换，不复制Stage/Update正文，也不承担Activity职责。 */
export const projectStateTransitionSchema = z.discriminatedUnion("objectType", [
  z
    .object({
      ...projectTransitionCommon,
      objectType: z.literal("project"),
      objectId: projectIdSchema,
      from: projectStatusSchema,
      to: projectStatusSchema,
    })
    .strict(),
  z
    .object({
      ...projectTransitionCommon,
      objectType: z.literal("stage"),
      objectId: projectStageIdSchema,
      from: z.enum(["planned", "active", "review", "completed", "skipped"]),
      to: z.enum(["planned", "active", "review", "completed", "skipped"]),
    })
    .strict(),
  z
    .object({
      ...projectTransitionCommon,
      objectType: z.literal("milestone"),
      objectId: projectMilestoneIdSchema,
      from: projectMilestoneStatusSchema,
      to: projectMilestoneStatusSchema,
    })
    .strict(),
]);

export const projectResourceAdapterKindSchema = z.enum([
  "local-git-workspace.v1",
  "project-document-manifest.v1",
  "package-script-catalog.v1",
]);

export const projectResourceSchema = z
  .object({
    schemaVersion: z.literal("project-resource.v1"),
    projectResourceId: projectResourceIdSchema,
    projectId: projectIdSchema,
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    displayName: z.string().min(1).max(160),
    kind: z.literal("workspace"),
    enabledAdapters: z.array(projectResourceAdapterKindSchema).min(1).max(3),
    status: z.enum(["active", "unavailable"]),
    ...entityBase,
  })
  .strict();

export const projectParticipantSchema = z
  .object({
    schemaVersion: z.literal("project-participant.v1"),
    projectParticipantId: projectParticipantIdSchema,
    projectId: projectIdSchema,
    kind: z.enum(["human", "agent", "automation", "external"]),
    principalId: principalIdSchema.optional(),
    displayName: z.string().min(1).max(120),
    role: z.string().min(1).max(120),
    status: z.enum(["active", "inactive"]),
    ...entityBase,
  })
  .strict();

export const projectWorkStatusSchema = z.enum([
  "draft",
  "approved",
  "in_progress",
  "review",
  "done",
  "cancelled",
]);
export const projectWorkSchema = z
  .object({
    schemaVersion: z.literal("project-work.v1"),
    projectWorkId: projectWorkIdSchema,
    projectId: projectIdSchema,
    stageId: projectStageIdSchema,
    title: z.string().min(1).max(200),
    objective: longText,
    acceptanceCriteria: z.array(shortText).min(1).max(20),
    dependsOn: z.array(projectWorkIdSchema).max(20),
    ownerParticipantId: projectParticipantIdSchema,
    status: projectWorkStatusSchema,
    ...entityBase,
  })
  .strict();

export const projectActionStatusSchema = z.enum(["todo", "doing", "blocked", "done", "cancelled"]);
export const projectActionSchema = z
  .object({
    schemaVersion: z.literal("project-action.v1"),
    projectActionId: projectActionIdSchema,
    projectId: projectIdSchema,
    workId: projectWorkIdSchema,
    title: z.string().min(1).max(240),
    ownerParticipantId: projectParticipantIdSchema,
    status: projectActionStatusSchema,
    blockedReason: z.string().min(1).max(500).optional(),
    dueAt: isoDateTimeSchema.optional(),
    completedEvidenceIds: z.array(projectEvidenceIdSchema).max(20),
    ...entityBase,
  })
  .strict();

export const projectEvidenceSchema = z
  .object({
    schemaVersion: z.literal("project-evidence.v1"),
    projectEvidenceId: projectEvidenceIdSchema,
    projectId: projectIdSchema,
    resourceId: projectResourceIdSchema.optional(),
    kind: z.enum(["resource_observation", "commit", "pull_request", "test", "artifact", "trace"]),
    label: z.string().min(1).max(240),
    revisionRef: z.string().min(1).max(240),
    sha256: sha256Schema,
    observedAt: isoDateTimeSchema,
    ...entityBase,
  })
  .strict();

export const projectContributionSchema = z
  .object({
    schemaVersion: z.literal("project-contribution.v1"),
    projectContributionId: projectContributionIdSchema,
    projectId: projectIdSchema,
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
    summary: z.string().min(1).max(2_000),
    evidenceStatus: z.enum(["reported", "verified"]),
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
    occurredAt: isoDateTimeSchema,
    ...entityBase,
  })
  .strict();

export const projectDecisionSchema = z
  .object({
    schemaVersion: z.literal("project-decision.v1"),
    projectDecisionId: projectDecisionIdSchema,
    projectId: projectIdSchema,
    question: z.string().min(1).max(1_000),
    options: z.array(z.string().min(1).max(1_000)).min(1).max(12),
    choice: z.string().min(1).max(1_000),
    rationale: z.string().min(1).max(2_000),
    decidedByParticipantId: projectParticipantIdSchema,
    boundProjectRevision: z.number().int().positive(),
    status: z.enum(["active", "superseded", "revoked"]),
    supersededByDecisionId: projectDecisionIdSchema.optional(),
    commandId: commandIdSchema,
    ...entityBase,
  })
  .strict();

export const projectObservationDataSchema = z
  .object({
    git: z
      .object({
        headSha: z.string().regex(/^[0-9a-f]{40}$/u),
        branch: z.string().min(1).max(240),
        dirty: z.boolean(),
        trackedFileCount: z.number().int().nonnegative(),
        recentCommitCount: z.number().int().nonnegative(),
      })
      .strict(),
    documents: z
      .array(
        z
          .object({
            relativePath: z.string().min(1).max(500),
            sha256: sha256Schema,
            sizeBytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(100),
    scripts: z
      .array(
        z
          .object({ name: z.string().min(1).max(120), command: z.string().min(1).max(500) })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const projectObservationSchema = z
  .object({
    schemaVersion: z.literal("project-observation.v1"),
    projectObservationId: projectObservationIdSchema,
    projectId: projectIdSchema,
    resourceId: projectResourceIdSchema,
    previousObservationId: projectObservationIdSchema.optional(),
    adapterKinds: z.array(projectResourceAdapterKindSchema).min(1).max(3),
    data: projectObservationDataSchema,
    sha256: sha256Schema,
    observedAt: isoDateTimeSchema,
    ...entityBase,
  })
  .strict();

export const projectIntakeProposalSchema = z
  .object({
    name: z.string().min(1).max(120),
    summary: z.string().min(1).max(1_000),
    goal: longText,
    scopeIn: z.array(shortText).max(30),
    scopeOut: z.array(shortText).max(30),
    successCriteria: z.array(shortText).min(1).max(30),
    method: z
      .object({
        profileId: projectMethodProfileIdSchema,
        rationale: z.string().min(1).max(2_000),
        policies: projectMethodPolicySchema,
      })
      .strict(),
    initialStage: z.object({ name: z.string().min(1).max(120), goal: longText }).strict(),
    initialWork: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            objective: longText,
            acceptanceCriteria: z.array(shortText).min(1).max(20),
            firstAction: z.string().min(1).max(240),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

/**
 * PS2.1真实模型只负责理解用户想表达的阶段、关键结果和负责人更新。
 * 这里不含产品ID/revision，Application会结合当前权威事实编译Candidate。
 */
export const projectAdvancementUnderstandingSchema = z
  .object({
    stage: z
      .object({
        name: z.string().trim().min(1).max(120),
        goal: longText,
        successCriteria: z.array(shortText).min(1).max(20),
      })
      .strict(),
    milestones: z
      .array(
        z
          .object({
            outcome: longText,
            acceptanceCriteria: z.array(shortText).min(1).max(20),
            targetAt: isoDateTimeSchema.optional(),
          })
          .strict(),
      )
      .max(8),
    update: z
      .object({
        health: projectHealthSchema,
        narrative: longText,
        observedChanges: z.array(shortText).max(20),
        blockers: z.array(shortText).max(20),
        nextFocus: z.array(shortText).min(1).max(20),
      })
      .strict(),
  })
  .strict();

export const projectAdvancementProposalSchema = z
  .object({
    stage: z
      .object({
        name: z.string().trim().min(1).max(120),
        goal: longText,
        successCriteria: z.array(shortText).min(1).max(20),
      })
      .strict(),
    milestones: z
      .array(
        z
          .object({
            outcome: longText,
            acceptanceCriteria: z.array(shortText).min(1).max(20),
            targetAt: isoDateTimeSchema.optional(),
          })
          .strict(),
      )
      .max(8),
    update: z
      .object({
        authorParticipantId: projectParticipantIdSchema,
        health: projectHealthSchema,
        narrative: longText,
        observedChanges: z.array(shortText).max(20),
        blockers: z.array(shortText).max(20),
        nextFocus: z.array(shortText).min(1).max(20),
        evidenceIds: z.array(projectEvidenceIdSchema).max(20),
      })
      .strict(),
  })
  .strict();

const projectCandidateCommon = {
  schemaVersion: z.literal("project-candidate.v1"),
  projectCandidateId: projectCandidateIdSchema,
  sessionId: productSessionIdSchema,
  sourceMessageId: messageIdSchema,
  requestedByPrincipalId: principalIdSchema,
  ...entityBase,
};

const projectIntakeCandidateBase = {
  ...projectCandidateCommon,
  candidateKind: z.literal("intake"),
  rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
};

const projectIntakeCandidateSchema = z.discriminatedUnion("status", [
  z.object({ ...projectIntakeCandidateBase, status: z.literal("queued") }).strict(),
  z
    .object({
      ...projectIntakeCandidateBase,
      status: z.literal("failed"),
      failureCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
        .max(64),
      failedByCommandId: commandIdSchema,
    })
    .strict(),
  z
    .object({
      ...projectIntakeCandidateBase,
      status: z.literal("under_review"),
      understanding: projectIntakeUnderstandingSchema,
      proposal: projectIntakeProposalSchema,
      resourceDisplayName: z.string().min(1).max(160),
      enabledAdapters: z.array(projectResourceAdapterKindSchema).min(1).max(3),
      observationData: projectObservationDataSchema,
      observationSha256: sha256Schema,
      candidateSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...projectIntakeCandidateBase,
      status: z.literal("confirmed"),
      understanding: projectIntakeUnderstandingSchema,
      proposal: projectIntakeProposalSchema,
      resourceDisplayName: z.string().min(1).max(160),
      enabledAdapters: z.array(projectResourceAdapterKindSchema).min(1).max(3),
      observationData: projectObservationDataSchema,
      observationSha256: sha256Schema,
      candidateSha256: sha256Schema,
      confirmedProjectId: projectIdSchema,
      decidedByCommandId: commandIdSchema,
    })
    .strict(),
  z
    .object({
      ...projectIntakeCandidateBase,
      status: z.literal("rejected"),
      understanding: projectIntakeUnderstandingSchema.optional(),
      proposal: projectIntakeProposalSchema.optional(),
      resourceDisplayName: z.string().min(1).max(160).optional(),
      enabledAdapters: z.array(projectResourceAdapterKindSchema).min(1).max(3).optional(),
      observationData: projectObservationDataSchema.optional(),
      observationSha256: sha256Schema.optional(),
      candidateSha256: sha256Schema.optional(),
      rejectionReason: z.string().min(1).max(2_000).optional(),
      decidedByCommandId: commandIdSchema,
    })
    .strict(),
]);

export const projectManagementProposalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("action"),
      workId: projectWorkIdSchema,
      title: z.string().trim().min(1).max(240),
      ownerParticipantId: projectParticipantIdSchema,
      dueAt: isoDateTimeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision"),
      question: z.string().trim().min(1).max(1_000),
      options: z.array(z.string().trim().min(1).max(1_000)).min(1).max(12),
      choice: z.string().trim().min(1).max(1_000),
      rationale: z.string().trim().min(1).max(2_000),
      decidedByParticipantId: projectParticipantIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("contribution"),
      participantId: projectParticipantIdSchema,
      workId: projectWorkIdSchema.optional(),
      actionId: projectActionIdSchema.optional(),
      contributionKind: z.enum([
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
      evidenceIds: z.array(projectEvidenceIdSchema).max(20),
      occurredAt: isoDateTimeSchema,
    })
    .strict(),
]);

const projectManagementCandidateBase = {
  ...projectCandidateCommon,
  candidateKind: z.literal("management"),
  projectId: projectIdSchema,
  boundProjectRevision: z.number().int().positive(),
  proposal: projectManagementProposalSchema,
  candidateSha256: sha256Schema,
};

const projectManagementCandidateSchema = z.discriminatedUnion("status", [
  z.object({ ...projectManagementCandidateBase, status: z.literal("under_review") }).strict(),
  z
    .object({
      ...projectManagementCandidateBase,
      status: z.literal("confirmed"),
      committedObjectId: z.string().regex(/^(pac|pdc|pct)_[A-Za-z0-9]+$/u),
      decidedByCommandId: commandIdSchema,
    })
    .strict(),
  z
    .object({
      ...projectManagementCandidateBase,
      status: z.literal("rejected"),
      rejectionReason: z.string().min(1).max(2_000).optional(),
      decidedByCommandId: commandIdSchema,
    })
    .strict(),
]);

const projectAdvancementCandidateBase = {
  ...projectCandidateCommon,
  candidateKind: z.literal("advancement"),
  projectId: projectIdSchema,
  boundProjectRevision: z.number().int().positive(),
  boundStageId: projectStageIdSchema,
  boundStageRevision: z.number().int().positive(),
  boundMethodSnapshotId: projectMethodSnapshotIdSchema,
  boundMethodSha256: sha256Schema,
};

const projectAdvancementCandidateSchema = z.discriminatedUnion("status", [
  z.object({ ...projectAdvancementCandidateBase, status: z.literal("queued") }).strict(),
  z
    .object({
      ...projectAdvancementCandidateBase,
      status: z.literal("failed"),
      failureCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
        .max(64),
      failedByCommandId: commandIdSchema,
    })
    .strict(),
  z
    .object({
      ...projectAdvancementCandidateBase,
      status: z.literal("under_review"),
      understanding: projectAdvancementUnderstandingSchema,
      proposal: projectAdvancementProposalSchema,
      candidateSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...projectAdvancementCandidateBase,
      status: z.literal("confirmed"),
      understanding: projectAdvancementUnderstandingSchema,
      proposal: projectAdvancementProposalSchema,
      candidateSha256: sha256Schema,
      committedStageId: projectStageIdSchema,
      committedMilestoneIds: z.array(projectMilestoneIdSchema).max(8),
      committedUpdateId: projectUpdateIdSchema,
      decidedByCommandId: commandIdSchema,
    })
    .strict(),
  z
    .object({
      ...projectAdvancementCandidateBase,
      status: z.literal("rejected"),
      understanding: projectAdvancementUnderstandingSchema,
      proposal: projectAdvancementProposalSchema,
      candidateSha256: sha256Schema,
      rejectionReason: z.string().trim().min(1).max(2_000).optional(),
      decidedByCommandId: commandIdSchema,
    })
    .strict(),
]);

export const projectCandidateSchema = z.union([
  projectIntakeCandidateSchema,
  projectManagementCandidateSchema,
  projectAdvancementCandidateSchema,
]);

export type ProjectIntakeUnderstanding = z.infer<typeof projectIntakeUnderstandingSchema>;
export type ProjectIntakeProposal = z.infer<typeof projectIntakeProposalSchema>;
export type ProjectManagementProposal = z.infer<typeof projectManagementProposalSchema>;
export type ProjectMethodPolicy = z.infer<typeof projectMethodPolicySchema>;
export type ProjectMethodSnapshotPolicies = z.infer<typeof projectMethodSnapshotPoliciesSchema>;
export type ProjectResourceAdapterKind = z.infer<typeof projectResourceAdapterKindSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectMethodSnapshot = z.infer<typeof projectMethodSnapshotSchema>;
export type ProjectStage = z.infer<typeof projectStageSchema>;
export type ProjectMilestone = z.infer<typeof projectMilestoneSchema>;
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;
export type ProjectStateTransition = z.infer<typeof projectStateTransitionSchema>;
export type ProjectAdvancementUnderstanding = z.infer<typeof projectAdvancementUnderstandingSchema>;
export type ProjectAdvancementProposal = z.infer<typeof projectAdvancementProposalSchema>;
export type ProjectResource = z.infer<typeof projectResourceSchema>;
export type ProjectParticipant = z.infer<typeof projectParticipantSchema>;
export type ProjectWork = z.infer<typeof projectWorkSchema>;
export type ProjectAction = z.infer<typeof projectActionSchema>;
export type ProjectContribution = z.infer<typeof projectContributionSchema>;
export type ProjectEvidence = z.infer<typeof projectEvidenceSchema>;
export type ProjectDecision = z.infer<typeof projectDecisionSchema>;
export type ProjectObservation = z.infer<typeof projectObservationSchema>;
export type ProjectCandidate = z.infer<typeof projectCandidateSchema>;
export type ProjectObservationData = z.infer<typeof projectObservationDataSchema>;
