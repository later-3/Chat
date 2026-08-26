import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  commandIdSchema,
  projectCoordinationOperationIdSchema,
  projectDecisionIdSchema,
  projectEvidenceIdSchema,
  projectIdSchema,
  projectInboundChangeIdSchema,
  projectParticipantIdSchema,
  projectProviderBindingIdSchema,
  projectProviderProjectionIdSchema,
  projectWorkIdSchema,
  principalIdSchema,
} from "./ids.js";
import {
  planeCeProjectIdSchema,
  planeCeProjectIdentifierSchema,
  planeCeWorkspaceSlugSchema,
} from "./project-bootstrap.js";
import { projectWorkKeySchema } from "./project.js";
import { promptWorkspaceRootIdSchema } from "./prompt-fragment.js";

export const PLANE_PROJECT_COORDINATION_SCHEMA_VERSION = "plane-project-coordination.v2";

const isoDateTimeSchema = z.iso.datetime();
const readableTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), {
    message: "Plane协作文本只能包含可读字符",
  });

export const planeProjectKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);
export const planeExternalSourceSchema = z.literal("later-agent");
export const planeLogicalExternalIdSchema = projectWorkKeySchema;
export const planeTaskKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u);
export const planeProviderExternalIdSchema = z
  .string()
  .trim()
  .regex(/^chat-work:[a-z0-9][a-z0-9-]{0,79}:[a-z0-9][a-z0-9:._-]{0,179}$/u)
  .max(255);
export const planeCommentExternalIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
export const planeWorkItemIdSchema = z.uuid();
export const planeCommentIdSchema = z.uuid();
export const planeStateIdSchema = z.uuid();
export const planeWorkItemPrioritySchema = z.enum(["none", "urgent", "high", "medium", "low"]);
export const planeStateGroupSchema = z.enum([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
]);

const forbiddenAgentStateNames = new Set([
  "done",
  "completed",
  "complete",
  "closed",
  "cancelled",
  "canceled",
  "published",
  "adopted",
  "dropped",
  "rejected",
  "ready",
  "完成",
  "已完成",
  "关闭",
  "已关闭",
  "取消",
  "已取消",
  "已发布",
  "已采用",
]);

/** Agent出站只允许非终态；终态必须先由Chat Decision/Evidence成立。 */
export const planeAgentWritableStateNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !forbiddenAgentStateNames.has(value.toLocaleLowerCase("en-US")), {
    message: "Agent不能把Plane投影直接推进到终态",
  });

const intentIdentity = {
  externalSource: planeExternalSourceSchema,
  /** 公开API沿用externalId字段，但语义是Chat Work Key，不是Plane external_id。 */
  externalId: planeLogicalExternalIdSchema,
  taskKey: planeTaskKeySchema,
};

const planeBranchSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u);
const gitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const reportedTestSummarySchema = readableTextSchema;
const projectEvidenceIdsSchema = z.array(projectEvidenceIdSchema).max(20);

export const ensurePlaneWorkItemIntentSchema = z
  .object({
    kind: z.literal("ensure_work_item"),
    ...intentIdentity,
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().min(1).max(10_000),
    priority: planeWorkItemPrioritySchema,
    stateName: planeAgentWritableStateNameSchema,
    stateGroup: z.enum(["backlog", "unstarted", "started"]),
    moduleIds: z.array(z.uuid()).max(20).default([]),
    labelIds: z.array(z.uuid()).max(100).default([]),
  })
  .strict();

export const startPlaneWorkItemIntentSchema = z
  .object({
    kind: z.literal("start"),
    ...intentIdentity,
    planeWorkItemId: planeWorkItemIdSchema,
    expectedPlaneStateId: planeStateIdSchema,
    stateName: planeAgentWritableStateNameSchema,
    stateGroup: z.literal("started"),
    branch: planeBranchSchema,
    labelIds: z.array(z.uuid()).max(100).default([]),
    managedLabelIds: z.array(z.uuid()).max(200).default([]),
  })
  .strict();

