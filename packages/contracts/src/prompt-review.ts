import { z } from "zod";
import {
  commandIdSchema,
  principalIdSchema,
  productRunIdSchema,
  promptReviewDecisionIdSchema,
  promptReviewRequestIdSchema,
  runAttemptIdSchema,
} from "./ids.js";
import { sha256Schema } from "./hash.js";
import { DIRECT_AGENT_MAX_PROVIDER_REQUESTS } from "./versions.js";

/**
 * Prompt Review权威产品事实。
 *
 * `canonicalPayloadJson`是Provider网络边界前已经去除Credential、HTTP Header与
 * 隐藏推理的最终JSON正文。原文只在这里保存一次；可读版由固定Renderer按需投影，
 * Trace、Workflow Checkpoint与Pi Journal只能保存Request引用、revision和Hash。
 */
export const PROMPT_REVIEW_CANONICAL_PAYLOAD_MAX_BYTES = 1024 * 1024;
export const PROMPT_REVIEW_READABLE_RENDERER_VERSION = "prompt-readable.v1" as const;

function isBoundedJsonObject(value: string): boolean {
  if (utf8ByteLength(value) > PROMPT_REVIEW_CANONICAL_PAYLOAD_MAX_BYTES) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Contracts同时运行于Node与浏览器Bundle，不能依赖Buffer或DOM TextEncoder类型。 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > PROMPT_REVIEW_CANONICAL_PAYLOAD_MAX_BYTES) return bytes;
  }
  return bytes;
}

export const promptReviewCanonicalPayloadJsonSchema = z
  .string()
  .min(2)
  .refine(isBoundedJsonObject, "Prompt Review Payload必须是至多1MiB的JSON对象");

export const promptReviewRendererVersionSchema = z.literal(PROMPT_REVIEW_READABLE_RENDERER_VERSION);

export const promptReviewRequestStatusSchema = z.enum([
  "open",
  "approved",
  "rejected",
  "dispatching",
  "dispatched",
  "outcome_unknown",
  "cancelled",
]);

export const promptReviewDecisionKindSchema = z.enum(["approve", "reject"]);
export const promptReviewRequestKindSchema = z.enum(["agent_turn", "compaction", "retry"]);
export const promptReviewProviderIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
export const promptReviewModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
/** 只允许hostname，不接受scheme、userinfo、port、path或query。 */
export const promptReviewEndpointHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u,
  );

export const promptReviewRequestSchema = z
  .object({
    schemaVersion: z.literal("prompt-review-request.v1"),
    promptReviewRequestId: promptReviewRequestIdSchema,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    /** 同一Direct Agent Attempt内从1开始连续递增；恢复或重放不能产生第二个序号。 */
    requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    requestKind: promptReviewRequestKindSchema,
    providerId: promptReviewProviderIdSchema,
    modelId: promptReviewModelIdSchema,
    endpointHost: promptReviewEndpointHostSchema,
    /** 审核正文业务版本；状态revision变化时它保持不变。 */
    requestRevision: z.number().int().positive(),
    status: promptReviewRequestStatusSchema,
    canonicalPayloadJson: promptReviewCanonicalPayloadJsonSchema,
    /** 对最终实际发送JSON语义计算的版本化canonical SHA-256。 */
    payloadSha256: sha256Schema,
    rendererVersion: promptReviewRendererVersionSchema,
    /** 覆盖Request身份、版本、Payload Hash与Renderer版本，供Decision绑定。 */
    reviewSha256: sha256Schema,
    decidedByPromptReviewDecisionId: promptReviewDecisionIdSchema.optional(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .check((ctx) => {
    const value = ctx.value;
    const hasDecision = value.decidedByPromptReviewDecisionId !== undefined;
    const forbidsDecision = value.status === "open";
    const requiresDecision = value.status !== "open" && value.status !== "cancelled";
    if ((forbidsDecision && hasDecision) || (requiresDecision && !hasDecision)) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "open Prompt Review不得有Decision；非cancelled终态必须绑定Decision",
        path: ["decidedByPromptReviewDecisionId"],
      });
    }
  });

export const promptReviewDecisionSchema = z
  .object({
    schemaVersion: z.literal("prompt-review-decision.v1"),
    promptReviewDecisionId: promptReviewDecisionIdSchema,
    promptReviewRequestId: promptReviewRequestIdSchema,
    productRunId: productRunIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
    kind: promptReviewDecisionKindSchema,
    reason: z.string().trim().min(1).max(2000).optional(),
    principalId: principalIdSchema,
    commandId: commandIdSchema,
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
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

export type PromptReviewRequestStatus = z.infer<typeof promptReviewRequestStatusSchema>;
export type PromptReviewDecisionKind = z.infer<typeof promptReviewDecisionKindSchema>;
export type PromptReviewRequestKind = z.infer<typeof promptReviewRequestKindSchema>;
export type PromptReviewRequest = z.infer<typeof promptReviewRequestSchema>;
export type PromptReviewDecision = z.infer<typeof promptReviewDecisionSchema>;
