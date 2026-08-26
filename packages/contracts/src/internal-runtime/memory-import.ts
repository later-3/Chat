/**
 * 内部Runtime合同 memory-import 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  commandIdSchema,
  messageIdSchema,
  outboxEntryIdSchema,
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  productSessionIdSchema,
} from "../ids.js";
import { sha256Schema } from "../hash.js";
import { memoryImportIntentSchema, memoryImportResultSchema } from "../memory-import.js";
import { MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION } from "../versions.js";
import { versioned, stableRuntimeErrorCodeSchema } from "./shared.js";
import { WORKFLOW_DISPATCH_SCHEMA_VERSION } from "./dispatch.js";

export const memoryImportAdapterInputSchema = z
  .object({
    operationId: memoryImportIntentIdSchema,
    requestSha256: sha256Schema,
    content: z.string().min(1).max(50_000),
    layer: z.enum(["L0", "L2"]),
    title: z.string().min(1).max(200),
    tags: z.array(z.string().min(1).max(64)).max(20),
    source: z.literal("chat.explicit_import"),
    sessionId: productSessionIdSchema,
    turnId: messageIdSchema,
  })
  .strict();

export const loadMemoryImportRequestSchema = z
  .object({
    ...versioned,
    workflowDefinitionVersion: z.literal(MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION),
    memoryImportIntentId: memoryImportIntentIdSchema,
    memoryImportResultId: memoryImportResultIdSchema,
  })
  .strict();

export const loadMemoryImportResponseSchema = z
  .object({
    ...versioned,
    intent: memoryImportIntentSchema,
    result: memoryImportResultSchema,
    adapterInput: memoryImportAdapterInputSchema,
  })
  .strict();

export const memoryImportResultCommandBase = {
  ...versioned,
  workflowDefinitionVersion: z.literal(MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION),
  commandId: commandIdSchema,
  memoryImportIntentId: memoryImportIntentIdSchema,
  memoryImportResultId: memoryImportResultIdSchema,
  requestSha256: sha256Schema,
  expectedRevision: z.number().int().positive(),
};

export const markMemoryImportDispatchingRequestSchema = z
  .object(memoryImportResultCommandBase)
  .strict();

export const memoryImportAcceptedSchema = z
  .object({
    externalObjectId: z.string().min(1).max(200),
    externalObjectVersion: z.string().min(1).max(200).optional(),
    externalStatus: z.string().min(1).max(100).optional(),
    responseSha256: sha256Schema,
  })
  .strict();

export const commitMemoryImportAcceptedRequestSchema = z
  .object({
    ...memoryImportResultCommandBase,
    accepted: memoryImportAcceptedSchema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryImportMaterializedRequestSchema = z
  .object({
    ...memoryImportResultCommandBase,
    accepted: memoryImportAcceptedSchema,
    verificationKind: z.enum(["read_by_id", "read_by_id_and_search", "l0_and_session_l1"]),
    verificationSha256: sha256Schema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryImportFailedRequestSchema = z
  .object({
    ...memoryImportResultCommandBase,
    errorCode: stableRuntimeErrorCodeSchema,
    summary: z.string().min(1).max(500),
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryImportOutcomeUnknownRequestSchema = z
  .object({
    ...memoryImportResultCommandBase,
    errorCode: stableRuntimeErrorCodeSchema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const memoryImportResultResponseSchema = z
  .object({ ...versioned, result: memoryImportResultSchema })
  .strict();

export const memoryImportWorkflowDispatchRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    memoryImportIntentId: memoryImportIntentIdSchema,
    memoryImportResultId: memoryImportResultIdSchema,
    expectedResultRevision: z.number().int().positive(),
    mode: z.enum(["import", "reconcile"]),
    workflowDefinitionVersion: z.string().min(1).max(100),
    outboxId: outboxEntryIdSchema,
  })
  .strict();

export const memoryImportWorkflowDispatchResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["started", "already_started", "outcome_unknown"]),
  })
  .strict();

export const memoryImportWorkflowReconcileResponseBase = {
  schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
  outboxId: outboxEntryIdSchema,
};

export const memoryImportWorkflowReconcileResponseSchema = z.discriminatedUnion("startBinding", [
  z
    .object({
      ...memoryImportWorkflowReconcileResponseBase,
      startBinding: z.literal("exists"),
      runStatus: z.enum(["active", "completed", "failed", "cancelled", "missing"]),
    })
    .strict(),
  z
    .object({
      ...memoryImportWorkflowReconcileResponseBase,
      startBinding: z.enum(["missing", "outcome_unknown"]),
    })
    .strict(),
]);

/* ---------- Workflow Memory Write 私有合同 ---------- */
