import { z } from "zod";

export const projectMethodProfileIdSchema = z.enum([
  "small-project.v1",
  "software-delivery.v1",
  "lightweight.v1",
]);

export const projectStatusSchema = z.enum(["active", "paused", "completed", "archived"]);
export const projectMilestoneStatusSchema = z.enum(["planned", "achieved", "cancelled"]);
export const projectHealthSchema = z.enum(["on_track", "at_risk", "off_track", "unknown"]);
export const projectWorkStatusSchema = z.enum([
  "draft",
  "approved",
  "in_progress",
  "review",
  "done",
  "cancelled",
]);
export const projectActionStatusSchema = z.enum(["todo", "doing", "blocked", "done", "cancelled"]);
