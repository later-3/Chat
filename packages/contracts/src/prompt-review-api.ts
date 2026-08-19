import { z } from "zod";
import {
  productRunIdSchema,
  promptReviewDecisionIdSchema,
  promptReviewRequestIdSchema,
} from "./ids.js";
import { sha256Schema } from "./hash.js";
import {
  PROMPT_REVIEW_CANONICAL_PAYLOAD_MAX_BYTES,
  promptReviewCanonicalPayloadJsonSchema,
  promptReviewDecisionKindSchema,
  promptReviewRendererVersionSchema,
  promptReviewEndpointHostSchema,
  promptReviewModelIdSchema,
  promptReviewProviderIdSchema,
  promptReviewRequestKindSchema,
  promptReviewRequestStatusSchema,
} from "./prompt-review.js";
import { DIRECT_AGENT_MAX_PROVIDER_REQUESTS } from "./versions.js";

/** Prompt Review公开Command；Run revision仍由通用Command Envelope的expectedRevision承载。 */
export const submitPromptReviewDecisionPayloadSchema = z
  .object({
    promptReviewRequestId: promptReviewRequestIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
    kind: promptReviewDecisionKindSchema,
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .check((ctx) => {
    if (ctx.value.kind === "approve" && ctx.value.reason !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "approve Prompt Review不允许reason",
        path: ["reason"],
      });
    }
  });

export const promptReviewAllowedActionSchema = z.enum(["approve", "reject"]);

export const promptReviewReadableSourceSchema = z
  .object({
    addedBy: z.string().min(1).max(160),
    sourceFiles: z.array(z.string().min(1).max(512)).min(1).max(16),
    explanation: z.string().min(1).max(1_000),
  })
  .strict();

export const promptReviewReadableSectionSchema = z
  .object({
    sectionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    kind: z.enum([
      "system_prompt",
      "user_message",
      "assistant_message",
      "tool_message",
      "other_message",
      "tool_definitions",
      "request_parameters",
    ]),
    title: z.string().min(1).max(160),
    payloadJsonPointer: z.string().min(1).max(256),
    /** content与otherFieldsJson都来自真实Payload；来源说明不在这两个字段中。 */
    content: z.string().max(PROMPT_REVIEW_CANONICAL_PAYLOAD_MAX_BYTES * 2),
    contentFormat: z.enum(["text", "json"]),
    otherFieldsJson: z
      .string()
      .max(PROMPT_REVIEW_CANONICAL_PAYLOAD_MAX_BYTES * 2)
      .optional(),
    sources: z.array(promptReviewReadableSourceSchema).min(1).max(8),
  })
  .strict();

/**
 * Query同时返回原始canonical JSON与确定性可读投影。只有canonical JSON持久化；
 * `readablePrompt`由服务端按rendererVersion生成，因此不会建立第二份正文事实。
 */
export const promptReviewRequestDtoSchema = z
  .object({
    schemaVersion: z.literal("chat-product-api.v1"),
    promptReviewRequestId: promptReviewRequestIdSchema,
    productRunId: productRunIdSchema,
    requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    requestKind: promptReviewRequestKindSchema,
    providerId: promptReviewProviderIdSchema,
    modelId: promptReviewModelIdSchema,
    endpointHost: promptReviewEndpointHostSchema,
    requestRevision: z.number().int().positive(),
    status: promptReviewRequestStatusSchema,
    canonicalPayloadJson: promptReviewCanonicalPayloadJsonSchema,
    readablePrompt: z.string().max(PROMPT_REVIEW_CANONICAL_PAYLOAD_MAX_BYTES * 2),
    /** UI分区投影；sources只是来源标注，content才是对应的真实请求字段。 */
    readableSections: z.array(promptReviewReadableSectionSchema).min(1).max(128),
    rendererVersion: promptReviewRendererVersionSchema,
    payloadSha256: sha256Schema,
    reviewSha256: sha256Schema,
    allowedActions: z.array(promptReviewAllowedActionSchema).max(2),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const promptReviewDecisionDtoSchema = z
  .object({
    schemaVersion: z.literal("chat-product-api.v1"),
    promptReviewDecisionId: promptReviewDecisionIdSchema,
    promptReviewRequestId: promptReviewRequestIdSchema,
    productRunId: productRunIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
    kind: promptReviewDecisionKindSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const currentPromptReviewResponseSchema = z
  .object({ promptReview: promptReviewRequestDtoSchema.nullable() })
  .strict();

export type SubmitPromptReviewDecisionPayload = z.infer<
  typeof submitPromptReviewDecisionPayloadSchema
>;
export type PromptReviewAllowedAction = z.infer<typeof promptReviewAllowedActionSchema>;
export type PromptReviewReadableSource = z.infer<typeof promptReviewReadableSourceSchema>;
export type PromptReviewReadableSection = z.infer<typeof promptReviewReadableSectionSchema>;
export type PromptReviewRequestDto = z.infer<typeof promptReviewRequestDtoSchema>;
export type PromptReviewDecisionDto = z.infer<typeof promptReviewDecisionDtoSchema>;
export type CurrentPromptReviewResponse = z.infer<typeof currentPromptReviewResponseSchema>;
