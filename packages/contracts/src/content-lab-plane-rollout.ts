import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { projectIdSchema } from "./ids.js";
import {
  planeCeProjectIdSchema,
  planeCeProjectIdentifierSchema,
  planeCeWorkspaceSlugSchema,
} from "./project-bootstrap.js";
import { promptWorkspaceRootIdSchema } from "./prompt-fragment.js";

export const CONTENT_LAB_PLANE_ROLLOUT_SCHEMA_VERSION = "content-lab-plane-rollout.v1";

export const contentLabPlaneRolloutDryRunQuerySchema = z
  .object({
    projectId: projectIdSchema,
    workspaceRootId: promptWorkspaceRootIdSchema,
    planeWorkspaceSlug: planeCeWorkspaceSlugSchema,
    planeProjectIdentifier: planeCeProjectIdentifierSchema,
  })
  .strict();

const rolloutScalarSchema = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

export const contentLabPlaneRolloutChangeSchema = z
  .object({
    field: z.string().min(1).max(120),
    before: rolloutScalarSchema,
    after: rolloutScalarSchema,
  })
  .strict();

export const contentLabPlaneRolloutActionSchema = z.enum([
  "noop",
  "create",
  "update",
  "manual_review",
]);

export const contentLabPlaneRolloutOperationSchema = z
  .object({
    targetKind: z.enum([
      "project_configuration",
      "state",
      "module",
      "label",
      "view",
      "page",
      "intake",
      "history_work",
      "workflow_improvement",
    ]),
    stableKey: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,254}$/u),
    displayName: z.string().min(1).max(255),
    action: contentLabPlaneRolloutActionSchema,
    changes: z.array(contentLabPlaneRolloutChangeSchema).max(40),
    reason: z.string().min(1).max(1_000),
    destructive: z.literal(false),
    requiresExplicitApproval: z.boolean(),
  })
  .strict();

export const contentLabPlaneRolloutSampleSchema = z
  .object({
    sampleKind: z.enum([
      "xiaohongshu_independent",
      "series_content",
      "bilibili_content",
      "blocked_content",
      "workflow_improvement",
    ]),
    sourceRef: z.string().min(1).max(500),
    workKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
    title: z.string().min(1).max(255),
    desiredState: z.enum(["Intake", "Proposed", "Needs Review", "Ready", "Blocked"]),
    moduleName: z.enum(["小红书内容交付", "B站内容交付", "工作流持续改进"]),
    labels: z.array(z.string().min(1).max(255)).min(1).max(20),
    authority: z.literal("candidate_only"),
    authoritativeRefs: z.array(z.string().min(1).max(500)).min(1).max(20),
    selectionReason: z.string().min(1).max(1_000),
  })
  .strict();

export const contentLabPlaneRolloutDryRunSchema = z
  .object({
    schemaVersion: z.literal(CONTENT_LAB_PLANE_ROLLOUT_SCHEMA_VERSION),
    mode: z.literal("dry_run"),
    mappingVersion: z.literal("content-lab-plane-mapping.v1"),
    project: z
      .object({
        projectId: projectIdSchema,
        projectRevision: z.number().int().positive(),
        methodProfileId: z.literal("content-production.v1"),
        workspaceRootId: promptWorkspaceRootIdSchema,
        resourceObservationSha256: sha256Schema,
      })
      .strict(),
    plane: z
      .object({
        providerVersion: z.literal("1.4.1"),
        workspaceSlug: planeCeWorkspaceSlugSchema,
        projectId: planeCeProjectIdSchema,
        projectIdentifier: planeCeProjectIdentifierSchema,
        projectName: z.string().min(1).max(255),
        inspectionSha256: sha256Schema,
        surfaceAvailability: z
          .object({
            views: z.enum(["available", "unavailable"]),
            pages: z.enum(["available", "unavailable"]),
            intakes: z.enum(["available", "unavailable"]),
          })
          .strict(),
        capturedAt: z.iso.datetime(),
      })
      .strict(),
    currentCounts: z
      .object({
        states: z.number().int().nonnegative(),
        modules: z.number().int().nonnegative(),
        labels: z.number().int().nonnegative(),
        views: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        intakes: z.number().int().nonnegative(),
        workItems: z.number().int().nonnegative(),
      })
      .strict(),
    samples: z.array(contentLabPlaneRolloutSampleSchema).length(5),
    operations: z.array(contentLabPlaneRolloutOperationSchema).max(100),
    summary: z
      .object({
        noop: z.number().int().nonnegative(),
        create: z.number().int().nonnegative(),
        update: z.number().int().nonnegative(),
        manualReview: z.number().int().nonnegative(),
        destructive: z.literal(0),
      })
      .strict(),
    blockers: z.array(z.string().min(1).max(1_000)).max(50),
    warnings: z.array(z.string().min(1).max(1_000)).max(50),
    executionAuthorized: z.literal(false),
    planeWrites: z.literal(0),
    dryRunSha256: sha256Schema,
    generatedAt: z.iso.datetime(),
  })
  .strict();

