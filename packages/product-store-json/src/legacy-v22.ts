import { productSnapshotSchema } from "@chat/contracts";
import { z } from "zod";

/**
 * 双谱系汇合后实际发布的v22。它同时拥有Capability与Project Coordination事实，
 * 但尚未持久化全项目生命周期K1的Profile/Configuration/Event等七组集合。
 */
const projectLifecycleV22EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
    projectProfileRevisions: true,
    projectConfigurationRevisions: true,
    projectEvents: true,
    projectNeeds: true,
    projectRequirements: true,
    projectArtifactRefs: true,
    projectMetricObservations: true,
  })
  .strict();

export const productSnapshotV22Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v22"),
    entities: projectLifecycleV22EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV22 = z.infer<typeof productSnapshotV22Schema>;
