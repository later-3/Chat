import { z } from "zod";
import { productRunIdSchema, productSessionIdSchema, runAttemptIdSchema } from "./ids.js";

/**
 * AG-UI兼容事件Payload（P0结构子集）。
 *
 * 与技术合同§7.3对齐：这里定义的是Chat Realtime Feed采用的AG-UI兼容语义
 * 的最小结构子集，用于固定Envelope形状和依赖方向。P1实现Runtime Journal与
 * pi事件归一化时将引入`@ag-ui/core`并把此联合类型与官方Schema对齐测试。
 *
 * 不变量：
 * - AG-UI事件只投影运行进度；Product Run终态只由服务端产品提交产生。
 * - Product资源变化通过`CUSTOM`事件发出失效提示，完整数据仍由Query读取。
 */
const aguiBase = {
  /** AG-UI事件类型名，例如`RUN_STARTED`。 */
  type: z.string().min(1),
  /** 透传字段，与AG-UI `rawEvent`对应；不保存模型隐藏推理。 */
  timestamp: z.string().min(1).optional(),
};

export const runStartedPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("RUN_STARTED"),
});

export const runFinishedPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("RUN_FINISHED"),
});

export const runErrorPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("RUN_ERROR"),
  message: z.string().min(1),
  code: z.string().min(1).optional(),
});

export const stepStartedPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("STEP_STARTED"),
  stepName: z.string().min(1),
});

export const stepFinishedPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("STEP_FINISHED"),
  stepName: z.string().min(1),
});

export const textMessageStartPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("TEXT_MESSAGE_START"),
  messageId: z.string().min(1),
  role: z.literal("assistant"),
});

export const textMessageContentPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("TEXT_MESSAGE_CONTENT"),
  messageId: z.string().min(1),
  delta: z.string(),
});

export const textMessageEndPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("TEXT_MESSAGE_END"),
  messageId: z.string().min(1),
});

/** Product资源失效提示等Chat自有扩展事件。 */
export const customPayloadSchema = z.object({
  ...aguiBase,
  type: z.literal("CUSTOM"),
  name: z.string().min(1),
  value: z.unknown(),
});

export const agUiCompatibleEventSchema = z.discriminatedUnion("type", [
  runStartedPayloadSchema,
  runFinishedPayloadSchema,
  runErrorPayloadSchema,
  stepStartedPayloadSchema,
  stepFinishedPayloadSchema,
  textMessageStartPayloadSchema,
  textMessageContentPayloadSchema,
  textMessageEndPayloadSchema,
  customPayloadSchema,
]);

/**
 * Chat Realtime Feed的公开事件Envelope。
 *
 * 不变量：
 * - `sequence`在单个Product Run中严格递增。
 * - 相同`eventId`重放必须内容一致。
 * - 浏览器发现缺口或同序号不同内容时停止应用Delta并重新Hydrate。
 * - Envelope只携带浏览器允许知道的身份；不含Workflow Run ID、
 *   Hook Token、Checkpoint ID或pi Session ID。
 */
export const chatEventEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("1"),
    eventId: z.string().min(1),
    sequence: z.number().int().positive(),
    occurredAt: z.string().min(1),
    productSessionId: productSessionIdSchema,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema.optional(),
    payload: agUiCompatibleEventSchema,
  })
  // strict：拒绝Workflow Run ID、Hook Token等运行时私有身份混入公开Envelope。
  .strict();

export type AgUiCompatibleEvent = z.infer<typeof agUiCompatibleEventSchema>;
export type ChatEventEnvelope = z.infer<typeof chatEventEnvelopeSchema>;