export const contentLabPlaneRolloutDryRunResponseSchema = z
  .object({ dryRun: contentLabPlaneRolloutDryRunSchema })
  .strict();

export const contentLabPlaneRolloutExecutionRequestSchema = z
  .object({
    approvedDryRunSha256: sha256Schema,
  })
  .strict();

export const contentLabPlaneRolloutExecutionObjectSchema = z
  .object({
    targetKind: z.enum([
      "project_configuration",
      "state",
      "module",
      "label",
      "history_work",
      "workflow_improvement",
    ]),
    stableKey: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,254}$/u),
    displayName: z.string().min(1).max(255),
    externalId: z.string().min(1).max(255).optional(),
    providerObjectId: z.uuid(),
    outcome: z.enum(["created", "updated", "reused"]),
  })
  .strict();

export const contentLabPlaneRolloutExecutionSchema = z
  .object({
    schemaVersion: z.literal(CONTENT_LAB_PLANE_ROLLOUT_SCHEMA_VERSION),
    mode: z.literal("executed"),
    approvedDryRunSha256: sha256Schema,
    beforeInspectionSha256: sha256Schema,
    afterInspectionSha256: sha256Schema,
    planeWorkspaceSlug: planeCeWorkspaceSlugSchema,
    planeProjectId: planeCeProjectIdSchema,
    objects: z.array(contentLabPlaneRolloutExecutionObjectSchema).length(31),
    summary: z
      .object({
        created: z.number().int().nonnegative(),
        updated: z.number().int().nonnegative(),
        reused: z.number().int().nonnegative(),
        writes: z.number().int().nonnegative(),
        destructive: z.literal(0),
        skippedManualReview: z.literal(18),
      })
      .strict(),
    completedAt: z.iso.datetime(),
  })
  .strict();

export const contentLabPlaneRolloutExecutionResponseSchema = z
  .object({ execution: contentLabPlaneRolloutExecutionSchema })
  .strict();

export type ContentLabPlaneRolloutDryRunQuery = z.infer<
  typeof contentLabPlaneRolloutDryRunQuerySchema
>;
export type ContentLabPlaneRolloutOperation = z.infer<typeof contentLabPlaneRolloutOperationSchema>;
export type ContentLabPlaneRolloutSample = z.infer<typeof contentLabPlaneRolloutSampleSchema>;
export type ContentLabPlaneRolloutDryRun = z.infer<typeof contentLabPlaneRolloutDryRunSchema>;
export type ContentLabPlaneRolloutExecutionRequest = z.infer<
  typeof contentLabPlaneRolloutExecutionRequestSchema
>;
export type ContentLabPlaneRolloutExecutionObject = z.infer<
  typeof contentLabPlaneRolloutExecutionObjectSchema
>;
export type ContentLabPlaneRolloutExecution = z.infer<typeof contentLabPlaneRolloutExecutionSchema>;
