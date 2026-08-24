import { z } from "zod";
import {
  commandIdSchema,
  principalIdSchema,
  productRunIdSchema,
  runAttemptIdSchema,
  toolExecutionDecisionIdSchema,
  toolExecutionIntentIdSchema,
  toolExecutionResultIdSchema,
} from "./ids.js";
import { sha256Schema } from "./hash.js";
import {
  capabilityEffectSchema,
  capabilityScopeRefSchema,
  resolvedCapabilitySnapshotSchema,
} from "./capability.js";

export const TOOL_EXECUTION_INTENT_SCHEMA_VERSION = "tool-execution-intent.v1" as const;
export const TOOL_EXECUTION_DECISION_SCHEMA_VERSION = "tool-execution-decision.v1" as const;
export const TOOL_EXECUTION_RESULT_SCHEMA_VERSION = "tool-execution-result.v1" as const;

export const toolExecutionIntentStatusSchema = z.enum([
  "waiting_decision",
  "approved",
  "rejected",
  "dispatching",
  "completed",
  "failed",
  "outcome_unknown",
  "not_executed",
]);

export const toolExecutionDecisionKindSchema = z.enum(["approve", "reject"]);
export const toolExecutionResultOutcomeSchema = z.enum(["completed", "failed", "outcome_unknown"]);

/**
 * Product Store只保存审核与Product Commit需要的安全投影。Pi Operation完整Journal仍由
 * Executor拥有；`runtimeOperationRefSha256`只用于关联，不把私有Operation ID公开化。
 */
export const toolExecutionIntentSchema = z
  .object({
    schemaVersion: z.literal(TOOL_EXECUTION_INTENT_SCHEMA_VERSION),
    toolExecutionIntentId: toolExecutionIntentIdSchema,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    runtimeOperationRefSha256: sha256Schema,
    capability: resolvedCapabilitySnapshotSchema,
    toolCallId: z.string().min(1).max(160),
    inputDisplay: z.string().max(32_000),
    inputDisplayTruncated: z.boolean(),
    inputSha256: sha256Schema,
    scopeRef: capabilityScopeRefSchema,
    effect: capabilityEffectSchema,
    revision: z.number().int().positive(),
    status: toolExecutionIntentStatusSchema,
    decidedByToolExecutionDecisionId: toolExecutionDecisionIdSchema.optional(),
    resultId: toolExecutionResultIdSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.effect === "read") {
      ctx.addIssue({
        code: "custom",
        path: ["effect"],
        message: "只读Tool不创建高影响动作审核Intent",
      });
    }
    if (value.effect !== value.capability.effect) {
      ctx.addIssue({
        code: "custom",
        path: ["effect"],
        message: "Tool Intent effect必须与Resolved Capability一致",
      });
    }
    if (JSON.stringify(value.scopeRef) !== JSON.stringify(value.capability.ref.scopeRef)) {
      ctx.addIssue({
        code: "custom",
        path: ["scopeRef"],
        message: "Tool Intent scope必须与Resolved Capability一致",
      });
    }
  });

export const toolExecutionDecisionSchema = z
  .object({
    schemaVersion: z.literal(TOOL_EXECUTION_DECISION_SCHEMA_VERSION),
    toolExecutionDecisionId: toolExecutionDecisionIdSchema,
    toolExecutionIntentId: toolExecutionIntentIdSchema,
    productRunId: productRunIdSchema,
    intentRevision: z.number().int().positive(),
    capabilityDescriptorSha256: sha256Schema,
    inputSha256: sha256Schema,
    scopeRef: capabilityScopeRefSchema,
    kind: toolExecutionDecisionKindSchema,
    principalId: principalIdSchema,
    explanation: z.string().trim().min(1).max(2_000).optional(),
    commandId: commandIdSchema,
    sha256: sha256Schema,
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const toolExecutionEvidenceRefSchema = z
  .object({
    kind: z.enum(["pi_journal_result", "product_fact", "external_receipt"]),
    refSha256: sha256Schema,
  })
  .strict();

export const toolExecutionResultSchema = z
  .object({
    schemaVersion: z.literal(TOOL_EXECUTION_RESULT_SCHEMA_VERSION),
    toolExecutionResultId: toolExecutionResultIdSchema,
    toolExecutionIntentId: toolExecutionIntentIdSchema,
    productRunId: productRunIdSchema,
    outcome: toolExecutionResultOutcomeSchema,
    resultSha256: sha256Schema.optional(),
    evidenceRefs: z.array(toolExecutionEvidenceRefSchema).max(20),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
      .max(80)
      .optional(),
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === "completed" && value.resultSha256 === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["resultSha256"],
        message: "成功Tool结果必须绑定结果Hash",
      });
    }
    if (value.outcome === "failed" && value.errorCode === undefined) {
      ctx.addIssue({ code: "custom", path: ["errorCode"], message: "失败Tool结果必须有错误码" });
    }
    if (
      (value.outcome === "completed" || value.outcome === "failed") &&
      (value.evidenceRefs.length !== 1 || value.evidenceRefs[0]?.kind !== "pi_journal_result")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "已执行Tool终态必须精确引用唯一Pi Journal Result",
      });
    }
  });

export type ToolExecutionIntent = z.infer<typeof toolExecutionIntentSchema>;
export type ToolExecutionDecision = z.infer<typeof toolExecutionDecisionSchema>;
export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>;
export type ToolExecutionIntentStatus = z.infer<typeof toolExecutionIntentStatusSchema>;
export type ToolExecutionDecisionKind = z.infer<typeof toolExecutionDecisionKindSchema>;
