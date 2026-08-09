import { z } from "zod";
import {
  principalIdSchema,
  productSnapshotSchema,
  projectIdSchema,
  projectMethodPolicySchema,
  projectMethodSnapshotIdSchema,
  projectStageIdSchema,
} from "@chat/contracts";

const isoDateTimeSchema = z.iso.datetime();
const entityBase = {
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(4_000);

export const projectMethodSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal("project-method-snapshot.v1"),
    projectMethodSnapshotId: projectMethodSnapshotIdSchema,
    projectId: projectIdSchema,
    profileId: z.enum(["small-project.v1", "software-delivery.v1", "lightweight.v1"]),
    rationale: z.string().min(1).max(2_000),
    policies: projectMethodPolicySchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    ...entityBase,
  })
  .strict();

export const projectV1Schema = z
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
    status: z.enum(["active", "archived"]),
    methodSnapshotId: projectMethodSnapshotIdSchema,
    currentStageId: projectStageIdSchema,
    ...entityBase,
  })
  .strict();

export const projectStageV1Schema = z
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

const entitiesV4Schema = productSnapshotSchema.shape.entities
  .omit({
    projects: true,
    projectMethodSnapshots: true,
    projectStages: true,
    projectMilestones: true,
    projectUpdates: true,
    projectStateTransitions: true,
  })
  .extend({
    projects: z.record(z.string().min(1).max(200), projectV1Schema),
    projectMethodSnapshots: z.record(z.string().min(1).max(200), projectMethodSnapshotV1Schema),
    projectStages: z.record(z.string().min(1).max(200), projectStageV1Schema),
  })
  .strict();

export const productSnapshotV4Schema = z
  .object({
    schemaVersion: z.literal("chat-product-store.v4"),
    storeRevision: z.number().int().nonnegative(),
    committedAt: isoDateTimeSchema,
    entities: entitiesV4Schema,
    commandReceipts: productSnapshotSchema.shape.commandReceipts,
    outbox: productSnapshotSchema.shape.outbox,
  })
  .strict();

export type ProductSnapshotV4 = z.infer<typeof productSnapshotV4Schema>;
