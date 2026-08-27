import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  commandIdSchema,
  projectContextMapIdSchema,
  projectDecisionIdSchema,
  projectEvidenceIdSchema,
  projectIdSchema,
  projectMethodSnapshotIdSchema,
  projectParticipantIdSchema,
  projectPracticeRevisionIdSchema,
  projectWorkBlockIdSchema,
  projectWorkClaimIdSchema,
  projectWorkHandoffIdSchema,
  projectWorkIdSchema,
  projectWorkOutcomeIdSchema,
} from "./ids.js";

const isoDateTimeSchema = z.iso.datetime();
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(4_000);
const entityBase = {
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

export const projectRecoverableWorkStateSchema = z.enum([
  "approved",
  "in_progress",
  "review",
  "selected",
  "producing",
  "experimenting",
  "needs_review",
  "ready",
]);

/** Block是可恢复事实，不把错误日志或Agent失败直接冒充Work状态。 */
export const projectWorkBlockSchema = z
  .object({
    schemaVersion: z.literal("project-work-block.v1"),
    projectWorkBlockId: projectWorkBlockIdSchema,
    projectId: projectIdSchema,
    workId: projectWorkIdSchema,
    previousState: projectRecoverableWorkStateSchema,
    reason: longText,
    stoppedAt: longText,
    recoveryConditions: z.array(shortText).min(1).max(20),
    reportedByParticipantId: projectParticipantIdSchema,
    status: z.enum(["active", "resolved"]),
    resolutionKind: z.enum(["recovered", "terminal"]).optional(),
    resolutionDecisionId: projectDecisionIdSchema.optional(),
    resolvedByParticipantId: projectParticipantIdSchema.optional(),
    resolvedEvidenceIds: z.array(projectEvidenceIdSchema).max(20),
    resolvedAt: isoDateTimeSchema.optional(),
    commandId: commandIdSchema,
    ...entityBase,
  })
  .strict()
  .superRefine((block, context) => {
    const resolved = block.status === "resolved";
    if (
      resolved !== (block.resolvedByParticipantId !== undefined) ||
      resolved !== (block.resolvedAt !== undefined) ||
      (!resolved && block.resolvedEvidenceIds.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Block解决状态、解决者、时间和Evidence不一致",
      });
    }
    if (resolved !== (block.resolutionKind !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["resolutionKind"],
        message: "Block解决状态必须记录解决类型",
      });
    }
    if (
      (block.resolutionKind === "terminal") !== (block.resolutionDecisionId !== undefined) ||
      (block.resolutionKind === "recovered" && block.resolvedEvidenceIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolutionDecisionId"],
        message: "恢复必须有Evidence；终态关闭必须绑定Decision",
      });
    }
  });

export const projectWorkClaimSchema = z
  .object({
    schemaVersion: z.literal("project-work-claim.v1"),
    projectWorkClaimId: projectWorkClaimIdSchema,
    projectId: projectIdSchema,
    workId: projectWorkIdSchema,
    participantId: projectParticipantIdSchema,
    status: z.enum(["active", "released", "expired", "revoked"]),
    acquiredAt: isoDateTimeSchema,
    leaseExpiresAt: isoDateTimeSchema,
    releasedAt: isoDateTimeSchema.optional(),
    releaseReason: z
      .enum([
        "completed_step",
        "blocked",
        "review_requested",
        "handoff",
        "lease_expired",
        "terminal_resolution",
      ])
      .optional(),
    handoffId: projectWorkHandoffIdSchema.optional(),
    commandId: commandIdSchema,
    ...entityBase,
  })
  .strict()
  .superRefine((claim, context) => {
    const active = claim.status === "active";
    if (active === (claim.releasedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["releasedAt"],
        message: "Claim终态必须记录releasedAt，活动Claim不得记录",
      });
    }
    if ((claim.releaseReason === "handoff") !== (claim.handoffId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["handoffId"],
        message: "只有handoff释放才能且必须绑定Handoff",
      });
    }
    if (!active && claim.releaseReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["releaseReason"],
        message: "Claim终态必须说明释放原因",
      });
    }
    if (
      (claim.status === "expired") !== (claim.releaseReason === "lease_expired") ||
      (claim.status === "revoked") !== (claim.releaseReason === "terminal_resolution")
    ) {
      context.addIssue({
        code: "custom",
        path: ["releaseReason"],
        message: "Claim过期或撤销状态必须使用对应释放原因",
      });
    }
  });

