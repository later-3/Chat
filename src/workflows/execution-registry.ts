/**
 * 进程内 Session 执行登记表。
 *
 * durable 记录（Run 绑定、planning record、run status）只是"意图账本"：
 * 它们在 Run 被接受时写入，进程崩溃后无人推进到终态，不能当作存活信号。
 * "agent 是否正在响应这个 Session"的唯一真源是执行发生的进程——Workflow
 * 函数体覆盖整个 Run 生命周期（执行中、step 间隙、挂起等待审核），进入时
 * 登记、返回或抛出时注销；进程崩溃则登记表随进程一起消失（等价于空闲）。
 *
 * 通过 `Symbol.for` 挂在 globalThis 上：Workflow bundle 可能把这个模块
 * 内联进 step 产物，而 API 路由从源码解析另一份实例，globalThis 保证两者
 * 解析到同一个注册表。
 */
export interface SessionExecutionRecord {
  readonly workflowId: string;
  readonly workflowInvocationId: string;
  readonly startedAt: string;
}

interface SessionExecutionRegistry {
  readonly executing: Map<string, SessionExecutionRecord>;
}

const registryKey = Symbol.for("chat.sessionExecutionRegistry");

const registry = ((globalThis as Record<PropertyKey, unknown>)[registryKey] ??= {
  executing: new Map<string, SessionExecutionRecord>(),
}) as SessionExecutionRegistry;

/** Workflow 函数体进入时登记：agent 开始响应这个 Session。 */
export function beginSessionExecution(
  sessionId: string,
  workflowId: string,
  workflowInvocationId: string,
): void {
  registry.executing.set(sessionId, {
    workflowId,
    workflowInvocationId,
    startedAt: new Date().toISOString(),
  });
}

/** Workflow 函数体返回或抛出时注销；只清除自己那次执行，防止误清新登记。 */
export function endSessionExecution(sessionId: string, workflowInvocationId: string): void {
  const current = registry.executing.get(sessionId);
  if (current?.workflowInvocationId === workflowInvocationId) {
    registry.executing.delete(sessionId);
  }
}

export function getSessionExecution(sessionId: string): SessionExecutionRecord | undefined {
  return registry.executing.get(sessionId);
}
