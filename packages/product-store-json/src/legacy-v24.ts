import {
  productSnapshotSchema,
  promptAssemblyV1Schema,
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
  promptAssemblyV4Schema,
  promptAssemblyV5Schema,
  runAttemptV1Schema,
  validationResultV1Schema,
  workflowDefinitionRevisionV1Schema,
  workflowDefinitionV1Schema,
  workflowRunSpecV1Schema,
} from "@chat/contracts";
import { z } from "zod";

/**
 * v24是监督执行Foundation的最后一个已发布Store代；它只允许当时已经发布的内层代际。
 * 这里不能借v25联合Schema读取治理Reviewer，否则伪造的v24会绕过显式迁移边界。
 */
const idKeySchema = z.string().min(1).max(200);
const productSnapshotV24EntitiesSchema = productSnapshotSchema.shape.entities
  .omit({
    memorySessionImports: true,
    memoryAgentOperations: true,
    memoryAgentWriteCandidates: true,
    memoryAgentWriteDecisions: true,
  })
  .extend({
    attempts: z.record(idKeySchema, runAttemptV1Schema),
    validationResults: z.record(idKeySchema, validationResultV1Schema),
    promptAssemblies: z.record(
      idKeySchema,
      z.union([
        promptAssemblyV1Schema,
        promptAssemblyV2Schema,
        promptAssemblyV3Schema,
        promptAssemblyV4Schema,
        promptAssemblyV5Schema,
      ]),
    ),
    workflowDefinitions: z.record(idKeySchema, workflowDefinitionV1Schema),
    workflowDefinitionRevisions: z.record(idKeySchema, workflowDefinitionRevisionV1Schema),
    workflowRunSpecs: z.record(idKeySchema, workflowRunSpecV1Schema),
  })
  .strict();

export const productSnapshotV24Schema = productSnapshotSchema
  .extend({
    schemaVersion: z.literal("chat-product-store.v24"),
    entities: productSnapshotV24EntitiesSchema,
  })
  .strict();

export type ProductSnapshotV24 = z.infer<typeof productSnapshotV24Schema>;
