import {
  PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION,
  WORKFLOW_DEFINITION_ID,
  WORKFLOW_DEFINITION_VERSION,
  workflowResumeResponseSchema,
  workflowReconcileResponseSchema,
  workflowStartResponseSchema,
  memoryImportWorkflowDispatchResponseSchema,
  memoryImportWorkflowReconcileResponseSchema,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  type CommandId,
  type OutboxEntry,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  commitRunOutcomeUnknown,
  commitMemoryImportFailed,
  commitMemoryImportOutcomeUnknown,
  emitMemoryImportEvent,
  emitRunEvent,
  failOutboxAndRun,
  recoverMemoryImportAfterTerminalWorkflow,
  updateOutboxStatus,
  type ApplicationDeps,
} from "@chat/application";
import { sha256Hex } from "@chat/domain";
import { z } from "zod";

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
type WorkflowStartEntry = Extract<OutboxEntry, { kind: "workflow_start" }>;
type WorkflowResumeEntry = Extract<OutboxEntry, { kind: "workflow_resume" }>;
type WorkflowEntry = WorkflowStartEntry | WorkflowResumeEntry;
type MemoryImportEntry = Extract<
  OutboxEntry,
  { kind: "memory_import_start" | "memory_import_reconcile" }
>;
type ProjectIntakeEntry = Extract<
  OutboxEntry,
  { kind: "project_intake_start" | "project_intake_resume" }
>;
const projectDispatchResponseSchema = z
  .object({
    schemaVersion: z.literal("chat-workflow-dispatch.v1"),
    status: z.enum(["started", "already_started", "resumed", "already_resumed", "outcome_unknown"]),
  })
  .strict();
const OUTCOME_UNKNOWN_SETTLE_MS = 30_000;
const ACKNOWLEDGED_IMPORT_SUPERVISE_MS = 1_000;
const MAX_AUTOMATIC_IMPORT_RECOVERIES = 3;

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
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return "unknown";
  }
  if (!response.ok) return { ok: false, status: response.status };
  try {
    return { ok: true, json: await response.json() };
  } catch {
    // 请求可能已在Runtime侧生效，响应体损坏或中途断开不能安全重派。
    return "unknown";
  }
}

async function markStatus(
  options: OutboxDispatcherOptions,
  entry: OutboxEntry,
  status: "pending" | "dispatched" | "acknowledged" | "outcome_unknown" | "failed_terminal",
  errorCode?: string,
  incrementDispatchAttempts = false,
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
    ...(incrementDispatchAttempts ? { incrementDispatchAttempts: true } : {}),
  });
}

async function failDispatch(
  options: OutboxDispatcherOptions,
  entry: WorkflowEntry,
  errorCode: string,
  incrementDispatchAttempts: boolean,
): Promise<void> {
  await failOutboxAndRun(options.deps, {
    commandId: dispatchCommandId("fail-outbox-and-run", entry.outboxId, String(entry.revision)),
    outboxId: entry.outboxId,
    errorCode,
    summary: "后台工作无法安全派发，已停止本次运行",
    incrementDispatchAttempts,
  });
}