export const blockPlaneWorkItemIntentSchema = z
  .object({
    kind: z.literal("block"),
    ...intentIdentity,
    planeWorkItemId: planeWorkItemIdSchema,
    expectedPlaneStateId: planeStateIdSchema,
    stateName: z.literal("Blocked"),
    stateGroup: z.literal("started"),
    commentExternalId: planeCommentExternalIdSchema,
    message: readableTextSchema,
    branch: planeBranchSchema,
    evidenceIds: projectEvidenceIdsSchema.default([]),
  })
  .strict();

export const requestPlaneWorkItemReviewIntentSchema = z
  .object({
    kind: z.literal("request_review"),
    ...intentIdentity,
    planeWorkItemId: planeWorkItemIdSchema,
    expectedPlaneStateId: planeStateIdSchema,
    stateName: z.literal("Needs Review"),
    stateGroup: z.literal("started"),
    commentExternalId: planeCommentExternalIdSchema,
    message: readableTextSchema,
    branch: planeBranchSchema,
    commitSha: gitCommitShaSchema.optional(),
    testSummary: reportedTestSummarySchema.optional(),
    evidenceIds: projectEvidenceIdsSchema.default([]),
  })
  .strict();

export const recordPlaneWorkItemProgressIntentSchema = z
  .object({
    kind: z.literal("progress"),
    ...intentIdentity,
    planeWorkItemId: planeWorkItemIdSchema,
    commentExternalId: planeCommentExternalIdSchema,
    message: readableTextSchema,
    branch: planeBranchSchema,
    commitSha: gitCommitShaSchema.optional(),
    testSummary: reportedTestSummarySchema.optional(),
    evidenceIds: projectEvidenceIdsSchema.default([]),
  })
  .strict();

export const recordPlaneWorkItemEvidenceIntentSchema = z
  .object({
    kind: z.literal("evidence"),
    ...intentIdentity,
    planeWorkItemId: planeWorkItemIdSchema,
    commentExternalId: planeCommentExternalIdSchema,
    message: readableTextSchema,
    branch: planeBranchSchema,
    commitSha: gitCommitShaSchema.optional(),
    testSummary: reportedTestSummarySchema.optional(),
    evidenceIds: projectEvidenceIdsSchema.min(1),
  })
  .strict();

export const planeProjectOperationIntentSchema = z.discriminatedUnion("kind", [
  ensurePlaneWorkItemIntentSchema,
  startPlaneWorkItemIntentSchema,
  blockPlaneWorkItemIntentSchema,
  requestPlaneWorkItemReviewIntentSchema,
  recordPlaneWorkItemProgressIntentSchema,
  recordPlaneWorkItemEvidenceIntentSchema,
]);

/** Comment external identity由Application在Operation ID分配后派生。 */
export const planeProjectOperationInputIntentSchema = z.discriminatedUnion("kind", [
  ensurePlaneWorkItemIntentSchema.omit({ moduleIds: true, labelIds: true }),
  startPlaneWorkItemIntentSchema.omit({ labelIds: true, managedLabelIds: true }),
  blockPlaneWorkItemIntentSchema.omit({ commentExternalId: true }),
  requestPlaneWorkItemReviewIntentSchema.omit({ commentExternalId: true }),
  recordPlaneWorkItemProgressIntentSchema.omit({ commentExternalId: true }),
  recordPlaneWorkItemEvidenceIntentSchema.omit({ commentExternalId: true }),
]);

export const planeProjectAgentOperationIntentSchema = z.discriminatedUnion("kind", [
  startPlaneWorkItemIntentSchema.omit({
    externalSource: true,
    externalId: true,
    taskKey: true,
    labelIds: true,
    managedLabelIds: true,
  }),
  blockPlaneWorkItemIntentSchema.omit({
    externalSource: true,
    externalId: true,
    taskKey: true,
    commentExternalId: true,
  }),
  requestPlaneWorkItemReviewIntentSchema.omit({
    externalSource: true,
    externalId: true,
    taskKey: true,
    commentExternalId: true,
  }),
  recordPlaneWorkItemProgressIntentSchema.omit({
    externalSource: true,
    externalId: true,
    taskKey: true,
    commentExternalId: true,
  }),
]);

