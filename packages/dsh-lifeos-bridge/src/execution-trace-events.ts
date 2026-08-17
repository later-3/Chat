import type { ExecutionTraceDto } from "@chat/contracts/public";

export const LIFEOS_EXECUTION_TRACE_EVENT = "lifeos/execution-trace" as const;

export interface LifeosExecutionTraceEventData {
  readonly eventKind: "start" | "update";
  readonly trace: ExecutionTraceDto;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    /**
     * DSH日志只保存Chat公开轨迹投影。它不是产品事实，也不进入LLM Surface；
     * Product Store、Vercel World与严格Trace仍分别拥有自己的权威事实。
     */
    "lifeos/execution-trace": LifeosExecutionTraceEventData;
  }
}