async function settleUnknownIfExpired(
  options: OutboxDispatcherOptions,
  entry: WorkflowEntry,
): Promise<void> {
  if (Date.parse(options.deps.now()) - Date.parse(entry.updatedAt) < OUTCOME_UNKNOWN_SETTLE_MS) {
    return;
  }
  await commitRunOutcomeUnknown(options.deps, {
    commandId: dispatchCommandId("settle-outcome-unknown", entry.outboxId),
    productRunId: entry.productRunId,
    errorCode: "workflow.outcome_unknown",
    summary: "后台派发结果长期无法确认，已停止自动操作，请人工核对后重新开始",
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
  entry: WorkflowStartEntry,
): Promise<void> {
  const attemptId = findWorkflowAttemptId(snapshot, entry.productRunId);
  if (attemptId === undefined) {
    await failDispatch(options, entry, "outbox.missing_attempt", false);
    return;
  }
  emitRunEvent(options.deps, entry.productRunId, {
    level: "info",
    eventName: "workflow.start.requested",
    outcome: "unknown",
    productRunId: entry.productRunId,
    attemptId: attemptId as never,
    workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
    workflowDefinitionId: WORKFLOW_DEFINITION_ID as never,
  });
  const result = await postToWorkflowRuntime(options, "/internal/workflow/v1/start", {
    schemaVersion: "chat-workflow-dispatch.v1",
    productRunId: entry.productRunId,
    attemptId,
    workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
    outboxId: entry.outboxId,
  });
  if (result === "unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
    return;
  }
  if (!result.ok) {
    if (result.status >= 500) {
      await markStatus(
        options,
        entry,
        "outcome_unknown",
        `dispatch.http_${String(result.status)}`,
        true,
      );
    } else {
      await failDispatch(options, entry, `dispatch.http_${String(result.status)}`, true);
    }
    return;
  }
  const parsedResponse = workflowStartResponseSchema.safeParse(result.json);
  if (!parsedResponse.success) {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
    return;
  }
  const response = parsedResponse.data;
  if (response.status === "outcome_unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
  } else {
    await markStatus(options, entry, "acknowledged", undefined, true);
  }
}

async function dispatchResume(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: WorkflowResumeEntry,
): Promise<void> {
  const attemptId = findWorkflowAttemptId(snapshot, entry.productRunId);
  if (
    attemptId === undefined ||
    entry.approvalRequestId === undefined ||
    entry.decisionId === undefined
  ) {
    await failDispatch(options, entry, "outbox.missing_refs", false);
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
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
    return;
  }
  if (!result.ok) {
    if (result.status >= 500) {
      await markStatus(
        options,
        entry,
        "outcome_unknown",
        `dispatch.http_${String(result.status)}`,
        true,
      );
    } else {
      await failDispatch(options, entry, `dispatch.http_${String(result.status)}`, true);
    }
    return;
  }
  const parsedResponse = workflowResumeResponseSchema.safeParse(result.json);
  if (!parsedResponse.success) {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
    return;
  }
  const response = parsedResponse.data;
  if (response.status === "outcome_unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
  } else {
    await markStatus(options, entry, "acknowledged", undefined, true);
  }
}

function importResult(snapshot: Snapshot, entry: MemoryImportEntry) {
  return snapshot.entities.memoryImportResults[entry.memoryImportResultId];
}

async function failImportDispatch(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryImportEntry,
  errorCode: string,
  origin: "workflow_dispatch" | "recovery" = "workflow_dispatch",
): Promise<void> {
  const result = importResult(snapshot, entry);
  const intent = snapshot.entities.memoryImportIntents[entry.memoryImportIntentId];
  if (
    result !== undefined &&
    intent !== undefined &&
    result.status !== "failed" &&
    result.status !== "materialized"
  ) {
    const failed = await commitMemoryImportFailed(options.deps, {
      commandId: dispatchCommandId(
        "fail-memory-import-dispatch",
        entry.outboxId,
        String(result.revision),
      ),
      memoryImportIntentId: intent.memoryImportIntentId,
      memoryImportResultId: result.memoryImportResultId,
      requestSha256: intent.requestSha256,
      expectedRevision: result.revision,
      errorCode,
      summary: "Memory导入工作流无法安全启动",
    });
    emitMemoryImportEvent(options.deps, intent.memoryImportIntentId, {
      level: "warn",
      eventName: "memory.import.failed",
      outcome: "failure",
      memoryImportIntentId: intent.memoryImportIntentId,
      memoryImportResultId: failed.memoryImportResultId,
      outboxId: entry.outboxId,
      operationId: intent.operationId,
      backendId: intent.backendId,
      requestSha256: intent.requestSha256,
      intentRevision: intent.revision,
      resultRevision: failed.revision,
      origin,
      attempt: Math.max(1, entry.dispatchAttempts),
      error: { code: errorCode, type: "WorkflowDispatchError" },
      durationMs: 0,
    });
  }
  await markStatus(options, entry, "failed_terminal", errorCode, true);
}

async function dispatchMemoryImport(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryImportEntry,
): Promise<void> {
  const resultBefore = importResult(snapshot, entry);
  if (resultBefore === undefined) {
    await markStatus(options, entry, "failed_terminal", "outbox.missing_import_result", false);
    return;
  }
  if (
    (entry.kind === "memory_import_start" && resultBefore.status !== "queued") ||
    (entry.kind === "memory_import_reconcile" &&
      (!["dispatching", "accepted", "outcome_unknown"].includes(resultBefore.status) ||
        resultBefore.revision !== entry.expectedResultRevision))
  ) {
    await markStatus(options, entry, "acknowledged");
    return;
  }

  const response = await postToWorkflowRuntime(
    options,
    "/internal/workflow/v1/memory-import/start",
    {
      schemaVersion: "chat-workflow-dispatch.v1",
      memoryImportIntentId: entry.memoryImportIntentId,
      memoryImportResultId: entry.memoryImportResultId,
      expectedResultRevision: entry.expectedResultRevision,
      mode: entry.kind === "memory_import_start" ? "import" : "reconcile",
      workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
      outboxId: entry.outboxId,
    },
  );
  if (response === "unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
    return;
  }
  if (!response.ok) {
    if (response.status >= 500) {
      await markStatus(
        options,
        entry,
        "outcome_unknown",
        `dispatch.http_${String(response.status)}`,
        true,
      );
    } else if (entry.kind === "memory_import_start") {
      await failImportDispatch(
        options,
        snapshot,
        entry,
        `dispatch.http_${String(response.status)}`,
      );
    } else {
      await markStatus(
        options,
        entry,
        "failed_terminal",
        `dispatch.http_${String(response.status)}`,
        true,
      );
    }
    return;
  }
  const parsed = memoryImportWorkflowDispatchResponseSchema.safeParse(response.json);
  if (!parsed.success || parsed.data.status === "outcome_unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
    return;
  }
  await markStatus(options, entry, "acknowledged", undefined, true);
}

async function dispatchProjectIntake(
  options: OutboxDispatcherOptions,
  entry: ProjectIntakeEntry,
): Promise<void> {
  const response = await postToWorkflowRuntime(
    options,
    entry.kind === "project_intake_start"
      ? "/internal/workflow/v1/project-intake/start"
      : "/internal/workflow/v1/project-intake/resume",
    {
      schemaVersion: "chat-workflow-dispatch.v1",
      workflowDefinitionVersion: PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION,
      projectCandidateId: entry.projectCandidateId,
      expectedCandidateRevision: entry.expectedCandidateRevision,
      outboxId: entry.outboxId,
    },
  );
  if (response === "unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
    return;
  }
  if (!response.ok) {
    if (response.status >= 500) {
      await markStatus(
        options,
        entry,
        "outcome_unknown",
        `dispatch.http_${String(response.status)}`,
        true,
      );
    } else {
      await markStatus(
        options,
        entry,
        "failed_terminal",
        `dispatch.http_${String(response.status)}`,
        true,
      );
    }
    return;
  }
  const parsed = projectDispatchResponseSchema.safeParse(response.json);
  if (!parsed.success || parsed.data.status === "outcome_unknown") {
    await markStatus(options, entry, "outcome_unknown", "dispatch.outcome_unknown", true);
    return;
  }
  await markStatus(options, entry, "acknowledged", undefined, true);
}

async function settleImportDispatchUnknown(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryImportEntry,
): Promise<void> {
  if (Date.parse(options.deps.now()) - Date.parse(entry.updatedAt) < OUTCOME_UNKNOWN_SETTLE_MS) {
    return;
  }
  const result = importResult(snapshot, entry);
  const intent = snapshot.entities.memoryImportIntents[entry.memoryImportIntentId];
  if (result?.status === "queued" && intent !== undefined) {
    const settled = await commitMemoryImportOutcomeUnknown(options.deps, {
      commandId: dispatchCommandId("settle-memory-import-dispatch", entry.outboxId),
      memoryImportIntentId: intent.memoryImportIntentId,
      memoryImportResultId: result.memoryImportResultId,
      requestSha256: intent.requestSha256,
      expectedRevision: result.revision,
      errorCode: "memory.import.workflow_dispatch_unknown",
    });
    emitMemoryImportEvent(options.deps, intent.memoryImportIntentId, {
      level: "warn",
      eventName: "memory.import.outcome_unknown",
      outcome: "unknown",
      memoryImportIntentId: intent.memoryImportIntentId,
      memoryImportResultId: settled.memoryImportResultId,
      outboxId: entry.outboxId,
      operationId: intent.operationId,
      backendId: intent.backendId,
      requestSha256: intent.requestSha256,
      intentRevision: intent.revision,
      resultRevision: settled.revision,
      origin: "workflow_dispatch",
      attempt: Math.max(1, entry.dispatchAttempts),
      error: { code: "memory.import.workflow_dispatch_unknown", type: "WorkflowDispatchError" },
      durationMs: OUTCOME_UNKNOWN_SETTLE_MS,
    });
  }
  await markStatus(options, entry, "failed_terminal", "memory.import.workflow_dispatch_unknown");
}

async function reconcileImportUnknown(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryImportEntry,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `${options.workflowRuntimeBaseUrl}/internal/workflow/v1/memory-import/reconcile?${new URLSearchParams({ outboxId: entry.outboxId }).toString()}`,
      {
        headers: { "x-chat-runtime-key": options.credential },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    await settleImportDispatchUnknown(options, snapshot, entry);
    return;
  }
  if (!response.ok) {
    await settleImportDispatchUnknown(options, snapshot, entry);
    return;
  }
  const parsed = memoryImportWorkflowReconcileResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!parsed.success) {
    await settleImportDispatchUnknown(options, snapshot, entry);
    return;
  }
  if (parsed.data.startBinding === "exists") {
    await markStatus(options, entry, "acknowledged");
  } else if (parsed.data.startBinding === "missing") {
    await updateOutboxStatus(options.deps, {
      commandId: dispatchCommandId("requeue-memory-import-outbox", entry.outboxId),
      outboxId: entry.outboxId,
      status: "pending",
    });
  } else {
    await settleImportDispatchUnknown(options, snapshot, entry);
  }
}

async function superviseAcknowledgedImport(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryImportEntry,
): Promise<void> {
  const result = importResult(snapshot, entry);
  // accepted是Tencent L0已经提交的合法结果，不是“Workflow终止但未提交”。后续是否
  // 物化由用户/后台显式创建只读reconcile Outbox推进，监督器不能擅自降级或重复写入。
  if (
    result === undefined ||
    result.status === "accepted" ||
    result.status === "materialized" ||
    result.status === "failed" ||
    Date.parse(options.deps.now()) - Date.parse(entry.updatedAt) < ACKNOWLEDGED_IMPORT_SUPERVISE_MS
  ) {
    return;
  }
  if (
    result.status === "outcome_unknown" &&
    result.reconcileAttempts >= MAX_AUTOMATIC_IMPORT_RECOVERIES
  ) {
    return;
  }
  let response: Response;
  try {
    response = await fetch(
      `${options.workflowRuntimeBaseUrl}/internal/workflow/v1/memory-import/reconcile?${new URLSearchParams({ outboxId: entry.outboxId }).toString()}`,
      {
        headers: { "x-chat-runtime-key": options.credential },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    return;
  }
  if (!response.ok) return;
  const parsed = memoryImportWorkflowReconcileResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!parsed.success) return;
  if (parsed.data.startBinding !== "exists") {
    if (
      parsed.data.startBinding !== "missing" ||
      Date.parse(options.deps.now()) - Date.parse(entry.updatedAt) < OUTCOME_UNKNOWN_SETTLE_MS
    ) {
      return;
    }
  } else if (parsed.data.runStatus === "active") {
    return;
  }
  if (result.status === "queued") {
    const attemptedStarts = Object.values(snapshot.outbox).filter(
      (candidate) =>
        candidate.kind === "memory_import_start" &&
        candidate.memoryImportIntentId === entry.memoryImportIntentId &&
        (candidate.status === "failed_terminal" || candidate.outboxId === entry.outboxId),
    ).length;
    if (attemptedStarts >= MAX_AUTOMATIC_IMPORT_RECOVERIES) {
      await failImportDispatch(
        options,
        snapshot,
        entry,
        "memory.import.workflow_retry_exhausted",
        "recovery",
      );
      return;
    }
  }
  await recoverMemoryImportAfterTerminalWorkflow(options.deps, {
    commandId: dispatchCommandId(
      "recover-terminal-memory-import-workflow",
      entry.outboxId,
      String(entry.revision),
      String(result.revision),
    ),
    outboxId: entry.outboxId,
    errorCode: "memory.import.workflow_terminal_without_commit",
  });
}

/** outcome_unknown对账：先查Runtime绑定是否已存在，再决定重派或确认，不盲目新建。 */
async function reconcileUnknown(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: WorkflowEntry,
): Promise<void> {
  const params = new URLSearchParams({ productRunId: entry.productRunId });
  if (entry.kind === "workflow_resume") params.set("approvalRequestId", entry.approvalRequestId);
  let response: Response;
  try {
    response = await fetch(
      `${options.workflowRuntimeBaseUrl}/internal/workflow/v1/reconcile?${params.toString()}`,
      {
        headers: { "x-chat-runtime-key": options.credential },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    await settleUnknownIfExpired(options, entry);
    return;
  }
  if (!response.ok) {
    await settleUnknownIfExpired(options, entry);
    return;
  }
  let reconcile: ReturnType<typeof workflowReconcileResponseSchema.parse>;
  try {
    reconcile = workflowReconcileResponseSchema.parse(await response.json());
  } catch {
    await settleUnknownIfExpired(options, entry);
    return;
  }
  if (entry.kind === "workflow_start") {
    if (reconcile.startBinding === "exists") {
      await markStatus(options, entry, "acknowledged");
      return;
    }
    if (reconcile.startBinding === "missing") {
      // Runtime明确确认既无启动意图也无Workflow绑定，说明Start栅栏尚未越过，可安全重排队。
      await updateOutboxStatus(options.deps, {
        commandId: dispatchCommandId("requeue-outbox", entry.outboxId, String(entry.revision)),
        outboxId: entry.outboxId,
        status: "pending",
      });
      return;
    }
    // outcome_unknown说明Runtime已写入启动意图但未能证明是否越过边界，禁止第二次start。
    await settleUnknownIfExpired(options, entry);
    return;
  }
  // workflow_resume：以Runtime侧Hook派发状态为准
  if (reconcile.hookResumeState === "dispatched") {
    await markStatus(options, entry, "acknowledged");
  } else if (reconcile.hookResumeState === "none" || reconcile.hookResumeState === "missing") {
    await updateOutboxStatus(options.deps, {
      commandId: dispatchCommandId("requeue-outbox", entry.outboxId, String(entry.revision)),
      outboxId: entry.outboxId,
      status: "pending",
    });
  } else if (
    reconcile.hookResumeState === "dispatching" ||
    reconcile.hookResumeState === "outcome_unknown"
  ) {
    // 已越过或可能越过Resume边界：保持outcome_unknown，禁止重复恢复。
    await settleUnknownIfExpired(options, entry);
    return;
  } else {
    await failDispatch(options, entry, "reconcile.resume_failed_terminal", false);
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
        else if (entry.kind === "workflow_resume")
          await dispatchResume(this.options, snapshot, entry);
        else if (entry.kind === "memory_import_start" || entry.kind === "memory_import_reconcile")
          await dispatchMemoryImport(this.options, snapshot, entry);
        else await dispatchProjectIntake(this.options, entry);
      }
      const unknownEntries = Object.values(snapshot.outbox)
        .filter((entry) => entry.status === "outcome_unknown")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const entry of unknownEntries) {
        if (entry.kind === "workflow_start" || entry.kind === "workflow_resume") {
          await reconcileUnknown(this.options, snapshot, entry);
        } else if (
          entry.kind === "memory_import_start" ||
          entry.kind === "memory_import_reconcile"
        ) {
          await reconcileImportUnknown(this.options, snapshot, entry);
        } else if (
          Date.parse(this.options.deps.now()) - Date.parse(entry.updatedAt) >=
          OUTCOME_UNKNOWN_SETTLE_MS
        ) {
          // Project Intake没有外部业务副作用；Runtime结果长期未知时停止自动派发，
          // 保留Candidate供用户刷新后重新发起，而不是盲目创建第二个Workflow。
          await markStatus(this.options, entry, "failed_terminal", "dispatch.outcome_unknown");
        }
      }
      const acknowledgedImports = Object.values(snapshot.outbox)
        .filter(
          (entry): entry is MemoryImportEntry =>
            entry.status === "acknowledged" &&
            (entry.kind === "memory_import_start" || entry.kind === "memory_import_reconcile"),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const entry of acknowledgedImports) {
        await superviseAcknowledgedImport(this.options, snapshot, entry);
      }
    } finally {
      this.running = false;
    }
  }
}
