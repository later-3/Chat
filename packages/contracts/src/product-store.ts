import { z } from "zod";
import {
  approvalRequestSchema,
  artifactSchema,
  commandReceiptSchema,
  decisionSchema,
  executionCandidateSchema,
  executionContractSchema,
  messageSchema,
  outboxEntrySchema,
  planRevisionSchema,
  productRunSchema,
  productSessionSchema,
  revisionInputSchema,
  runAttemptSchema,
  validationResultSchema,
} from "./product.js";
import {
  contextPackageSchema,
  memoryAdoptionSchema,
  memoryQuerySchema,
  memoryResultSnapshotSchema,
  runContextRequestSchema,
} from "./context.js";
import { memoryImportIntentSchema, memoryImportResultSchema } from "./memory-import.js";

/**
 * Product Snapshot顶层合同（任务书§8.3）。
 *
 * 不变量：
 * - 单文件完整快照是产品事实源；一次transact原子提交产品事实 + Command Receipt + Outbox。
 * - 不持久化可从权威对象确定性计算的重复索引；内存索引在启动/读取时构建。
 * - 启动遇到损坏JSON、未知Schema、悬空引用、Hash不一致或非法状态时失败关闭，
 *   原文件保持逐字节不变。
 */

export const PRODUCT_STORE_SCHEMA_VERSION = "chat-product-store.v3";

const idKeySchema = z.string().min(1).max(200);

export const productSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_STORE_SCHEMA_VERSION),
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
        memoryImportIntents: z.record(idKeySchema, memoryImportIntentSchema),
        memoryImportResults: z.record(idKeySchema, memoryImportResultSchema),
      })
      .strict(),
    commandReceipts: z.record(idKeySchema, commandReceiptSchema),
    outbox: z.record(idKeySchema, outboxEntrySchema),
  })
  .strict();

export type ProductSnapshot = z.infer<typeof productSnapshotSchema>;
export type ProductEntities = ProductSnapshot["entities"];

export function createEmptySnapshot(committedAt: string): ProductSnapshot {
  return {
    schemaVersion: PRODUCT_STORE_SCHEMA_VERSION,
    storeRevision: 0,
    committedAt,
    entities: {
      sessions: {},
      messages: {},
      runs: {},
      attempts: {},
      plans: {},
      revisionInputs: {},
      approvalRequests: {},
      decisions: {},
      executionContracts: {},
      executionCandidates: {},
      validationResults: {},
      artifacts: {},
      contextRequests: {},
      memoryQueries: {},
      memoryResultSnapshots: {},
      memoryAdoptions: {},
      contextPackages: {},
      memoryImportIntents: {},
      memoryImportResults: {},
    },
    commandReceipts: {},
    outbox: {},
  };
}