export const planeProjectOperationKindSchema = z.enum([
  "ensure_work_item",
  "start",
  "block",
  "request_review",
  "progress",
  "evidence",
]);
export const planeProjectOperationStatusSchema = z.enum([
  "queued",
  "dispatching",
  "completed",
  "failed",
  "needs_attention",
  "outcome_unknown",
]);

const operationErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u);
export const planeProjectOperationManualDispositionKindSchema = z.literal("confirmed_absent");
export const planeProjectOperationManualDispositionReasonSchema = z
  .string()
  .trim()
  .min(10)
  .max(2_000)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), {
    message: "Plane人工处置原因只能包含可读字符",
  });
export const planeProjectOperationManualDispositionSchema = z
  .object({
    disposition: planeProjectOperationManualDispositionKindSchema,
    actorPrincipalId: principalIdSchema,
    disposedAt: isoDateTimeSchema,
    reason: planeProjectOperationManualDispositionReasonSchema,
  })
  .strict();

/**
 * Operation属于Chat项目管理内核。Plane字段只记录Provider Receipt；
 * Work、Binding和Projection身份都绑定到精确Chat revision。
 */
export const planeProjectOperationSchema = z
  .object({
    schemaVersion: z.literal(PLANE_PROJECT_COORDINATION_SCHEMA_VERSION),
    planeProjectOperationId: projectCoordinationOperationIdSchema,
    planeProjectBindingId: projectProviderBindingIdSchema,
    projectId: projectIdSchema,
    projectWorkId: projectWorkIdSchema,
    boundWorkRevision: z.number().int().positive(),
    projectProviderProjectionId: projectProviderProjectionIdSchema.optional(),
    ownerPrincipalId: principalIdSchema,
    actorParticipantId: projectParticipantIdSchema,
    kind: planeProjectOperationKindSchema,
    intent: planeProjectOperationIntentSchema,
    providerExternalId: planeProviderExternalIdSchema,
    requestSha256: sha256Schema,
    status: planeProjectOperationStatusSchema,
    planeWorkItemId: planeWorkItemIdSchema.optional(),
    planeCommentId: planeCommentIdSchema.optional(),
    providerFingerprint: sha256Schema.optional(),
    errorCode: operationErrorCodeSchema.optional(),
    manualDisposition: planeProjectOperationManualDispositionSchema.optional(),
    revision: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.kind !== operation.intent.kind) {
      context.addIssue({
        code: "custom",
        path: ["intent", "kind"],
        message: "Operation kind必须与Intent kind一致",
      });
    }
    const errorStatus = ["failed", "needs_attention", "outcome_unknown"].includes(operation.status);
    if (errorStatus !== (operation.errorCode !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "失败、冲突或结果未知必须携带errorCode",
      });
    }
    if (
      operation.status === "completed" &&
      (operation.planeWorkItemId === undefined || operation.providerFingerprint === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["planeWorkItemId"],
        message: "完成Operation必须记录Work Item和Provider Fingerprint",
      });
    }
    const commentKind = ["block", "request_review", "progress", "evidence"].includes(
      operation.kind,
    );
    if (operation.planeCommentId !== undefined && !commentKind) {
      context.addIssue({
        code: "custom",
        path: ["planeCommentId"],
        message: "非评论Operation不能记录Comment",
      });
    }
    if (operation.status === "completed" && commentKind && operation.planeCommentId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["planeCommentId"],
        message: "完成的评论Operation必须记录Comment",
      });
    }
    if (operation.manualDisposition !== undefined) {
      if (
        operation.status !== "failed" ||
        operation.errorCode !== "plane_operation_manual_confirmed_absent" ||
        operation.manualDisposition.actorPrincipalId !== operation.ownerPrincipalId ||
        operation.manualDisposition.disposedAt !== operation.updatedAt ||
        operation.planeCommentId !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["manualDisposition"],
          message: "人工确认未发生必须由Owner无Comment地关闭未决Operation",
        });
      }
    }
  });

