import { z } from "zod";
import { productSnapshotV4Schema, type ProductSnapshotV4 } from "./legacy-v4.js";

/** v3只比v4少Project Solution集合；迁移不得改写任何既有事实。 */
const productEntitiesV3Schema = productSnapshotV4Schema.shape.entities.omit({
  projects: true,
  projectMethodSnapshots: true,
  projectStages: true,
  projectResources: true,
  projectParticipants: true,
  projectWorks: true,
  projectActions: true,
  projectContributions: true,
  projectEvidence: true,
  projectDecisions: true,
  projectObservations: true,
  projectCandidates: true,
});

export const productSnapshotV3Schema = z
  .object({
    schemaVersion: z.literal("chat-product-store.v3"),
    storeRevision: z.number().int().nonnegative(),
    committedAt: z.iso.datetime(),
    entities: productEntitiesV3Schema,
    commandReceipts: productSnapshotV4Schema.shape.commandReceipts,
    outbox: productSnapshotV4Schema.shape.outbox,
  })
  .strict();

export type ProductSnapshotV3 = z.infer<typeof productSnapshotV3Schema>;

export function migrateProductSnapshotV3ToV4(snapshot: ProductSnapshotV3): ProductSnapshotV4 {
  return {
    schemaVersion: "chat-product-store.v4",
    storeRevision: snapshot.storeRevision,
    committedAt: snapshot.committedAt,
    entities: {
      ...snapshot.entities,
      projects: {},
      projectMethodSnapshots: {},
      projectStages: {},
      projectResources: {},
      projectParticipants: {},
      projectWorks: {},
      projectActions: {},
      projectContributions: {},
      projectEvidence: {},
      projectDecisions: {},
      projectObservations: {},
      projectCandidates: {},
    },
    commandReceipts: snapshot.commandReceipts,
    outbox: snapshot.outbox,
  };
}
