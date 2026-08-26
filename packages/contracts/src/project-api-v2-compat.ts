import { z } from "zod";

/** main@ac8f9c06网络v2的冻结枚举，只供project-api旧读Schema引用。 */
export const projectMethodProfileIdSchema = z.enum([
  "small-project.v1",
  "software-delivery.v1",
  "lightweight.v1",
]);

export const projectResourceAdapterKindSchema = z.enum([
  "local-git-workspace.v1",
  "project-document-manifest.v1",
  "package-script-catalog.v1",
]);

export const projectWorkStatusSchema = z.enum([
  "draft",
  "approved",
  "in_progress",
  "review",
  "done",
  "cancelled",
]);
