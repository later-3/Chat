import { randomUUID } from "node:crypto";
import type { MemoryImportIntentId, ProductRunId, TraceEventInput } from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";

/**
 * 用例层Trace发射助手。
 *
 * 关联规则：同一Product Run的全部用例事件共享确定性traceId
 * （由公开productRunId推导，不含Runtime私有身份）；spanId随机。
 * Trace发射失败不得影响业务：发射器由组合根保证安全，本层不catch。
 */

export function runTraceId(productRunId: ProductRunId): string {
  return `tr_${productRunId.slice(4)}`;
}

/** Memory Import没有Product Run；以不可变Intent身份建立独立Trace时间线。 */
export function memoryImportTraceId(memoryImportIntentId: MemoryImportIntentId): string {
  return `tr_${memoryImportIntentId.slice(4)}`;
}

export function newSpanId(): string {
  return `sp_${randomUUID().replaceAll("-", "")}`;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 由emitRunEvent补齐traceId/spanId的事件输入；仍然是逐事件严格联合。 */
export type RunTraceEventInput = DistributiveOmit<TraceEventInput, "traceId" | "spanId">;

export function emitRunEvent(
  deps: ApplicationDeps,
  productRunId: ProductRunId,
  event: RunTraceEventInput,
): void {
  if (deps.trace === undefined) return;
  const full = { ...event, traceId: runTraceId(productRunId), spanId: newSpanId() };
  deps.trace(full);
}

export function emitMemoryImportEvent(
  deps: ApplicationDeps,
  memoryImportIntentId: MemoryImportIntentId,
  event: RunTraceEventInput,
): void {
  if (deps.trace === undefined) return;
  const full = {
    ...event,
    traceId: memoryImportTraceId(memoryImportIntentId),
    spanId: newSpanId(),
  };
  deps.trace(full);
}

export function safeErrorType(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)) return error.name;
  return "Error";
}
