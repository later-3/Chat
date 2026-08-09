import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
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
  projectObservationIdSchema,
  projectParticipantIdSchema,
  projectResourceIdSchema,
  projectStageIdSchema,
  projectWorkIdSchema,
} from "./ids.js";

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

export const projectMethodSnapshotSchema = z
  .object({
    schemaVersion: z.literal("project-method-snapshot.v1"),
    projectMethodSnapshotId: projectMethodSnapshotIdSchema,
    projectId: projectIdSchema,
    profileId: projectMethodProfileIdSchema,
    rationale: z.string().min(1).max(2_000),
    policies: projectMethodPolicySchema,
    sha256: sha256Schema,
    ...entityBase,
  })
  .strict();

export const projectStatusSchema = z.enum(["active", "archived"]);
export const projectSchema = z
  .object({
    schemaVersion: z.literal("project.v1"),
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
    schemaVersion: z.literal("project-stage.v1"),
    projectStageId: projectStageIdSchema,
    projectId: projectIdSchema,
    name: z.string().min(1).max(120),
    goal: longText,
    status: z.enum(["active", "completed", "cancelled"]),
    sequence: z.number().int().positive(),
    ...entityBase,
  })
  .strict();

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

const projectCandidateBase = {
  schemaVersion: z.literal("project-candidate.v1"),
  projectCandidateId: projectCandidateIdSchema,
  sessionId: productSessionIdSchema,
  sourceMessageId: messageIdSchema,
  requestedByPrincipalId: principalIdSchema,
  rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
  ...entityBase,
};

export const projectCandidateSchema = z.discriminatedUnion("status", [
  z.object({ ...projectCandidateBase, status: z.literal("queued") }).strict(),
  z
    .object({
      ...projectCandidateBase,
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
      ...projectCandidateBase,
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
      ...projectCandidateBase,
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

export type ProjectIntakeUnderstanding = z.infer<typeof projectIntakeUnderstandingSchema>;
export type ProjectIntakeProposal = z.infer<typeof projectIntakeProposalSchema>;
export type ProjectMethodPolicy = z.infer<typeof projectMethodPolicySchema>;
export type ProjectResourceAdapterKind = z.infer<typeof projectResourceAdapterKindSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectMethodSnapshot = z.infer<typeof projectMethodSnapshotSchema>;
export type ProjectStage = z.infer<typeof projectStageSchema>;
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
