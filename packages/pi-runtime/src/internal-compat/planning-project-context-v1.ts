import {
  projectActionIdSchema,
  projectMilestoneIdSchema,
  projectUpdateIdSchema,
  projectWorkIdSchema,
} from "@chat/contracts";
import { z } from "zod";
import {
  projectActionStatusSchema,
  projectHealthSchema,
  projectMethodProfileIdSchema,
  projectMilestoneStatusSchema,
  projectStatusSchema,
  projectWorkStatusSchema,
} from "./project-v20.js";

const isoDateTimeSchema = z.iso.datetime();
const shortTextSchema = z.string().trim().min(1).max(500);
const longTextSchema = z.string().trim().min(1).max(4_000);

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
