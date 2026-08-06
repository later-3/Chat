import { z } from "zod";

/**
 * 带前缀的产品ID合同。
 *
 * 不变量：
 * - ID由服务端Product Store分配，浏览器只持有、不构造权威ID。
 * - 浏览器可见的ID仅限此文件导出的产品身份；Workflow Run ID、Hook Token、
 *   Checkpoint ID和pi Runtime Session ID永远不会出现在公开合同中。
 */
const prefixedId = <Prefix extends string>(prefix: Prefix) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`), `expected id with prefix "${prefix}_"`)
    .brand(prefix);

export const productSessionIdSchema = prefixedId("psn");
export const interactionIdSchema = prefixedId("ixn");
export const messageIdSchema = prefixedId("msg");
export const productRunIdSchema = prefixedId("run");
export const runAttemptIdSchema = prefixedId("att");
export const approvalRequestIdSchema = prefixedId("apr");
export const commandIdSchema = prefixedId("cmd");
export const workflowDefinitionIdSchema = prefixedId("wfd");
export const projectIdSchema = prefixedId("prj");

export type ProductSessionId = z.infer<typeof productSessionIdSchema>;
export type InteractionId = z.infer<typeof interactionIdSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type ProductRunId = z.infer<typeof productRunIdSchema>;
export type RunAttemptId = z.infer<typeof runAttemptIdSchema>;
export type ApprovalRequestId = z.infer<typeof approvalRequestIdSchema>;
export type CommandId = z.infer<typeof commandIdSchema>;
export type WorkflowDefinitionId = z.infer<typeof workflowDefinitionIdSchema>;
export type ProjectId = z.infer<typeof projectIdSchema>;
