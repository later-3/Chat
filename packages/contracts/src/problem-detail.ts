import { z } from "zod";

/**
 * 稳定的Problem Detail错误族（RFC 9457形状 + Chat扩展字段）。
 *
 * 不变量：
 * - 用户可修复冲突、权限拒绝、结果未知和内部故障必须使用不同的`code`族。
 * - `requestId`用于跨日志关联，不包含任何密钥或正文。
 * - 浏览器只获得可执行的`recoveryAction`，不获得内部诊断。
 */
export const problemCodeSchema = z.enum([
  "validation_failed",
  "unauthenticated",
  "forbidden",
  "not_found",
  "revision_conflict",
  "command_replayed",
  "decision_expired",
  "decision_hash_mismatch",
  "outcome_unknown",
  "rate_limited",
  "internal",
]);

export const recoveryActionSchema = z.enum([
  "retry_same_command",
  "rehydrate_and_retry",
  "reauthenticate",
  "wait_for_reconciliation",
  "contact_support",
  "none",
]);

export const problemDetailSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: problemCodeSchema,
  requestId: z.string().min(1),
  retryable: z.boolean(),
  recoveryAction: recoveryActionSchema,
});

export type ProblemCode = z.infer<typeof problemCodeSchema>;
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;
export type ProblemDetail = z.infer<typeof problemDetailSchema>;
