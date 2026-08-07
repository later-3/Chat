import type { TraceEventInput } from "@chat/contracts";
import type { BailianConfig, runPiExecutor, runPiPlanner } from "@chat/pi-runtime";
import type { RuntimeApiClient } from "./api-client.js";
import type { RuntimeBindingStore } from "./runtime-bindings.js";

/**
 * Workflow Runtime进程级上下文。
 *
 * Workflow Step在运行时进程内执行，通过本上下文访问私有API客户端、
 * Runtime Binding、Trace与pi实现。测试注入确定性pi实现与临时目录；
 * 生产注入真实百炼配置。上下文由组合根在启动World之前设置。
 *
 * 注意：Step bundle经esbuild打包后拥有独立的模块实例，因此上下文挂在
 * globalThis（Symbol.for）上，保证bundle内外的Step看到同一份组合根注入。
 */

export interface WorkflowRuntimeContext {
  readonly api: RuntimeApiClient;
  readonly bindings: RuntimeBindingStore;
  readonly trace: (event: TraceEventInput) => void;
  readonly now: () => string;
  readonly bailian: BailianConfig;
  readonly planner: typeof runPiPlanner;
  readonly executor: typeof runPiExecutor;
}

const CONTEXT_KEY = Symbol.for("chat.workflowRuntimeContext");

function contextSlot(): Record<PropertyKey, unknown> {
  return globalThis as Record<PropertyKey, unknown>;
}

export function setWorkflowRuntimeContext(context: WorkflowRuntimeContext | undefined): void {
  contextSlot()[CONTEXT_KEY] = context;
}

export function getWorkflowRuntimeContext(): WorkflowRuntimeContext {
  const current = contextSlot()[CONTEXT_KEY] as WorkflowRuntimeContext | undefined;
  if (current === undefined) {
    throw new Error("WorkflowRuntimeContext未初始化：必须在启动World前由组合根设置");
  }
  return current;
}

/** Trace辅助：同一Product Run共享确定性traceId（由公开ID推导）。 */
export function workflowRunTraceId(productRunId: string): string {
  return `tr_${productRunId.slice(4)}`;
}

let spanCounter = 0;
export function workflowSpanId(): string {
  spanCounter += 1;
  return `sp_wf${spanCounter.toString(36)}${Date.now().toString(36)}`;
}