export const projectWorkHandoffSchema = z
  .object({
    schemaVersion: z.literal("project-work-handoff.v1"),
    projectWorkHandoffId: projectWorkHandoffIdSchema,
    projectId: projectIdSchema,
    workId: projectWorkIdSchema,
    fromClaimId: projectWorkClaimIdSchema,
    fromParticipantId: projectParticipantIdSchema,
    toParticipantId: projectParticipantIdSchema.optional(),
    completed: z.array(shortText).max(20),
    remaining: z.array(shortText).min(1).max(20),
    risks: z.array(shortText).max(20),
    nextStep: shortText,
    requiredReads: z.array(shortText).max(20),
    evidenceIds: z.array(projectEvidenceIdSchema).max(20),
    commandId: commandIdSchema,
    ...entityBase,
  })
  .strict();

/** Project Practice是项目工作方法，不是Chat Runtime Workflow Definition。 */
export const projectPracticeRevisionSchema = z
  .object({
    schemaVersion: z.literal("project-practice-revision.v1"),
    projectPracticeRevisionId: projectPracticeRevisionIdSchema,
    projectId: projectIdSchema,
    practiceKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    applicableWorkKinds: z
      .array(z.enum(["content_delivery", "workflow_improvement"]))
      .min(1)
      .max(2),
    artifactEvidenceId: projectEvidenceIdSchema,
    adoptionDecisionId: projectDecisionIdSchema,
    supersedesRevisionId: projectPracticeRevisionIdSchema.optional(),
    supersededByRevisionId: projectPracticeRevisionIdSchema.optional(),
    status: z.enum(["adopted", "superseded"]),
    sha256: sha256Schema,
    adoptedAt: isoDateTimeSchema,
    ...entityBase,
  })
  .strict()
  .superRefine((practice, context) => {
    if ((practice.status === "superseded") !== (practice.supersededByRevisionId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["supersededByRevisionId"],
        message: "Practice superseded状态必须绑定后继Revision",
      });
    }
  });

export const projectWorkOutcomeSchema = z
  .object({
    schemaVersion: z.literal("project-work-outcome.v1"),
    projectWorkOutcomeId: projectWorkOutcomeIdSchema,
    projectId: projectIdSchema,
    workId: projectWorkIdSchema,
    kind: z.literal("content_publication"),
    platform: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    contentRevisionEvidenceId: projectEvidenceIdSchema,
    publicationEvidenceId: projectEvidenceIdSchema,
    externalContentId: z.string().trim().min(1).max(240).optional(),
    url: z.url().optional(),
    publishedAt: isoDateTimeSchema,
    status: z.enum(["confirmed", "withdrawn", "invalidated"]),
    verification: z.enum(["user_confirmed", "provider_verified"]),
    decisionId: projectDecisionIdSchema,
    commandId: commandIdSchema,
    ...entityBase,
  })
  .strict();

const projectContextSelectorSchema = z
  .object({
    role: z.enum([
      "governance",
      "profile",
      "current_work",
      "practice",
      "platform",
      "series",
      "job_artifact",
      "case",
      "provider_snapshot",
    ]),
    resourceRef: z.string().trim().min(1).max(500),
    required: z.boolean(),
    maxItems: z.number().int().positive().max(100),
    maxCharacters: z.number().int().positive().max(200_000),
  })
  .strict();

export const projectContextMapSchema = z
  .object({
    schemaVersion: z.literal("project-context-map.v1"),
    projectContextMapId: projectContextMapIdSchema,
    projectId: projectIdSchema,
    methodSnapshotId: projectMethodSnapshotIdSchema,
    status: z.enum(["active", "superseded"]),
    selectors: z.array(projectContextSelectorSchema).min(3).max(50),
    historyViews: z.array(shortText).min(1).max(20),
    authorityPolicyVersion: z.literal("content-production-authority.v1"),
    evidencePolicyVersion: z.literal("content-production-evidence.v1"),
    sha256: sha256Schema,
    adoptedByDecisionId: projectDecisionIdSchema,
    ...entityBase,
  })
  .strict();

export type ProjectWorkBlock = z.infer<typeof projectWorkBlockSchema>;
export type ProjectWorkClaim = z.infer<typeof projectWorkClaimSchema>;
export type ProjectWorkHandoff = z.infer<typeof projectWorkHandoffSchema>;
export type ProjectPracticeRevision = z.infer<typeof projectPracticeRevisionSchema>;
export type ProjectWorkOutcome = z.infer<typeof projectWorkOutcomeSchema>;
export type ProjectContextMap = z.infer<typeof projectContextMapSchema>;
export type ProjectContextSelector = z.infer<typeof projectContextSelectorSchema>;
