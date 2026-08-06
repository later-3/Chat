import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core";
import { z } from "zod";
import { productRunIdSchema, productSessionIdSchema, runAttemptIdSchema } from "./ids.js";

/**
 * AG-UI兼容事件Payload。
 *
 * 运行时校验直接使用官方`@ag-ui/core`的Zod Schema（版本证据清单固定版本），
 * 保证字段级兼容：例如`timestamp`为可选epoch毫秒数字，`RUN_STARTED`/
 * `RUN_FINISHED`携带必需的`threadId`与`runId`。
 *
 * ID映射（不变量）：
 * - Payload的`threadId`映射Product Session ID，`runId`映射Product Run ID。
 * - Envelope上的`productSessionId`/`productRunId`是品牌类型权威身份；
 *   Runtime Adapter（P1）负责断言两者一致，不引入第二套身份。
 *
 * 采用范围（技术合同§7.3）：
 * - 采用：Run、Step、文本消息流、Tool Call/Result投影、Activity进度、
 *   State/Message Snapshot、Interrupt相关与CUSTOM扩展事件。
 * - 排除：`REASONING_*`/`THINKING_*`（隐藏推理不进入Trace与事件流）和
 *   `RAW`（原始Provider事件透传不属于公开投影）。
 */
const excludedEventTypes: ReadonlySet<string> = new Set<string>([
  EventType.THINKING_START,
  EventType.THINKING_END,
  EventType.THINKING_TEXT_MESSAGE_START,
  EventType.THINKING_TEXT_MESSAGE_CONTENT,
  EventType.THINKING_TEXT_MESSAGE_END,
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
  EventType.REASONING_ENCRYPTED_VALUE,
  EventType.RAW,
]);

export const adoptedEventTypes: readonly EventType[] = Object.values(EventType).filter(
  (type) => !excludedEventTypes.has(type),
);

const adoptedTypeSet: ReadonlySet<string> = new Set<string>(adoptedEventTypes);

type ExcludedEventType =
  | EventType.THINKING_START
  | EventType.THINKING_END
  | EventType.THINKING_TEXT_MESSAGE_START
  | EventType.THINKING_TEXT_MESSAGE_CONTENT
  | EventType.THINKING_TEXT_MESSAGE_END
  | EventType.REASONING_START
  | EventType.REASONING_MESSAGE_START
  | EventType.REASONING_MESSAGE_CONTENT
  | EventType.REASONING_MESSAGE_END
  | EventType.REASONING_MESSAGE_CHUNK
  | EventType.REASONING_END
  | EventType.REASONING_ENCRYPTED_VALUE
  | EventType.RAW;

export type AgUiCompatibleEvent = Exclude<AGUIEvent, { type: ExcludedEventType }>;

/**
 * 已采用AG-UI事件的运行时合同：官方Schema校验 + 采用范围过滤。
 * 官方事件Schema为passthrough，允许Adapter附加投影字段。
 */
export const agUiCompatibleEventSchema = z.custom<AgUiCompatibleEvent>((value) => {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !adoptedTypeSet.has(type)) return false;
  return EventSchemas.safeParse(value).success;
}, "expected an adopted AG-UI event matching the official @ag-ui/core schema");

/**
 * Chat Realtime Feed的公开事件Envelope。
 *
 * 不变量：
 * - `sequence`在单个Product Run中严格递增。
 * - 相同`eventId`重放必须内容一致。
 * - 浏览器发现缺口或同序号不同内容时停止应用Delta并重新Hydrate。
 * - Envelope只携带浏览器允许知道的身份；strict模式拒绝Workflow Run ID、
 *   Hook Token、Checkpoint ID或pi Session ID混入公开事件。
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
  .strict();

export type ChatEventEnvelope = z.infer<typeof chatEventEnvelopeSchema>;
