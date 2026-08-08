import { z } from "zod";
import {
  approvalRequestIdSchema,
  decisionIdSchema,
  messageIdSchema,
  planIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  contextPackageIdSchema,
  memoryBackendIdSchema,
  memoryQueryIdSchema,
  memoryResultSnapshotIdSchema,
} from "./ids.js";
import {
  approvalRequestStatusSchema,
  decisionKindSchema,
  messageContentSchema,
  messageRoleSchema,
  planContentSchema,
  planRevisionStatusSchema,
  productRunPhaseSchema,
  productRunStatusSchema,
  runFailureSchema,
} from "./product.js";
import { sha256Schema } from "./hash.js";
import { memoryContextSelectionSchema, memoryLayerSchema } from "./context.js";

/**
 * B2公开Query/Command网络DTO（任务书§12）。
 *
 * 不变量：
 * - Command payload全部strict：浏览器试图指定Provider、模型或Runtime参数时
 *   直接以validation_failed拒绝，而不是静默忽略。
 * - Query响应携带schemaVersion、revision、updatedAt与允许的动作。
 * - 公开合同永远不出现Workflow Run ID、Hook Token、pi Session ID、
 *   百炼Request ID或服务器路径。
 */

export const PRODUCT_API_SCHEMA_VERSION = "chat-product-api.v1";

/* ---------- Command payloads ---------- */

export const createSessionPayloadSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

export const submitMessagePayloadSchema = z
  .object({
    text: z.string().min(1).max(4000),
    context: z
      .object({
        memory: memoryContextSelectionSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const submitDecisionPayloadSchema = z
  .object({
    approvalRequestId: approvalRequestIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    kind: decisionKindSchema,
    /** request_revision必填、非空、有长度上限。 */
    revisionInstruction: z.string().min(1).max(2000).optional(),
    /** reject可选、有长度上限。 */
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .check((ctx) => {
    const value = ctx.value;
    if (value.kind === "request_revision" && value.revisionInstruction === undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "request_revision必须携带revisionInstruction",
        path: ["revisionInstruction"],
      });
    }
    if (value.kind !== "request_revision" && value.revisionInstruction !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "只有request_revision允许携带revisionInstruction",
        path: ["revisionInstruction"],
      });
    }
    if (value.kind !== "reject" && value.reason !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "只有reject允许携带reason",
        path: ["reason"],
      });
    }
  });

export type CreateSessionPayload = z.infer<typeof createSessionPayloadSchema>;
export type SubmitMessagePayload = z.infer<typeof submitMessagePayloadSchema>;
export type SubmitDecisionPayload = z.infer<typeof submitDecisionPayloadSchema>;

/* ---------- Memory backend 与 Run Context ---------- */

export const memoryBackendProfileDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    backendId: memoryBackendIdSchema,
    displayName: z.string().min(1).max(100),
    kind: z.literal("memmy"),
    configured: z.boolean(),
    health: z.enum(["ready", "unavailable"]),
    capabilities: z
      .object({
        query: z.literal(true),
        tags: z.literal(true),
        layers: z.array(memoryLayerSchema).min(1).max(4),
        maxLimit: z.number().int().positive().max(20),
        maxContextBudget: z.number().int().min(128).max(8_192),
      })
      .strict(),
  })
  .strict();

export const memoryContextSourceDtoSchema = z
  .object({
    memoryResultSnapshotId: memoryResultSnapshotIdSchema,
    backendId: memoryBackendIdSchema,
    title: z.string().min(1).max(200),
    kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
    memoryLayer: memoryLayerSchema,
    tags: z.array(z.string().min(1).max(64)).max(50),
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

const runContextMemoryBase = {
  backendId: memoryBackendIdSchema,
  requirement: z.enum(["required", "optional"]),
  memoryQueryId: memoryQueryIdSchema,
};

export const runContextMemoryDtoSchema = z.discriminatedUnion("queryStatus", [
  z.object({ ...runContextMemoryBase, queryStatus: z.literal("pending") }).strict(),
  z
    .object({
      ...runContextMemoryBase,
      queryStatus: z.literal("completed"),
      hitCount: z.number().int().nonnegative(),
      adoptedCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...runContextMemoryBase,
      queryStatus: z.literal("failed"),
      errorCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
        .max(64),
    })
    .strict(),
]);

export const runContextDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    memory: runContextMemoryDtoSchema.optional(),
    contextPackage: z
      .object({
        contextPackageId: contextPackageIdSchema,
        revision: z.number().int().positive(),
        sha256: sha256Schema,
        sources: z.array(memoryContextSourceDtoSchema).max(20),
        exclusions: z
          .array(
            z
              .object({
                backendId: memoryBackendIdSchema,
                reasonCode: z.string().min(1).max(64),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .optional(),
  })
  .strict();

export type MemoryBackendProfileDto = z.infer<typeof memoryBackendProfileDtoSchema>;
export type RunContextDto = z.infer<typeof runContextDtoSchema>;

/* ---------- Query DTO ---------- */

export const sessionDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    sessionId: productSessionIdSchema,
    status: z.enum(["active", "archived"]),
    title: z.string().min(1).max(200).optional(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const messageDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    messageId: messageIdSchema,
    sessionId: productSessionIdSchema,
    sessionSequence: z.number().int().positive(),
    role: messageRoleSchema,
    content: messageContentSchema,
    sourceRunId: productRunIdSchema.optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const planDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    status: planRevisionStatusSchema,
    sha256: sha256Schema,
    content: planContentSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const approvalDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    approvalRequestId: approvalRequestIdSchema,
    productRunId: productRunIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    status: approvalRequestStatusSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const runAllowedActionSchema = z.enum(["request_revision", "approve", "reject"]);

export const runDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    sessionId: productSessionIdSchema,
    sourceMessageId: messageIdSchema,
    status: productRunStatusSchema,
    phase: productRunPhaseSchema,
    currentPlan: z
      .object({
        planId: planIdSchema,
        planRevision: z.number().int().positive(),
        status: planRevisionStatusSchema,
        sha256: sha256Schema,
      })
      .strict()
      .optional(),
    currentApprovalRequestId: approvalRequestIdSchema.optional(),
    finalMessageId: messageIdSchema.optional(),
    failure: runFailureSchema.optional(),
    maxPlanRevisions: z.number().int().positive(),
    /** 浏览器只根据本字段呈现可执行动作，不自行猜测状态机。 */
    allowedActions: z.array(runAllowedActionSchema),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const decisionDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    decisionId: decisionIdSchema,
    approvalRequestId: approvalRequestIdSchema,
    productRunId: productRunIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    kind: decisionKindSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export type SessionDto = z.infer<typeof sessionDtoSchema>;
export type MessageDto = z.infer<typeof messageDtoSchema>;
export type PlanDto = z.infer<typeof planDtoSchema>;
export type ApprovalDto = z.infer<typeof approvalDtoSchema>;
export type RunDto = z.infer<typeof runDtoSchema>;
export type DecisionDto = z.infer<typeof decisionDtoSchema>;
export type RunAllowedAction = z.infer<typeof runAllowedActionSchema>;