/** 对外Binding DTO保持现有Skill字段，但底层唯一事实是ProjectProviderBinding。 */
export const planeProjectBindingSchema = z
  .object({
    schemaVersion: z.literal(PLANE_PROJECT_COORDINATION_SCHEMA_VERSION),
    planeProjectBindingId: projectProviderBindingIdSchema,
    projectId: projectIdSchema,
    ownerPrincipalId: principalIdSchema,
    projectKey: planeProjectKeySchema,
    workspaceRootId: promptWorkspaceRootIdSchema.optional(),
    coordinationAgentParticipantId: projectParticipantIdSchema.optional(),
    humanActorExternalIds: z.array(z.string().trim().min(1).max(200)).max(20),
    providerKind: z.literal("plane_ce"),
    providerVersion: z.string().trim().min(1).max(80),
    planeWorkspaceSlug: planeCeWorkspaceSlugSchema,
    planeProjectId: planeCeProjectIdSchema,
    planeProjectIdentifier: planeCeProjectIdentifierSchema,
    status: z.enum(["active", "needs_attention", "archived"]),
    revision: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.status === "active" && binding.workspaceRootId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workspaceRootId"],
        message: "活动Plane Binding必须公开Workspace Root",
      });
    }
  });

export const planeProjectStateSnapshotSchema = z
  .object({
    planeStateId: planeStateIdSchema,
    name: z.string().trim().min(1).max(100),
    group: planeStateGroupSchema,
  })
  .strict();

export const planeProjectModuleSnapshotSchema = z
  .object({
    planeModuleId: z.uuid(),
    name: z.string().trim().min(1).max(255),
    status: z.enum(["backlog", "planned", "in-progress", "paused", "completed", "cancelled"]),
    totalWorkItems: z.number().int().nonnegative(),
    completedWorkItems: z.number().int().nonnegative(),
    cancelledWorkItems: z.number().int().nonnegative(),
    startedWorkItems: z.number().int().nonnegative(),
    unstartedWorkItems: z.number().int().nonnegative(),
    backlogWorkItems: z.number().int().nonnegative(),
  })
  .strict();

export const planeProjectLabelSnapshotSchema = z
  .object({
    planeLabelId: z.uuid(),
    name: z.string().trim().min(1).max(255),
    color: z.string().trim().min(1).max(255),
  })
  .strict();

export const planeProjectWorkItemSnapshotSchema = z
  .object({
    planeWorkItemId: planeWorkItemIdSchema,
    sequenceId: z.number().int().positive(),
    projectWorkId: projectWorkIdSchema.optional(),
    workRevision: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(255),
    description: z.string().max(10_000).optional(),
    priority: planeWorkItemPrioritySchema,
    moduleIds: z.array(z.uuid()).max(20),
    labelIds: z.array(z.uuid()).max(100),
    state: planeProjectStateSnapshotSchema,
    externalSource: z.string().trim().min(1).max(100).optional(),
    externalId: z.string().trim().min(1).max(200).optional(),
    providerFingerprint: sha256Schema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

/** Plane评论属于Provider输入；这里只公开有界纯文本摘要，不把HTML作为Agent指令。 */
export const planeWorkItemCommentSummarySchema = z
  .object({
    planeCommentId: planeCommentIdSchema,
    planeWorkItemId: planeWorkItemIdSchema,
    excerpt: z.string().max(500),
    origin: z.enum(["later_agent", "human_or_other"]),
    actorExternalId: z.string().trim().min(1).max(200).optional(),
    externalId: z.string().trim().min(1).max(200).optional(),
    createdAt: isoDateTimeSchema.optional(),
    updatedAt: isoDateTimeSchema.optional(),
  })
  .strict();

export const planeWorkItemCommentsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PLANE_PROJECT_COORDINATION_SCHEMA_VERSION),
    planeProjectBindingId: projectProviderBindingIdSchema,
    planeWorkItemId: planeWorkItemIdSchema,
    comments: z.array(planeWorkItemCommentSummarySchema).max(100),
    totalCommentCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    capturedAt: isoDateTimeSchema,
  })
  .strict();

