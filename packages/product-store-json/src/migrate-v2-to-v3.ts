import { z } from "zod";
import {
  approvalRequestIdSchema,
  approvalRequestSchema,
  artifactSchema,
  commandReceiptSchema,
  contextPackageSchema,
  decisionIdSchema,
  decisionSchema,
  executionCandidateSchema,
  executionContractSchema,
  memoryAdoptionSchema,
  memoryQuerySchema,
  memoryResultSnapshotSchema,
  messageSchema,
  outboxEntryIdSchema,
  outboxEntryStatusSchema,
  planRevisionSchema,
  productRunIdSchema,
  productRunSchema,
  productSessionSchema,
  revisionInputSchema,
  runAttemptSchema,
  runContextRequestSchema,
  validationResultSchema,
  type ProductSnapshot,
} from "@chat/contracts";

/** v2 的 Outbox 允许可选 Decision 字段；v3 迁移后收窄为 kind 判别联合。 */
const legacyEntityFields = {
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const outboxEntryV2Schema = z
  .object({
    schemaVersion: z.literal("outbox-entry.v1"),
    outboxId: outboxEntryIdSchema,
    kind: z.enum(["workflow_start", "workflow_resume"]),
    status: outboxEntryStatusSchema,
    productRunId: productRunIdSchema,
    approvalRequestId: approvalRequestIdSchema.optional(),
    decisionId: decisionIdSchema.optional(),
    dispatchAttempts: z.number().int().nonnegative(),
    lastErrorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
      .max(64)
      .optional(),
    ...legacyEntityFields,
  })
  .strict();

const idKeySchema = z.string().min(1).max(200);

/** 只存在于迁移 Adapter 的冻结 v2 物理格式。 */
export const productSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal("chat-product-store.v2"),
    storeRevision: z.number().int().nonnegative(),
    committedAt: z.iso.datetime(),
    entities: z
      .object({
        sessions: z.record(idKeySchema, productSessionSchema),
        messages: z.record(idKeySchema, messageSchema),
        runs: z.record(idKeySchema, productRunSchema),
        attempts: z.record(idKeySchema, runAttemptSchema),
        plans: z.record(idKeySchema, planRevisionSchema),
        revisionInputs: z.record(idKeySchema, revisionInputSchema),
        approvalRequests: z.record(idKeySchema, approvalRequestSchema),
        decisions: z.record(idKeySchema, decisionSchema),
        executionContracts: z.record(idKeySchema, executionContractSchema),
        executionCandidates: z.record(idKeySchema, executionCandidateSchema),
        validationResults: z.record(idKeySchema, validationResultSchema),
        artifacts: z.record(idKeySchema, artifactSchema),
        contextRequests: z.record(idKeySchema, runContextRequestSchema),
        memoryQueries: z.record(idKeySchema, memoryQuerySchema),
        memoryResultSnapshots: z.record(idKeySchema, memoryResultSnapshotSchema),
        memoryAdoptions: z.record(idKeySchema, memoryAdoptionSchema),
        contextPackages: z.record(idKeySchema, contextPackageSchema),
      })
      .strict(),
    commandReceipts: z.record(idKeySchema, commandReceiptSchema),
    outbox: z.record(idKeySchema, outboxEntryV2Schema),
  })
  .strict();

export type ProductSnapshotV2 = z.infer<typeof productSnapshotV2Schema>;

export function migrateProductSnapshotV2ToV3(snapshot: ProductSnapshotV2): ProductSnapshot {
  const migratedOutbox: ProductSnapshot["outbox"] = {};
  for (const [outboxId, entry] of Object.entries(snapshot.outbox)) {
    if (entry.kind === "workflow_start") {
      migratedOutbox[outboxId] = {
        schemaVersion: entry.schemaVersion,
        outboxId: entry.outboxId,
        kind: entry.kind,
        status: entry.status,
        productRunId: entry.productRunId,
        dispatchAttempts: entry.dispatchAttempts,
        ...(entry.lastErrorCode !== undefined ? { lastErrorCode: entry.lastErrorCode } : {}),
        revision: entry.revision,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
      continue;
    }
    if (entry.approvalRequestId === undefined || entry.decisionId === undefined) {
      throw new Error(`v2 workflow_resume ${outboxId} 缺少Decision绑定`);
    }
    migratedOutbox[outboxId] = {
      schemaVersion: entry.schemaVersion,
      outboxId: entry.outboxId,
      kind: entry.kind,
      status: entry.status,
      productRunId: entry.productRunId,
      approvalRequestId: entry.approvalRequestId,
      decisionId: entry.decisionId,
      dispatchAttempts: entry.dispatchAttempts,
      ...(entry.lastErrorCode !== undefined ? { lastErrorCode: entry.lastErrorCode } : {}),
      revision: entry.revision,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  return {
    schemaVersion: "chat-product-store.v3",
    storeRevision: snapshot.storeRevision,
    committedAt: snapshot.committedAt,
    entities: {
      ...snapshot.entities,
      memoryImportIntents: {},
      memoryImportResults: {},
    },
    commandReceipts: snapshot.commandReceipts,
    outbox: migratedOutbox,
  };
}
