import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  productSessionIdSchema,
  projectActionIdSchema,
  projectCandidateIdSchema,
  projectContributionIdSchema,
  projectDecisionIdSchema,
  projectIdSchema,
  projectObservationIdSchema,
  projectParticipantIdSchema,
  projectResourceIdSchema,
  projectWorkIdSchema,
} from "./ids.js";
import {
  projectActionStatusSchema,
  projectIntakeProposalSchema,
  projectManagementProposalSchema,
  projectMethodProfileIdSchema,
  projectResourceAdapterKindSchema,
  projectStatusSchema,
  projectWorkStatusSchema,
} from "./project.js";

export const PROJECT_API_SCHEMA_VERSION = "chat-project-api.v1";

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

export const projectRootDtoSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_API_SCHEMA_VERSION),
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    displayName: z.string().min(1).max(160),
    enabledAdapters: z.array(projectResourceAdapterKindSchema).min(1).max(3),
  })
  .strict();

const projectCandidateBaseDto = {
  schemaVersion: z.literal(PROJECT_API_SCHEMA_VERSION),
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
  schemaVersion: z.literal(PROJECT_API_SCHEMA_VERSION),
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

export const projectCandidateDtoSchema = z.union([
  projectIntakeCandidateDtoSchema,
  projectManagementCandidateDtoSchema,
]);

export const currentProjectCandidateResponseSchema = z
  .object({ candidate: projectCandidateDtoSchema.nullable() })
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

export const projectTimelineItemDtoSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(["project_created", "decision", "contribution", "resource_observation", "action"]),
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
export type ProjectCandidateDecisionPayload = z.infer<typeof projectCandidateDecisionPayloadSchema>;
export type ProjectManagementCandidateDecisionPayload = z.infer<
  typeof projectManagementCandidateDecisionPayloadSchema
>;
export type CreateProjectActionPayload = z.infer<typeof createProjectActionPayloadSchema>;
export type AssignProjectActionPayload = z.infer<typeof assignProjectActionPayloadSchema>;
export type TransitionProjectActionPayload = z.infer<typeof transitionProjectActionPayloadSchema>;
export type SetProjectArchiveStatusPayload = z.infer<typeof setProjectArchiveStatusPayloadSchema>;
export type RecordProjectDecisionPayload = z.infer<typeof recordProjectDecisionPayloadSchema>;
export type RecordProjectContributionPayload = z.infer<
  typeof recordProjectContributionPayloadSchema
>;
export type ProjectRootDto = z.infer<typeof projectRootDtoSchema>;
export type ProjectCandidateDto = z.infer<typeof projectCandidateDtoSchema>;
export type CurrentProjectCandidateResponse = z.infer<typeof currentProjectCandidateResponseSchema>;
export type ProjectSummaryDto = z.infer<typeof projectSummaryDtoSchema>;
export type ProjectWorkspaceDto = z.infer<typeof projectWorkspaceDtoSchema>;
export type ProjectTimelineItemDto = z.infer<typeof projectTimelineItemDtoSchema>;