export const planeProjectSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PLANE_PROJECT_COORDINATION_SCHEMA_VERSION),
    planeProjectBindingId: projectProviderBindingIdSchema,
    bindingRevision: z.number().int().positive(),
    projectId: projectIdSchema,
    projectKey: planeProjectKeySchema,
    workspaceRootId: promptWorkspaceRootIdSchema,
    planeWorkspaceSlug: planeCeWorkspaceSlugSchema,
    project: z
      .object({
        planeProjectId: planeCeProjectIdSchema,
        identifier: planeCeProjectIdentifierSchema,
        name: z.string().trim().min(1).max(255),
      })
      .strict(),
    states: z.array(planeProjectStateSnapshotSchema).max(100),
    modules: z.array(planeProjectModuleSnapshotSchema).max(100),
    labels: z.array(planeProjectLabelSnapshotSchema).max(500),
    workItems: z.array(planeProjectWorkItemSnapshotSchema).max(500),
    totalWorkItemCount: z.number().int().nonnegative(),
    unresolvedOperationCount: z.number().int().nonnegative(),
    pendingInboundChangeCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    capturedAt: isoDateTimeSchema,
  })
  .strict();

export const projectInboundChangeClassificationSchema = z.enum([
  "display_only",
  "adoptable",
  "candidate_required",
  "provider_owned",
  "forbidden_conflict",
]);
export const projectInboundChangeStatusSchema = z.enum([
  "observed",
  "adopted",
  "candidate",
  "ignored",
  "needs_attention",
  "resolved",
]);
const inboundSummarySchema = z
  .object({
    providerStateId: z.string().trim().min(1).max(200).optional(),
    providerStateName: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(10_000).optional(),
    priority: planeWorkItemPrioritySchema.optional(),
    moduleIds: z.array(z.uuid()).max(20).optional(),
    labelIds: z.array(z.uuid()).max(100).optional(),
    updatedAt: isoDateTimeSchema.optional(),
  })
  .strict();

export const projectInboundChangeSchema = z
  .object({
    schemaVersion: z.literal("project-inbound-change.v1"),
    projectInboundChangeId: projectInboundChangeIdSchema,
    projectId: projectIdSchema,
    bindingId: projectProviderBindingIdSchema,
    projectionId: projectProviderProjectionIdSchema,
    workId: projectWorkIdSchema,
    observedWorkRevision: z.number().int().positive(),
    providerObjectId: z.string().trim().min(1).max(200),
    actorExternalId: z.string().trim().min(1).max(200).optional(),
    beforeFingerprint: sha256Schema,
    afterFingerprint: sha256Schema,
    changeKind: z.enum([
      "state",
      "name",
      "priority",
      "description",
      "labels",
      "assignee",
      "comment",
      "deleted",
      "multiple",
      "unknown",
    ]),
    classification: projectInboundChangeClassificationSchema,
    status: projectInboundChangeStatusSchema,
    before: inboundSummarySchema,
    after: inboundSummarySchema,
    reason: readableTextSchema,
    resolutionDecisionId: projectDecisionIdSchema.optional(),
    commandId: commandIdSchema,
    revision: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type PlaneProjectKey = z.infer<typeof planeProjectKeySchema>;
export type PlaneProjectBinding = z.infer<typeof planeProjectBindingSchema>;
export type PlaneProjectOperationInputIntent = z.infer<
  typeof planeProjectOperationInputIntentSchema
>;
export type PlaneProjectAgentOperationIntent = z.infer<
  typeof planeProjectAgentOperationIntentSchema
>;
export type PlaneProjectOperationIntent = z.infer<typeof planeProjectOperationIntentSchema>;
export type PlaneProjectOperationKind = z.infer<typeof planeProjectOperationKindSchema>;
export type PlaneProjectOperationStatus = z.infer<typeof planeProjectOperationStatusSchema>;
export type PlaneProjectOperationManualDispositionKind = z.infer<
  typeof planeProjectOperationManualDispositionKindSchema
>;
export type PlaneProjectOperationManualDisposition = z.infer<
  typeof planeProjectOperationManualDispositionSchema
>;
export type PlaneProjectOperation = z.infer<typeof planeProjectOperationSchema>;
export type PlaneProjectSnapshot = z.infer<typeof planeProjectSnapshotSchema>;
export type PlaneWorkItemCommentSummary = z.infer<typeof planeWorkItemCommentSummarySchema>;
export type PlaneWorkItemCommentsSnapshot = z.infer<typeof planeWorkItemCommentsSnapshotSchema>;
export type ProjectInboundChange = z.infer<typeof projectInboundChangeSchema>;
