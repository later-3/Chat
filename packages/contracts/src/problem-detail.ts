import { z } from "zod";

/**
 * 稳定的Problem Detail错误族（RFC 9457形状 + Chat扩展字段）。
 *
 * 错误族与B2任务书§12.5冻结清单一一对应（小写snake_case形式）：
 * 用户可修复冲突、权限拒绝、结果未知和内部故障必须是不同的`code`族。
 * `requestId`用于跨日志关联，不包含任何密钥或正文。
 * 浏览器只根据`code + recoveryAction`呈现可执行动作，不解析错误文本。
 */
export const problemCodeSchema = z.enum([
  "validation_failed",
  "unauthenticated",
  "forbidden",
  "not_found",
  "revision_conflict",
  "plan_hash_conflict",
  "approval_expired",
  "approval_already_decided",
  "command_id_reused",
  "workflow_dispatch_unknown",
  "workflow_resume_unknown",
  "provider_auth_failed",
  "provider_rate_limited",
  "provider_timeout",
  "provider_stream_interrupted",
  "model_candidate_invalid",
  "product_commit_failed",
  "store_corrupted",
  "outcome_unknown",
  "internal_error",
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
