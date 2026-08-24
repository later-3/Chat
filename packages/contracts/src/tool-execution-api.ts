import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  productRunIdSchema,
  toolExecutionDecisionIdSchema,
  toolExecutionIntentIdSchema,
  toolExecutionResultIdSchema,
} from "./ids.js";
import {
  capabilityEffectSchema,
  capabilityScopeRefSchema,
  resolvedCapabilitySnapshotSchema,
} from "./capability.js";
import {
  toolExecutionDecisionKindSchema,
  toolExecutionIntentStatusSchema,
  toolExecutionResultOutcomeSchema,
} from "./tool-execution.js";

export const toolExecutionIntentDtoSchema = z
  .object({
    schemaVersion: z.literal("chat-product-api.v1"),
    toolExecutionIntentId: toolExecutionIntentIdSchema,
    productRunId: productRunIdSchema,
    capability: resolvedCapabilitySnapshotSchema,
    toolCallId: z.string().min(1).max(160),
    inputDisplay: z.string().max(32_000),
    inputDisplayTruncated: z.boolean(),
    inputSha256: sha256Schema,
    scopeRef: capabilityScopeRefSchema,
    effect: capabilityEffectSchema,
    status: toolExecutionIntentStatusSchema,
    revision: z.number().int().positive(),
    allowedActions: z.array(z.enum(["approve", "reject"])).max(2),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const toolExecutionDecisionDtoSchema = z
  .object({
    schemaVersion: z.literal("chat-product-api.v1"),
    toolExecutionDecisionId: toolExecutionDecisionIdSchema,
    toolExecutionIntentId: toolExecutionIntentIdSchema,
    productRunId: productRunIdSchema,
    intentRevision: z.number().int().positive(),
    capabilityDescriptorSha256: sha256Schema,
    inputSha256: sha256Schema,
    scopeRef: capabilityScopeRefSchema,
    kind: toolExecutionDecisionKindSchema,
    explanation: z.string().min(1).max(2_000).optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const toolExecutionResultDtoSchema = z
  .object({
    schemaVersion: z.literal("chat-product-api.v1"),
    toolExecutionResultId: toolExecutionResultIdSchema,
    toolExecutionIntentId: toolExecutionIntentIdSchema,
    productRunId: productRunIdSchema,
    outcome: toolExecutionResultOutcomeSchema,
    resultSha256: sha256Schema.optional(),
    errorCode: z.string().min(1).max(80).optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const toolExecutionsResponseSchema = z
  .object({
    intents: z.array(toolExecutionIntentDtoSchema).max(1_000),
    decisions: z.array(toolExecutionDecisionDtoSchema).max(1_000),
    results: z.array(toolExecutionResultDtoSchema).max(1_000),
  })
  .strict();

/** 决定必须重复提交用户实际看到的全部绑定，旧页面不能批准新参数或新来源。 */
export const submitToolExecutionDecisionPayloadSchema = z
  .object({
    toolExecutionIntentId: toolExecutionIntentIdSchema,
    intentRevision: z.number().int().positive(),
    capabilityDescriptorSha256: sha256Schema,
    inputSha256: sha256Schema,
    scopeRef: capabilityScopeRefSchema,
    kind: toolExecutionDecisionKindSchema,
    explanation: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "approve" && value.explanation !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["explanation"],
        message: "approve不携带解释；解释只用于拒绝",
      });
    }
  });

export type ToolExecutionIntentDto = z.infer<typeof toolExecutionIntentDtoSchema>;
export type ToolExecutionDecisionDto = z.infer<typeof toolExecutionDecisionDtoSchema>;
export type ToolExecutionResultDto = z.infer<typeof toolExecutionResultDtoSchema>;
export type ToolExecutionsResponse = z.infer<typeof toolExecutionsResponseSchema>;
export type SubmitToolExecutionDecisionPayload = z.infer<
  typeof submitToolExecutionDecisionPayloadSchema
>;
