/**
 * 内部Runtime合同 memory-write 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  commandIdSchema,
  messageIdSchema,
  outboxEntryIdSchema,
  principalIdSchema,
  productSessionIdSchema,
  memoryWriteIntentIdSchema,
  memoryWriteResultIdSchema,
} from "../ids.js";
import { sha256Schema } from "../hash.js";
import { MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION } from "../versions.js";
import { memoryWriteIntentSchema, memoryWriteResultSchema } from "../workflow-memory.js";
import { versioned } from "./shared.js";
import { workflowMemoryNodeIdentityFields } from "./planning.js";
import { WORKFLOW_DISPATCH_SCHEMA_VERSION } from "./dispatch.js";

export const memoryWriteAdapterInputSchema = z
  .object({
    operationId: memoryWriteIntentIdSchema,
    requestSha256: sha256Schema,
    content: z.string().min(1).max(200_000),
    contentType: z.literal("conversation_turn"),
    productSessionId: productSessionIdSchema,
    principalId: principalIdSchema,
    sourceMessageId: messageIdSchema,
  })
  .strict();

export const loadMemoryWriteRequestSchema = z
  .object({
    ...versioned,
    workflowDefinitionVersion: z.literal(MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION),
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    memoryWriteResultId: memoryWriteResultIdSchema,
  })
  .strict();

export const loadMemoryWriteResponseSchema = z
  .object({
    ...versioned,
    intent: memoryWriteIntentSchema,
    result: memoryWriteResultSchema,
    adapterInput: memoryWriteAdapterInputSchema,
  })
  .strict();

export const beginWorkflowMemoryWriteRequestSchema = z
  .object({ ...versioned, commandId: commandIdSchema, ...workflowMemoryNodeIdentityFields })
  .strict();

export const beginWorkflowMemoryWriteResponseSchema = loadMemoryWriteResponseSchema;

export const memoryWriteResultCommandBase = {
  ...versioned,
  workflowDefinitionVersion: z.literal(MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION),
  commandId: commandIdSchema,
  memoryWriteIntentId: memoryWriteIntentIdSchema,
  memoryWriteResultId: memoryWriteResultIdSchema,
  requestSha256: sha256Schema,
  expectedRevision: z.number().int().positive(),
};

export const markMemoryWriteDispatchingRequestSchema = z
  .object(memoryWriteResultCommandBase)
  .strict();

export const memoryWriteAcceptedSchema = z
  .object({
    externalObjectId: z.string().min(1).max(200),
    externalObjectVersion: z.string().min(1).max(200).optional(),
    externalStatus: z.string().min(1).max(100).optional(),
    responseSha256: sha256Schema,
  })
  .strict();

export const commitMemoryWriteAcceptedRequestSchema = z
  .object({
    ...memoryWriteResultCommandBase,
    accepted: memoryWriteAcceptedSchema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryWriteMaterializedRequestSchema = z
  .object({
    ...memoryWriteResultCommandBase,
    accepted: memoryWriteAcceptedSchema,
    verificationKind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    verificationSha256: sha256Schema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryWriteFailedRequestSchema = z
  .object({
    ...memoryWriteResultCommandBase,
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
      .max(96),
    summary: z.string().min(1).max(500),
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryWriteOutcomeUnknownRequestSchema = z
  .object({
    ...memoryWriteResultCommandBase,
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
      .max(96),
    reconciled: z.boolean().optional(),
  })
  .strict();

export const memoryWriteResultResponseSchema = z
  .object({ ...versioned, result: memoryWriteResultSchema })
  .strict();

export const memoryWriteWorkflowDispatchRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    memoryWriteResultId: memoryWriteResultIdSchema,
    expectedResultRevision: z.number().int().positive(),
    mode: z.enum(["write", "reconcile"]),
    workflowDefinitionVersion: z.literal(MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION),
    outboxId: outboxEntryIdSchema,
  })
  .strict();

export const memoryWriteWorkflowDispatchResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["started", "already_started", "outcome_unknown"]),
  })
  .strict();

export const memoryWriteWorkflowReconcileResponseBase = {
  schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
  outboxId: outboxEntryIdSchema,
};

export const memoryWriteWorkflowReconcileResponseSchema = z.discriminatedUnion("startBinding", [
  z
    .object({
      ...memoryWriteWorkflowReconcileResponseBase,
      startBinding: z.literal("exists"),
      runStatus: z.enum(["active", "completed", "failed", "cancelled", "missing"]),
    })
    .strict(),
  z
    .object({
      ...memoryWriteWorkflowReconcileResponseBase,
      startBinding: z.enum(["missing", "outcome_unknown"]),
    })
    .strict(),
]);

/* ---------- 类型 ---------- */
