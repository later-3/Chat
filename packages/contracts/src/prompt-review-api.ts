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
export type PromptReviewRequestDto = z.infer<typeof promptReviewRequestDtoSchema>;
export type PromptReviewDecisionDto = z.infer<typeof promptReviewDecisionDtoSchema>;
export type CurrentPromptReviewResponse = z.infer<typeof currentPromptReviewResponseSchema>;
