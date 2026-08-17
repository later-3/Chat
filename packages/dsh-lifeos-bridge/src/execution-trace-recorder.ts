import { SessionId, type SessionStore } from "@deepseek-ai/dsh-session";
import { ChatProductClient } from "./chat-client.ts";
import {
  LIFEOS_EXECUTION_TRACE_EVENT,
  type LifeosExecutionTraceEventData,
} from "./execution-trace-events.ts";

/**
 * 将Chat公开轨迹快照写入当前DSH Session的log-only事件。追加失败只影响展示，
 * 不得改变Product Run或模型流的成功/失败结果。
 */
export class ExecutionTraceRecorder {
  constructor(
    private readonly chat: ChatProductClient,
    private readonly sessions: SessionStore,
  ) {}

  async record(dshSessionId: string, productRunId: string, signal?: AbortSignal): Promise<void> {
    const session = this.sessions.get(SessionId(dshSessionId));
    if (session === undefined) return;
    const trace = await this.chat.getExecutionTrace(productRunId, signal);
    const previous = [...session.events]
      .reverse()
      .find(
        (event) =>
          event.type === LIFEOS_EXECUTION_TRACE_EVENT &&
          event.data.trace.productRunId === trace.productRunId,
      );
    if (
      previous?.type === LIFEOS_EXECUTION_TRACE_EVENT &&
      previous.data.trace.traceRevision === trace.traceRevision
    ) {
      return;
    }
    const data: LifeosExecutionTraceEventData = {
      eventKind: previous === undefined ? "start" : "update",
      trace,
    };
    session.append(LIFEOS_EXECUTION_TRACE_EVENT, data);
  }
}
