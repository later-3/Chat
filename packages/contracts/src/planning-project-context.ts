import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  planningProjectContextIdSchema,
  productRunIdSchema,
  projectActionIdSchema,
  projectIdSchema,
  projectMethodSnapshotIdSchema,
  projectMilestoneIdSchema,
  projectStageIdSchema,
  projectUpdateIdSchema,
  projectWorkIdSchema,
} from "./ids.js";
import {
  projectActionStatusSchema,
  projectHealthSchema,
  projectMethodProfileIdSchema,
  projectMilestoneStatusSchema,
  projectStatusSchema,
  projectWorkStatusSchema,
} from "./project.js";

const isoDateTimeSchema = z.iso.datetime();
const shortTextSchema = z.string().trim().min(1).max(500);
const longTextSchema = z.string().trim().min(1).max(4_000);

const immutableRefFields = {
  revision: z.number().int().positive(),
  sha256: sha256Schema,
};

export const planningProjectMethodRefSchema = z
  .object({
    projectMethodSnapshotId: projectMethodSnapshotIdSchema,
    ...immutableRefFields,
  })
  .strict();

export const planningProjectStageRefSchema = z
  .object({ projectStageId: projectStageIdSchema, ...immutableRefFields })
  .strict();

export const planningProjectSourceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("project"), objectId: projectIdSchema, ...immutableRefFields })
    .strict(),
  z
    .object({
      kind: z.literal("method"),
      objectId: projectMethodSnapshotIdSchema,
      ...immutableRefFields,
    })
    .strict(),
  z
    .object({ kind: z.literal("stage"), objectId: projectStageIdSchema, ...immutableRefFields })
    .strict(),
  z
    .object({
      kind: z.literal("milestone"),
      objectId: projectMilestoneIdSchema,
      ...immutableRefFields,
    })
    .strict(),
  z
    .object({ kind: z.literal("update"), objectId: projectUpdateIdSchema, ...immutableRefFields })
    .strict(),
  z
    .object({ kind: z.literal("work"), objectId: projectWorkIdSchema, ...immutableRefFields })
    .strict(),
  z
    .object({ kind: z.literal("action"), objectId: projectActionIdSchema, ...immutableRefFields })
    .strict(),
]);

const planningProjectActionSnapshotSchema = z
  .object({
    projectActionId: projectActionIdSchema,
    title: z.string().trim().min(1).max(240),
    status: projectActionStatusSchema,
    blockedReason: shortTextSchema.optional(),
  })
  .strict();

const planningProjectWorkSnapshotSchema = z
  .object({
    projectWorkId: projectWorkIdSchema,
    title: z.string().trim().min(1).max(200),
    status: projectWorkStatusSchema,
    actions: z.array(planningProjectActionSnapshotSchema).max(30),
  })
  .strict();

export const planningProjectSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1_000),
    goal: longTextSchema,
    scopeIn: z.array(shortTextSchema).max(30),
    scopeOut: z.array(shortTextSchema).max(30),
    successCriteria: z.array(shortTextSchema).min(1).max(30),
    status: projectStatusSchema,
    methodProfileId: projectMethodProfileIdSchema,
    stage: z
      .object({
        key: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u),
        name: z.string().trim().min(1).max(120),
        goal: longTextSchema,
        successCriteria: z.array(shortTextSchema).min(1).max(20),
        status: z.enum(["planned", "active", "review", "completed", "skipped"]),
      })
      .strict(),
    milestones: z
      .array(
        z
          .object({
            projectMilestoneId: projectMilestoneIdSchema,
            outcome: longTextSchema,
            acceptanceCriteria: z.array(shortTextSchema).min(1).max(20),
            status: projectMilestoneStatusSchema,
            targetAt: isoDateTimeSchema.optional(),
          })
          .strict(),
      )
      .max(20),
    latestUpdate: z
      .object({
        projectUpdateId: projectUpdateIdSchema,
        health: projectHealthSchema,
        narrative: longTextSchema,
        blockers: z.array(shortTextSchema).max(20),
        nextFocus: z.array(shortTextSchema).min(1).max(20),
        publishedAt: isoDateTimeSchema,
      })
      .strict()
      .optional(),
    activeWorks: z.array(planningProjectWorkSnapshotSchema).max(30),
  })
  .strict();

/**
 * PlanningProjectContext是运行开始前冻结的安全正文快照。Project后续修订不能改变它；
 * `sourceRefs`用于审计来源，正文和Hash只在本对象保存一次，不复制进Trace。
 */
export const planningProjectContextSchema = z
  .object({
    schemaVersion: z.literal("planning-project-context.v1"),
    planningProjectContextId: planningProjectContextIdSchema,
    productRunId: productRunIdSchema,
    projectId: projectIdSchema,
    projectRevision: z.number().int().positive(),
    projectSha256: sha256Schema,
    methodRef: planningProjectMethodRefSchema,
    stageRef: planningProjectStageRefSchema,
    snapshot: planningProjectSnapshotSchema,
    sourceRefs: z.array(planningProjectSourceRefSchema).min(3).max(100),
    sha256: sha256Schema,
    revision: z.literal(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type PlanningProjectContext = z.infer<typeof planningProjectContextSchema>;
export type PlanningProjectSnapshot = z.infer<typeof planningProjectSnapshotSchema>;
export type PlanningProjectSourceRef = z.infer<typeof planningProjectSourceRefSchema>;
