import { z } from "zod";
import {
  approvalRequestSchema,
  artifactSchema,
  commandReceiptSchema,
  contextRequestIdSchema,
  decisionSchema,
  executionCandidateSchema,
  executionContractSchema,
  messageSchema,
  outboxEntrySchema,
  planRevisionSchema,
  productRunSchema,
  productSessionSchema,
  revisionInputSchema,
  runAttemptIdSchema,
  productRunIdSchema,
  planRevisionIdSchema,
  revisionInputIdSchema,
  sha256Schema,
  validationResultSchema,
  type ProductSnapshot,
} from "@chat/contracts";
import { computeRunContextRequestSha256, hashCanonical } from "@chat/domain";

/**
 * chat-product-store.v1 的冻结形状。
 *
 * 迁移只增加空的长期上下文集合，不修改任何既有产品对象、Receipt 或 revision。
 * 旧 Schema 保留在 Adapter 内部，避免把已退役物理格式重新暴露为公共合同。
 */
const idKeySchema = z.string().min(1).max(200);
const legacyEntityBaseFields = {
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/** v1 物理格式的冻结 Attempt；不能复用会继续扩展的当前公共 Schema。 */
const runAttemptV1Schema = z
  .object({
    schemaVersion: z.literal("run-attempt.v1"),
    attemptId: runAttemptIdSchema,
    productRunId: productRunIdSchema,
    kind: z.enum(["workflow", "planning", "execution"]),
    planRevision: z.number().int().positive().optional(),
    stepId: z.string().min(1).max(100).optional(),
    inputRunRevision: z.number().int().positive().optional(),
    sourceMessageSha256: sha256Schema.optional(),
    priorPlanRevisionId: planRevisionIdSchema.optional(),
    revisionInputId: revisionInputIdSchema.optional(),
    inputManifestSha256: sha256Schema.optional(),
    promptTemplateVersion: z.string().min(1).max(100).optional(),
    modelConfigVersion: z.string().min(1).max(100).optional(),
    outcome: z.enum(["running", "success", "failure"]),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
      .max(64)
      .optional(),
    ...legacyEntityBaseFields,
  })
  .strict();

export const productSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal("chat-product-store.v1"),
    storeRevision: z.number().int().nonnegative(),
    committedAt: z.iso.datetime(),
    entities: z
      .object({
        sessions: z.record(idKeySchema, productSessionSchema),
        messages: z.record(idKeySchema, messageSchema),
        runs: z.record(idKeySchema, productRunSchema),
        attempts: z.record(idKeySchema, runAttemptV1Schema),
        plans: z.record(idKeySchema, planRevisionSchema),
        revisionInputs: z.record(idKeySchema, revisionInputSchema),
        approvalRequests: z.record(idKeySchema, approvalRequestSchema),
        decisions: z.record(idKeySchema, decisionSchema),
        executionContracts: z.record(idKeySchema, executionContractSchema),
        executionCandidates: z.record(idKeySchema, executionCandidateSchema),
        validationResults: z.record(idKeySchema, validationResultSchema),
        artifacts: z.record(idKeySchema, artifactSchema),
      })
      .strict(),
    commandReceipts: z.record(idKeySchema, commandReceiptSchema),
    outbox: z.record(idKeySchema, outboxEntrySchema),
  })
  .strict();

export type ProductSnapshotV1 = z.infer<typeof productSnapshotV1Schema>;

export function migrateProductSnapshotV1ToV2(snapshot: ProductSnapshotV1): ProductSnapshot {
  const contextRequests: ProductSnapshot["entities"]["contextRequests"] = {};
  for (const run of Object.values(snapshot.entities.runs)) {
    const message = snapshot.entities.messages[run.sourceMessageId];
    const session = snapshot.entities.sessions[run.sessionId];
    if (message === undefined || session === undefined) continue;
    const contextRequestId = contextRequestIdSchema.parse(
      `ctxr_${hashCanonical("id.run-context-request.v1", {
        productRunId: run.productRunId,
      }).slice(0, 32)}`,
    );
    const sourceMessageSha256 = hashCanonical("message.v1", {
      messageId: message.messageId,
      sessionId: message.sessionId,
      sessionSequence: message.sessionSequence,
      role: message.role,
      content: message.content,
    });
    const shape = {
      productRunId: run.productRunId,
      requestedByPrincipalId: session.ownerPrincipalId,
      sourceMessageId: message.messageId,
      sourceMessageSha256,
    };
    contextRequests[contextRequestId] = {
      schemaVersion: "run-context-request.v1",
      contextRequestId,
      ...shape,
      sha256: computeRunContextRequestSha256(shape),
      revision: 1,
      createdAt: snapshot.committedAt,
      updatedAt: snapshot.committedAt,
    };
  }
  return {
    schemaVersion: "chat-product-store.v2",
    storeRevision: snapshot.storeRevision,
    committedAt: snapshot.committedAt,
    entities: {
      ...snapshot.entities,
      contextRequests,
      memoryQueries: {},
      memoryResultSnapshots: {},
      memoryAdoptions: {},
      contextPackages: {},
    },
    commandReceipts: snapshot.commandReceipts,
    outbox: snapshot.outbox,
  };
}
