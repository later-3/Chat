import type { WorkflowExecutionTraceDto } from "@chat/contracts/public";
import type { ConversationNodeDefinition } from "@deepseek-ai/dsh-client-runtime/client";
import type { LifeosExecutionTrace } from "../contracts.ts";
import {
  registerExecutionTraceDefinition,
  type ExecutionTraceViewOptions,
} from "./execution-trace-definition.ts";

interface ConversationRegistryContext {
  readonly conversationEvents: {
    register(definition: ConversationNodeDefinition): () => void;
  };
}

function fingerprint(traces: readonly LifeosExecutionTrace[]): string {
  return traces
    .map(
      ({ dshMessageId, trace }) =>
        `${dshMessageId}\u0000${String(trace.productRunId)}\u0000${trace.traceRevision}`,
    )
    .sort()
    .join("\u0001");
}

/**
 * 聚合各DSH Session从Chat公开Query读取的轨迹，并通过DSH公开Conversation
 * Definition接缝重投影。这里只保存浏览器内的可恢复缓存；刷新或重启后由
 * Bridge的消息绑定重新查询，绝不向DSH Session日志制造第二套事实。
 */
export class ExecutionTraceProjection {
  private readonly tracesBySession = new Map<string, readonly LifeosExecutionTrace[]>();
  private readonly fingerprints = new Map<string, string>();
  private traceByMessage = new Map<string, WorkflowExecutionTraceDto>();
  private disposeDefinition: () => void;
  private options: ExecutionTraceViewOptions;
  private disposed = false;

  constructor(
    private readonly ctx: ConversationRegistryContext,
    options: ExecutionTraceViewOptions = {},
  ) {
    this.options = options;
    this.disposeDefinition = this.register();
  }

  replace(sessionId: string, traces: readonly LifeosExecutionTrace[]): void {
    if (this.disposed) return;
    const nextFingerprint = fingerprint(traces);
    if (this.fingerprints.get(sessionId) === nextFingerprint) return;
    this.fingerprints.set(sessionId, nextFingerprint);
    this.tracesBySession.set(sessionId, traces);
    this.rebuild();
  }

  remove(sessionId: string): void {
    if (this.disposed || !this.tracesBySession.delete(sessionId)) return;
    this.fingerprints.delete(sessionId);
    this.rebuild();
  }

  setOptions(options: ExecutionTraceViewOptions): void {
    if (this.disposed || options.showTimestamps === this.options.showTimestamps) return;
    this.options = options;
    this.rebuild();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeDefinition();
    this.tracesBySession.clear();
    this.fingerprints.clear();
    this.traceByMessage.clear();
  }

  private register(): () => void {
    return registerExecutionTraceDefinition(
      this.ctx,
      (dshMessageId) => this.traceByMessage.get(dshMessageId),
      this.options,
    );
  }

  private rebuild(): void {
    const next = new Map<string, WorkflowExecutionTraceDto>();
    for (const traces of this.tracesBySession.values()) {
      for (const { dshMessageId, trace } of traces) next.set(dshMessageId, trace);
    }
    this.traceByMessage = next;
    // Definition Registry是DSH为低频规则变化提供的公开重投影边界。替换定义会让
    // 已打开Session按原生user/message窗口重建，不触碰事件日志或Trajectory DOM。
    this.disposeDefinition();
    this.disposeDefinition = this.register();
  }
}
