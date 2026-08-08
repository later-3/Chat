import {
  commandIdSchema,
  createMemoryImportPayloadSchema,
  productRunIdSchema,
  productSessionIdSchema,
  submitMessagePayloadSchema,
  submitDecisionPayloadSchema,
  type CommandId,
  type CreateMemoryImportPayload,
  type ProductRunId,
  type SubmitDecisionPayload,
  type SubmitMessagePayload,
} from "@chat/contracts/public";
import { z } from "zod";

/**
 * 真实会话的浏览器本地定位与待确认发送（都不是产品事实）。
 *
 * - sessionId/bootstrapCommandId：首次幂等创建真实Session的定位信息，
 *   不是授权凭据。
 * - activeRunId：当前看护的Product Run公开定位ID，刷新后从服务端恢复状态。
 * - pendingSend：已发起但结果未知的完整Message Command payload + commandId，
 *   供用户手动重试复用同一commandId；v1记录只含text，读取时保持兼容。
 */

const SESSION_KEY = "chat:real-session:v1";
const BOOTSTRAP_KEY = "chat:real-bootstrap:v1";
const RUN_KEY_PREFIX = "chat:real-run:v1:";
const PENDING_SEND_PREFIX = "chat:pending-send:v1:";
const PENDING_DECISION_PREFIX = "chat:pending-decision:v1:";
const PENDING_MEMORY_IMPORT_PREFIX = "chat:pending-memory-import:v1:";

const storedSessionSchema = z
  .object({
    version: z.literal(1),
    sessionId: productSessionIdSchema,
    bootstrapCommandId: commandIdSchema,
  })
  .strict();

type StoredSession = z.infer<typeof storedSessionSchema>;

export function readStoredSession(storage: Storage): StoredSession | null {
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (raw === null) return null;
    return storedSessionSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

export function readBootstrapCommand(storage: Storage): CommandId | null {
  try {
    const value = storage.getItem(BOOTSTRAP_KEY);
    return value === null ? null : (commandIdSchema.safeParse(value).data ?? null);
  } catch {
    return null;
  }
}

export function writeBootstrapCommand(storage: Storage, commandId: CommandId): void {
  try {
    storage.setItem(BOOTSTRAP_KEY, commandId);
  } catch {
    // Storage不可用时只能在当前页面内保留幂等身份
  }
}

export function clearBootstrapCommand(storage: Storage): void {
  try {
    storage.removeItem(BOOTSTRAP_KEY);
  } catch {
    // 同上
  }
}

export function writeStoredSession(storage: Storage, session: StoredSession): void {
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage不可用时只保留在内存
  }
}

export function readActiveRunId(storage: Storage, sessionId: string): ProductRunId | null {
  try {
    const value = storage.getItem(`${RUN_KEY_PREFIX}${sessionId}`);
    return value === null ? null : (productRunIdSchema.safeParse(value).data ?? null);
  } catch {
    return null;
  }
}

export function writeActiveRunId(storage: Storage, sessionId: string, runId: string): void {
  try {
    storage.setItem(`${RUN_KEY_PREFIX}${sessionId}`, runId);
  } catch {
    // 同上
  }
}

export function clearActiveRunId(storage: Storage, sessionId: string): void {
  try {
    storage.removeItem(`${RUN_KEY_PREFIX}${sessionId}`);
  } catch {
    // 本地定位清理失败不改变服务端事实
  }
}

export type PendingSend =
  | { readonly version: 1; readonly text: string; readonly commandId: CommandId }
  | { readonly version: 2; readonly payload: SubmitMessagePayload; readonly commandId: CommandId };

const pendingSendSchema = z.discriminatedUnion("version", [
  z
    .object({
      version: z.literal(1),
      text: z.string().min(1).max(4000),
      commandId: commandIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      payload: submitMessagePayloadSchema,
      commandId: commandIdSchema,
    })
    .strict(),
]);

export function pendingSendPayload(pending: PendingSend): SubmitMessagePayload {
  return pending.version === 1 ? { text: pending.text } : pending.payload;
}

export function readPendingSend(storage: Storage, sessionId: string): PendingSend | null {
  try {
    const raw = storage.getItem(`${PENDING_SEND_PREFIX}${sessionId}`);
    if (raw === null) return null;
    return pendingSendSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

export interface PendingDecision {
  readonly version: 1;
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly expectedRunRevision: number;
  readonly payload: SubmitDecisionPayload;
}

const pendingDecisionSchema = z
  .object({
    version: z.literal(1),
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    expectedRunRevision: z.number().int().positive(),
    payload: submitDecisionPayloadSchema,
  })
  .strict();

export function readPendingDecision(storage: Storage, runId: string): PendingDecision | null {
  try {
    const raw = storage.getItem(`${PENDING_DECISION_PREFIX}${runId}`);
    return raw === null ? null : (pendingDecisionSchema.safeParse(JSON.parse(raw)).data ?? null);
  } catch {
    return null;
  }
}

export function writePendingDecision(storage: Storage, pending: PendingDecision): void {
  try {
    storage.setItem(`${PENDING_DECISION_PREFIX}${pending.productRunId}`, JSON.stringify(pending));
  } catch {
    // Storage不可用时只保留在内存
  }
}

export function clearPendingDecision(storage: Storage, runId: string): void {
  try {
    storage.removeItem(`${PENDING_DECISION_PREFIX}${runId}`);
  } catch {
    // 同上
  }
}

export interface PendingMemoryImport {
  readonly version: 1;
  readonly commandId: CommandId;
  readonly payload: CreateMemoryImportPayload;
}

const pendingMemoryImportSchema = z
  .object({
    version: z.literal(1),
    commandId: commandIdSchema,
    payload: createMemoryImportPayloadSchema,
  })
  .strict();

export function readPendingMemoryImport(
  storage: Storage,
  sessionId: string,
): PendingMemoryImport | null {
  try {
    const raw = storage.getItem(`${PENDING_MEMORY_IMPORT_PREFIX}${sessionId}`);
    return raw === null
      ? null
      : (pendingMemoryImportSchema.safeParse(JSON.parse(raw)).data ?? null);
  } catch {
    return null;
  }
}

export function writePendingMemoryImport(
  storage: Storage,
  sessionId: string,
  pending: PendingMemoryImport,
): void {
  try {
    storage.setItem(`${PENDING_MEMORY_IMPORT_PREFIX}${sessionId}`, JSON.stringify(pending));
  } catch {
    // Storage不可用时只保留在内存，服务端幂等仍是最终防线。
  }
}

export function clearPendingMemoryImport(storage: Storage, sessionId: string): void {
  try {
    storage.removeItem(`${PENDING_MEMORY_IMPORT_PREFIX}${sessionId}`);
  } catch {
    // 同上
  }
}

export function writePendingSend(storage: Storage, sessionId: string, pending: PendingSend): void {
  try {
    storage.setItem(`${PENDING_SEND_PREFIX}${sessionId}`, JSON.stringify(pending));
  } catch {
    // 同上
  }
}

export function clearPendingSend(storage: Storage, sessionId: string): void {
  try {
    storage.removeItem(`${PENDING_SEND_PREFIX}${sessionId}`);
  } catch {
    // 同上
  }
}
