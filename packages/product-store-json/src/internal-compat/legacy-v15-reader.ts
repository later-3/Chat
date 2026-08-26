import { z } from "zod";
import { productSnapshotV16MainSchema } from "./legacy-v16-reader.js";

export const productSnapshotV15Schema = productSnapshotV16MainSchema
  .extend({ schemaVersion: z.literal("chat-product-store.v15") })
  .strict();

export type ProductSnapshotV15 = z.infer<typeof productSnapshotV15Schema>;
