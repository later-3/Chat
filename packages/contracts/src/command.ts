import { z } from "zod";
import { commandIdSchema } from "./ids.js";

/**
 * 写命令Envelope。
 *
 * 不变量：
 * - 每个写命令必须携带`commandId`用于幂等；同一`commandId`重复提交返回原结果。
 * - `expectedRevision`是乐观并发控制；缺省表示命令针对新建资源或不敏感并发。
 * - Command响应返回被接纳的产品对象、revision和后续订阅位置；
 *   永远不返回Workflow Hook Token或pi Session ID。
 */
export const commandEnvelopeSchema = z.object({
  commandId: commandIdSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});

export const commandAcceptedSchema = z.object({
  revision: z.number().int().nonnegative(),
  /** 客户端可从该游标继续订阅Chat Realtime Feed。 */
  subscriptionCursor: z.string().min(1).optional(),
});

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type CommandAccepted = z.infer<typeof commandAcceptedSchema>;
