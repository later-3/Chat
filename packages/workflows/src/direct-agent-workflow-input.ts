import { z } from "zod";
import {
  productRunIdSchema,
  promptReviewDecisionIdSchema,
  promptReviewRequestIdSchema,
  runAttemptIdSchema,
  sha256Schema,
  workflowRunSpecIdSchema,
} from "@chat/contracts";

/**
 * Direct Agent Workflow只接收产品身份与冻结RunSpec引用。用户消息、Provider Payload
 * 和审核正文都由Application/Product Store拥有，不能复制进Workflow checkpoint。
 */
export const directAgentWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal("direct-agent-workflow-input.v1"),
    productRunId: productRunIdSchema,
    workflowAttemptId: runAttemptIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
  })
  .strict();

export type DirectAgentWorkflowInput = z.infer<typeof directAgentWorkflowInputSchema>;

/**
 * 浏览器永远不持有Hook Token。Runtime只把已经提交到Product Store的Decision引用
 * 送进Hook；Workflow恢复后仍须通过私有Application Query重新校验完整绑定。
 */
export const promptReviewDecisionHookPayloadSchema = z
  .object({
    schemaVersion: z.literal("prompt-review-decision-hook-payload.v1"),
    productRunId: productRunIdSchema,
    promptReviewRequestId: promptReviewRequestIdSchema,
    promptReviewDecisionId: promptReviewDecisionIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
  })
  .strict();

export type PromptReviewDecisionHookPayload = z.infer<typeof promptReviewDecisionHookPayloadSchema>;

/** 每个Prompt Review Request拥有唯一耐久Hook，不复用Run级Token。 */
export function promptReviewHookToken(promptReviewRequestId: string): string {
  return `prh-${promptReviewRequestId}`;
}
