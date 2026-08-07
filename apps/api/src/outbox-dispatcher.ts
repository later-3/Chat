import {
  WORKFLOW_DEFINITION_VERSION,
  workflowResumeResponseSchema,
  workflowReconcileResponseSchema,
  workflowStartResponseSchema,
  type CommandId,
  type OutboxEntry,
  type ProductSnapshot,
} from "@chat/contracts";
import { updateOutboxStatus, type ApplicationDeps } from "@chat/application";
import { sha256Hex } from "@chat/domain";

/**
 * Outbox Dispatcher（任务书§10、§14.1）。
 *
 * API进程内的跨边界派发器：
 * - workflow_start：调用Workflow Runtime start；Runtime用productRunId幂等认领。
 * - workflow_resume：调用Workflow Runtime resume，仅携带decisionRef。
 * - 网络结果未知进入outcome_unknown；对账后决定重派或标记，不盲目新建
 *   第二个Workflow或第二次恢复Hook。
 * - 重复派发、响应丢失不会产生第二个Workflow Run。
 */

export interface OutboxDispatcherOptions {
  readonly deps: ApplicationDeps;
  readonly workflowRuntimeBaseUrl: string;
  readonly credential: string;
  readonly intervalMs?: number;
}

type Snapshot = ProductSnapshot;

function dispatchCommandId(...parts: string[]): CommandId {
  return `cmd_${sha256Hex(parts.join(":")).slice(0, 32)}` as CommandId;
}

async function postToWorkflowRuntime(
  options: OutboxDispatcherOptions,
  path: string,
  body: unknown,
): Promise<{ ok: true; json: unknown } | { ok: false; status: number } | "unknown"> {
  let response: Response;
  try {
    response = await fetch(`${options.workflowRuntimeBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-chat-runtime-key": options.credential },
      body: JSON.stringify(body),
    });
  } catch {
    return "unknown";
  }
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, json: await response.json() };
}

async function markStatus(
  options: OutboxDispatcherOptions,
  entry: OutboxEntry,
  status: "pending" | "dispatched" | "acknowledged" | "outcome_unknown" | "failed_terminal",
  errorCode?: string,
): Promise<void> {
  await updateOutboxStatus(options.deps, {
    commandId: dispatchCommandId(
      "update-outbox-status",
      entry.outboxId,
      status,
      String(entry.revision),
    ),
    outboxId: entry.outboxId,
    status,
    ...(errorCode !== undefined ? { errorCode } : {}),
  });
}

function findWorkflowAttemptId(snapshot: Snapshot, productRunId: string): string | undefined {
  return Object.values(snapshot.entities.attempts).find(
    (attempt) => attempt.productRunId === productRunId && attempt.kind === "workflow",
  )?.attemptId;
}

async function dispatchStart(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: OutboxEntry,
): Promise<void> {
  const attemptId = findWorkflowAttemptId(snapshot, entry.productRunId);
  if (attemptId === undefined) {
    await markStatus(options, entry, "failed_terminal", "outbox.missing_attempt");
    return;
  }
  const result = await postToWorkflowRuntime(options, "/internal/workflow/v1/start", {
    schemaVersion: "chat-workflow-dispatch.v1",
    productRunId: entry.productRunId,
    attemptId,
    workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
    outboxId: entry.outboxId,
  });
  if (result === "unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown");
    return;
  }
  if (!result.ok) {
    await markStatus(options, entry, "failed_terminal", `dispatch.http_${String(result.status)}`);
    return;
  }
  workflowStartResponseSchema.parse(result.json);
  await markStatus(options, entry, "acknowledged");
}

async function dispatchResume(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: OutboxEntry,
): Promise<void> {
  const attemptId = findWorkflowAttemptId(snapshot, entry.productRunId);
  if (
    attemptId === undefined ||
    entry.approvalRequestId === undefined ||
    entry.decisionId === undefined
  ) {
    await markStatus(options, entry, "failed_terminal", "outbox.missing_refs");
    return;
  }
  const result = await postToWorkflowRuntime(options, "/internal/workflow/v1/resume", {
    schemaVersion: "chat-workflow-dispatch.v1",
    productRunId: entry.productRunId,
    attemptId,
    approvalRequestId: entry.approvalRequestId,
    decisionId: entry.decisionId,
    outboxId: entry.outboxId,
  });
  if (result === "unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown");
    return;
  }
  if (!result.ok) {
    await markStatus(options, entry, "failed_terminal", `dispatch.http_${String(result.status)}`);
    return;
  }
  workflowResumeResponseSchema.parse(result.json);
  await markStatus(options, entry, "acknowledged");
}

/** outcome_unknown对账：先查Runtime绑定是否已存在，再决定重派或确认，不盲目新建。 */
async function reconcileUnknown(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: OutboxEntry,
): Promise<void> {
  const params = new URLSearchParams({ productRunId: entry.productRunId });
  if (entry.approvalRequestId !== undefined)
    params.set("approvalRequestId", entry.approvalRequestId);
  let response: Response;
  try {
    response = await fetch(
      `${options.workflowRuntimeBaseUrl}/internal/workflow/v1/reconcile?${params.toString()}`,
      { headers: { "x-chat-runtime-key": options.credential } },
    );
  } catch {
    return; // 对账本身结果未知：保持outcome_unknown，下个周期重试
  }
  if (!response.ok) return;
  const reconcile = workflowReconcileResponseSchema.parse(await response.json());
  if (entry.kind === "workflow_start") {
    if (reconcile.startBinding === "exists") {
      await markStatus(options, entry, "acknowledged");
    } else {
      // Runtime侧没有绑定：start请求未生效，重排队走正常幂等派发
      await updateOutboxStatus(options.deps, {
        commandId: dispatchCommandId("requeue-outbox", entry.outboxId, String(entry.revision)),
        outboxId: entry.outboxId,
        status: "pending",
      });
    }
    return;
  }
  // workflow_resume：以Runtime侧Hook派发状态为准
  if (reconcile.hookResumeState === "dispatched") {
    await markStatus(options, entry, "acknowledged");
  } else if (reconcile.hookResumeState === "none") {
    await updateOutboxStatus(options.deps, {
      commandId: dispatchCommandId("requeue-outbox", entry.outboxId, String(entry.revision)),
      outboxId: entry.outboxId,
      status: "pending",
    });
  } else {
    await markStatus(options, entry, "failed_terminal", "reconcile.resume_failed_terminal");
  }
}

export class OutboxDispatcher {
  private readonly options: OutboxDispatcherOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: OutboxDispatcherOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // 派发周期失败不影响下一个周期；条目状态已在事务内安全落地
      });
    }, this.options.intervalMs ?? 500);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 单轮派发；序列化执行，绝不并发派发同一Entry。 */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { snapshot } = await this.options.deps.store.read({ kind: "committedSnapshot" });
      const entries = Object.values(snapshot.outbox)
        .filter((entry) => entry.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const entry of entries) {
        if (entry.kind === "workflow_start") await dispatchStart(this.options, snapshot, entry);
        else await dispatchResume(this.options, snapshot, entry);
      }
      const unknownEntries = Object.values(snapshot.outbox)
        .filter((entry) => entry.status === "outcome_unknown")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const entry of unknownEntries) {
        await reconcileUnknown(this.options, snapshot, entry);
      }
    } finally {
      this.running = false;
    }
  }
}
