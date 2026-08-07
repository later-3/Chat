import { z } from "zod";
import {
  approvalRequestIdSchema,
  decisionIdSchema,
  productRunIdSchema,
  runAttemptIdSchema,
} from "@chat/contracts";

/**
 * PlanningExecutionWorkflow.v1的输入与Hook Payload合同。
 * Workflow只传递可序列化、经Zod校验的值或对象引用。
 */

export const planningExecutionWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal("planning-execution-workflow-input.v1"),
    productRunId: productRunIdSchema,
    /** workflow Run Attempt（Trace关联）。 */
    attemptId: runAttemptIdSchema,
    maxPlanRevisions: z.number().int().positive().max(20),
  })
  .strict();

export type PlanningExecutionWorkflowInput = z.infer<typeof planningExecutionWorkflowInputSchema>;

/** Hook Payload只携带已提交decisionRef信号；Workflow恢复后重新读取产品事实。 */
export const planDecisionHookPayloadSchema = z
  .object({
    schemaVersion: z.literal("plan-decision-hook-payload.v1"),
    productRunId: productRunIdSchema,
    approvalRequestId: approvalRequestIdSchema,
    decisionId: decisionIdSchema,
  })
  .strict();

export type PlanDecisionHookPayload = z.infer<typeof planDecisionHookPayloadSchema>;

/** 确定性Hook Token（仅后端私有）：productRunId + planRevision推导，不进入任何公开面。 */
export function decisionHookToken(productRunId: string, planRevision: number): string {
  return `pdh-${productRunId}-${String(planRevision)}`;
}
