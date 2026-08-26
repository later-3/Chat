import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  projectEvidenceIdSchema,
  projectParticipantIdSchema,
  projectPracticeRevisionIdSchema,
  projectResourceIdSchema,
  projectWorkIdSchema,
} from "./ids.js";
import { projectWorkKeySchema } from "./project.js";

const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(4_000);

export const createContentProductionProjectPayloadSchema = z
  .object({
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1_000),
    goal: longText,
    scopeIn: z.array(shortText).max(30),
    scopeOut: z.array(shortText).max(30),
    successCriteria: z.array(shortText).min(1).max(30),
  })
  .strict();

export const registerProjectAgentPayloadSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(120),
  })
  .strict();

const createProjectWorkCommon = {
  workKey: projectWorkKeySchema,
  title: z.string().trim().min(1).max(200),
  priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional(),
  objective: longText,
  acceptanceCriteria: z.array(shortText).min(1).max(20),
  ownerParticipantId: projectParticipantIdSchema,
  dependsOn: z.array(projectWorkIdSchema).max(20),
  practiceRevisionIds: z.array(projectPracticeRevisionIdSchema).max(20),
  resourceRefs: z.array(z.string().trim().min(1).max(500)).max(50),
};

export const createProjectWorkPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...createProjectWorkCommon,
      kind: z.literal("generic"),
    })
    .strict(),
  z
    .object({
      ...createProjectWorkCommon,
      kind: z.literal("content_delivery"),
      targetPlatforms: z
        .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u))
        .min(1)
        .max(10),
      sourceRef: z.string().trim().min(1).max(500),
      seriesKey: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...createProjectWorkCommon,
      kind: z.literal("workflow_improvement"),
      practiceKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
      hypothesis: longText,
    })
    .strict(),
]);

export const recordProjectEvidencePayloadSchema = z
  .object({
    workId: projectWorkIdSchema,
    workRevision: z.number().int().positive(),
    resourceId: projectResourceIdSchema.optional(),
    role: z.enum([
      "source",
      "content_revision",
      "qc_report",
      "artifact_manifest",
      "user_review",
      "publication_receipt",
      "practice_case",
      "practice_revision",
      "commit",
      "pull_request",
      "test",
      "artifact",
      "trace",
    ]),
    verification: z.enum(["reported", "observed", "verified"]),
    sourceKind: z.enum([
      "project_resource",
      "git",
      "external_url",
      "provider",
      "user_decision",
      "runtime",
    ]),
    label: z.string().trim().min(1).max(240),
    revisionRef: z.string().trim().min(1).max(240),
    uri: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .refine((value) => !value.startsWith("/") && !value.startsWith("file:"), {
        message: "Evidence URI不能暴露本机绝对路径或file URI",
      })
      .optional(),
    sha256: sha256Schema,
    observedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if ((evidence.sourceKind === "project_resource") !== (evidence.resourceId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["resourceId"],
        message: "只有project_resource Evidence才能且必须绑定Resource",
      });
    }
    if (
      evidence.verification === "verified" &&
      !(
        evidence.sourceKind === "user_decision" &&
        ["user_review", "publication_receipt"].includes(evidence.role)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message:
          "通用用户命令只能验证user_review或publication_receipt；Provider验证须走受管Adapter",
      });
    }
  });

export const claimProjectWorkPayloadSchema = z
  .object({
    participantId: projectParticipantIdSchema,
    leaseExpiresAt: z.iso.datetime(),
  })
  .strict();

export const blockProjectWorkPayloadSchema = z
  .object({
    participantId: projectParticipantIdSchema,
    reason: longText,
    stoppedAt: longText,
    recoveryConditions: z.array(shortText).min(1).max(20),
  })
  .strict();

export const resumeProjectWorkPayloadSchema = z
  .object({
    participantId: projectParticipantIdSchema,
    recoveryEvidenceIds: z.array(projectEvidenceIdSchema).min(1).max(20),
  })
  .strict();

export const requestProjectWorkReviewPayloadSchema = z
  .object({
    participantId: projectParticipantIdSchema,
    evidenceIds: z.array(projectEvidenceIdSchema).min(1).max(20),
    summary: longText,
  })
  .strict();

export const handoffProjectWorkPayloadSchema = z
  .object({
    fromParticipantId: projectParticipantIdSchema,
    toParticipantId: projectParticipantIdSchema.optional(),
    completed: z.array(shortText).max(20),
    remaining: z.array(shortText).min(1).max(20),
    risks: z.array(shortText).max(20),
    nextStep: shortText,
    requiredReads: z.array(shortText).max(20),
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
  })
  .strict();

export const decideProjectWorkTransitionPayloadSchema = z
  .object({
    decidedByParticipantId: projectParticipantIdSchema,
    targetState: z.enum([
      "approved",
      "in_progress",
      "review",
      "done",
      "cancelled",
      "selected",
      "producing",
      "experimenting",
      "ready",
      "published",
      "dropped",
      "rejected",
    ]),
    rationale: longText,
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
  })
  .strict();

export const recordContentPublicationPayloadSchema = z
  .object({
    decidedByParticipantId: projectParticipantIdSchema,
    platform: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    contentRevisionEvidenceId: projectEvidenceIdSchema,
    publicationEvidenceId: projectEvidenceIdSchema,
    externalContentId: z.string().trim().min(1).max(240).optional(),
    url: z.url().optional(),
    publishedAt: z.iso.datetime(),
    verification: z.enum(["user_confirmed", "provider_verified"]),
    rationale: longText,
  })
  .strict();

export const adoptProjectPracticePayloadSchema = z
  .object({
    decidedByParticipantId: projectParticipantIdSchema,
    title: z.string().trim().min(1).max(200),
    artifactEvidenceId: projectEvidenceIdSchema,
    applicableWorkKinds: z
      .array(z.enum(["content_delivery", "workflow_improvement"]))
      .min(1)
      .max(2),
    supersedesRevisionId: projectPracticeRevisionIdSchema.optional(),
    rationale: longText,
  })
  .strict();

export type CreateContentProductionProjectPayload = z.infer<
  typeof createContentProductionProjectPayloadSchema
>;
export type RegisterProjectAgentPayload = z.infer<typeof registerProjectAgentPayloadSchema>;
export type CreateProjectWorkPayload = z.infer<typeof createProjectWorkPayloadSchema>;
export type RecordProjectEvidencePayload = z.infer<typeof recordProjectEvidencePayloadSchema>;
export type ClaimProjectWorkPayload = z.infer<typeof claimProjectWorkPayloadSchema>;
export type BlockProjectWorkPayload = z.infer<typeof blockProjectWorkPayloadSchema>;
export type ResumeProjectWorkPayload = z.infer<typeof resumeProjectWorkPayloadSchema>;
export type RequestProjectWorkReviewPayload = z.infer<typeof requestProjectWorkReviewPayloadSchema>;
export type HandoffProjectWorkPayload = z.infer<typeof handoffProjectWorkPayloadSchema>;
export type DecideProjectWorkTransitionPayload = z.infer<
  typeof decideProjectWorkTransitionPayloadSchema
>;
export type RecordContentPublicationPayload = z.infer<typeof recordContentPublicationPayloadSchema>;
export type AdoptProjectPracticePayload = z.infer<typeof adoptProjectPracticePayloadSchema>;
