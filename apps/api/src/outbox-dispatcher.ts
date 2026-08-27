import {
  WORKFLOW_DEFINITION_ID,
  WORKFLOW_DEFINITION_VERSION,
  workflowResumeResponseSchema,
  workflowReconcileResponseSchema,
  workflowStartResponseSchema,
  memoryImportWorkflowDispatchResponseSchema,
  memoryImportWorkflowReconcileResponseSchema,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  memoryWriteWorkflowDispatchResponseSchema,
  memoryWriteWorkflowReconcileResponseSchema,
  MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
  type CommandId,
  type OutboxEntry,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  commitRunOutcomeUnknown,
  commitMemoryImportFailed,
  commitMemoryImportOutcomeUnknown,
  commitMemoryWriteFailed,
  commitMemoryWriteOutcomeUnknown,
  emitMemoryImportEvent,
  emitRunEvent,
  failOutboxAndRun,
  recoverMemoryImportAfterTerminalWorkflow,
  safeErrorType,
  settleRunAfterTerminalWorkflow,
  updateOutboxStatus,
  WORKFLOW_RUNTIME_QUERY_UNKNOWN_ERROR_CODE,
  WORKFLOW_RUNTIME_UNKNOWN_GRACE_MS,
  type ApplicationDeps,
} from "@chat/application";
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
 *
 * 从前端消息开始调试时，主链按以下顺序走：
 * RealWorkspace.send → use-real-chain.sendMutation → apiSubmitMessage
 * → product-routes的POST /sessions/:sessionId/messages → submitUserMessage
 * → 本文件tick/dispatchStart → Workflow Runtime /internal/workflow/v1/start
 * → planningExecutionWorkflow。
 *
 * 关键边界：submitUserMessage先在一个Product Store事务里提交Message、Product Run和
 * workflow_start Outbox；Dispatcher之后才消费Outbox。这样API进程即使在提交后崩溃，
 * “应该启动Workflow”这件事也不会随内存丢失。
 */

export interface OutboxDispatcherOptions {
  readonly deps: ApplicationDeps;
  readonly workflowRuntimeBaseUrl: string;
  readonly credential: string;
  readonly intervalMs?: number;
}

// Snapshot是Product Store已经提交的只读快照；Dispatcher只能通过Application Command改状态，
// 不能直接改Snapshot。下面的Extract把Outbox联合类型收窄，避免把Start/Resume字段混用。
type Snapshot = ProductSnapshot;
type WorkflowStartEntry = Extract<OutboxEntry, { kind: "workflow_start" }>;
type WorkflowResumeEntry = Extract<OutboxEntry, { kind: "workflow_resume" }>;
type WorkflowEntry = WorkflowStartEntry | WorkflowResumeEntry;
type MemoryImportEntry = Extract<
  OutboxEntry,
  { kind: "memory_import_start" | "memory_import_reconcile" }
>;
type MemoryWriteEntry = Extract<
  OutboxEntry,
  { kind: "memory_write_start" | "memory_write_reconcile" }
>;
const OUTCOME_UNKNOWN_SETTLE_MS = 30_000;
const ACKNOWLEDGED_IMPORT_SUPERVISE_MS = 1_000;
const ACKNOWLEDGED_WORKFLOW_SUPERVISE_MS = 1_000;
const MAX_AUTOMATIC_IMPORT_RECOVERIES = 3;

function reportSupervisionFailure(input: {
  readonly kind: "workflow" | "memory_import";
  readonly durableId: string;
  readonly error: unknown;
}): void {
  // 单条损坏不能阻断同轮其他耐久意图；日志只记录产品/Intent身份和错误类型，不含正文。
  console.error(
    `[outbox] supervision_failed kind=${input.kind} durableId=${input.durableId} errorType=${safeErrorType(input.error)}`,
  );
}

function dispatchCommandId(...parts: string[]): CommandId {
  // Dispatcher会轮询和崩溃恢复；派生出的稳定commandId让同一次状态转换可安全重复提交。
  return `cmd_${sha256Hex(parts.join(":")).slice(0, 32)}` as CommandId;
}

/**
 * 跨进程HTTP只有三类结果：
 * - ok：收到2xx且JSON可读，后续仍要按运行时Schema验证；
 * - HTTP失败：确定收到了状态码，可区分调用方错误和服务端不确定错误；
 * - unknown：请求可能已经生效，但连接/响应不可用，绝不能直接重派制造第二个副作用。
 */
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

/**
 * 调试导航⑦：把已提交的workflow_start Outbox派发给Workflow Runtime。
 *
 * 数据身份不能混用：
 * - productRunId：Chat公开产品运行身份，也是Runtime认领Start的幂等键；
 * - attemptId：Chat记录的一次Workflow执行尝试，用于Trace和生命周期结算；
 * - outboxId：这条跨边界意图的耐久身份，用于证明重复HTTP仍是同一次派发；
 * - workflowDefinitionVersion：固定运行定义，恢复时拒绝拿新代码继续旧Run。
 *
 * 这里不创建产品事实，也不把HTTP 201当成业务完成；它只把Outbox从pending推进到
 * acknowledged/outcome_unknown。真正的Plan、审批和终态由Workflow通过内部Application Command提交。
 */
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
  // 先记录“已请求、结果未知”的可观察事件；只有收到并验证Runtime响应后才更新Outbox状态。
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
    ...(entry.workflowRunSpecId !== undefined
      ? { workflowRunSpecId: entry.workflowRunSpecId }
      : {}),
    ...(entry.runnerFamily !== undefined ? { runnerFamily: entry.runnerFamily } : {}),
    ...(entry.runnerBundleVersion !== undefined
      ? { runnerBundleVersion: entry.runnerBundleVersion }
      : {}),
    attemptId,
    workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
    outboxId: entry.outboxId,
  });
  // unknown与5xx都不能证明Runtime没启动，因此进入对账路径而不是自动创建第二个Workflow。
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
    // acknowledged只表示Runtime已认领/已启动同一Product Run，不表示Plan或执行已经成功。
    await markStatus(options, entry, "acknowledged", undefined, true);
  }
}

/**
 * 调试导航⑩：用户决定已先成为Chat产品Decision，Resume Outbox再携带引用恢复同一Hook。
 * approvalRequestId定位等待点，decisionId定位已提交决定；正文和Hook Token都不穿过Outbox。
 */
async function dispatchResume(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: WorkflowResumeEntry,
): Promise<void> {
  const attemptId = findWorkflowAttemptId(snapshot, entry.productRunId);
  const isPlanningResume = entry.approvalRequestId !== undefined && entry.decisionId !== undefined;
  const isNoteResume =
    entry.hookNoteCandidateId !== undefined &&
    entry.noteCandidateId !== undefined &&
    entry.noteDecisionId !== undefined;
  const isPromptReviewResume =
    entry.promptReviewRequestId !== undefined && entry.promptReviewDecisionId !== undefined;
  const promptReview =
    entry.promptReviewRequestId === undefined
      ? undefined
      : snapshot.entities.promptReviewRequests[entry.promptReviewRequestId];
  const promptDecision =
    entry.promptReviewDecisionId === undefined
      ? undefined
      : snapshot.entities.promptReviewDecisions[entry.promptReviewDecisionId];
  if (
    attemptId === undefined ||
    [isPlanningResume, isNoteResume, isPromptReviewResume].filter(Boolean).length !== 1 ||
    (isPromptReviewResume &&
      (promptReview === undefined ||
        promptDecision === undefined ||
        promptReview.productRunId !== entry.productRunId ||
        promptDecision.productRunId !== entry.productRunId ||
        promptDecision.promptReviewRequestId !== promptReview.promptReviewRequestId))
  ) {
    await failDispatch(options, entry, "outbox.missing_refs", false);
    return;
  }
  const result = await postToWorkflowRuntime(options, "/internal/workflow/v1/resume", {
    schemaVersion: "chat-workflow-dispatch.v1",
    productRunId: entry.productRunId,
    attemptId,
    ...(isPlanningResume
      ? { approvalRequestId: entry.approvalRequestId, decisionId: entry.decisionId }
      : isNoteResume
        ? {
            hookNoteCandidateId: entry.hookNoteCandidateId,
            noteCandidateId: entry.noteCandidateId,
            noteDecisionId: entry.noteDecisionId,
          }
        : {
            promptReviewRequestId: promptReview?.promptReviewRequestId,
            promptReviewDecisionId: promptDecision?.promptReviewDecisionId,
            requestRevision: promptReview?.requestRevision,
            reviewSha256: promptReview?.reviewSha256,
            payloadSha256: promptReview?.payloadSha256,
          }),
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

function writeResult(snapshot: Snapshot, entry: MemoryWriteEntry) {
  const intent = snapshot.entities.memoryWriteIntents[entry.memoryWriteIntentId];
  const result = snapshot.entities.memoryWriteResults[entry.memoryWriteResultId];
  return intent !== undefined && result?.memoryWriteIntentId === intent.memoryWriteIntentId
    ? { intent, result }
    : undefined;
}

async function failMemoryWriteDispatch(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryWriteEntry,
  errorCode: string,
): Promise<void> {
  const current = writeResult(snapshot, entry);
  if (current !== undefined && current.result.status === "queued") {
    await commitMemoryWriteFailed(options.deps, {
      commandId: dispatchCommandId("fail-memory-write-dispatch", entry.outboxId),
      memoryWriteIntentId: current.intent.memoryWriteIntentId,
      memoryWriteResultId: current.result.memoryWriteResultId,
      requestSha256: current.intent.requestSha256,
      expectedRevision: current.result.revision,
      errorCode,
      summary: "Memory Write Workflow无法安全启动",
    });
  }
  await markStatus(options, entry, "failed_terminal", errorCode, true);
}

async function dispatchMemoryWrite(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryWriteEntry,
): Promise<void> {
  const current = writeResult(snapshot, entry);
  if (current === undefined) {
    await markStatus(options, entry, "failed_terminal", "outbox.missing_memory_write", false);
    return;
  }
  if (
    (entry.kind === "memory_write_start" && current.result.status !== "queued") ||
    (entry.kind === "memory_write_reconcile" &&
      (!["dispatching", "accepted", "outcome_unknown"].includes(current.result.status) ||
        current.result.revision !== entry.expectedResultRevision))
  ) {
    await markStatus(options, entry, "acknowledged");
    return;
  }
  const response = await postToWorkflowRuntime(
    options,
    "/internal/workflow/v1/memory-write/start",
    {
      schemaVersion: "chat-workflow-dispatch.v1",
      memoryWriteIntentId: entry.memoryWriteIntentId,
      memoryWriteResultId: entry.memoryWriteResultId,
      expectedResultRevision: entry.expectedResultRevision,
      mode: entry.kind === "memory_write_start" ? "write" : "reconcile",
      workflowDefinitionVersion: MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
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
    } else if (entry.kind === "memory_write_start") {
      await failMemoryWriteDispatch(
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
  const parsed = memoryWriteWorkflowDispatchResponseSchema.safeParse(response.json);
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

async function settleMemoryWriteDispatchUnknown(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryWriteEntry,
): Promise<void> {
  if (Date.parse(options.deps.now()) - Date.parse(entry.updatedAt) < OUTCOME_UNKNOWN_SETTLE_MS) {
    return;
  }
  const current = writeResult(snapshot, entry);
  if (current?.result.status === "queued") {
    await commitMemoryWriteOutcomeUnknown(options.deps, {
      commandId: dispatchCommandId("settle-memory-write-dispatch", entry.outboxId),
      memoryWriteIntentId: current.intent.memoryWriteIntentId,
      memoryWriteResultId: current.result.memoryWriteResultId,
      requestSha256: current.intent.requestSha256,
      expectedRevision: current.result.revision,
      errorCode: "memory.write.workflow_dispatch_unknown",
    });
  }
  await markStatus(options, entry, "failed_terminal", "memory.write.workflow_dispatch_unknown");
}

async function reconcileMemoryWriteUnknown(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: MemoryWriteEntry,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `${options.workflowRuntimeBaseUrl}/internal/workflow/v1/memory-write/reconcile?${new URLSearchParams({ outboxId: entry.outboxId }).toString()}`,
      {
        headers: { "x-chat-runtime-key": options.credential },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    await settleMemoryWriteDispatchUnknown(options, snapshot, entry);
    return;
  }
  if (!response.ok) {
    await settleMemoryWriteDispatchUnknown(options, snapshot, entry);
    return;
  }
  const parsed = memoryWriteWorkflowReconcileResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!parsed.success) {
    await settleMemoryWriteDispatchUnknown(options, snapshot, entry);
    return;
  }
  if (parsed.data.startBinding === "exists") {
    await markStatus(options, entry, "acknowledged");
  } else if (parsed.data.startBinding === "missing") {
    await updateOutboxStatus(options.deps, {
      commandId: dispatchCommandId("requeue-memory-write-outbox", entry.outboxId),
      outboxId: entry.outboxId,
      status: "pending",
    });
  } else {
    await settleMemoryWriteDispatchUnknown(options, snapshot, entry);
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
  if (entry.kind === "workflow_resume" && entry.approvalRequestId !== undefined) {
    params.set("approvalRequestId", entry.approvalRequestId);
  }
  if (entry.kind === "workflow_resume" && entry.hookNoteCandidateId !== undefined) {
    params.set("hookNoteCandidateId", entry.hookNoteCandidateId);
  }
  if (entry.kind === "workflow_resume" && entry.promptReviewRequestId !== undefined) {
    params.set("promptReviewRequestId", entry.promptReviewRequestId);
  }
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

function productRunIsTerminal(
  snapshot: Snapshot,
  productRunId: WorkflowStartEntry["productRunId"],
) {
  const status = snapshot.entities.runs[productRunId]?.status;
  return (
    status === undefined ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "outcome_unknown"
  );
}

async function settleTerminalWorkflow(
  options: OutboxDispatcherOptions,
  entry: WorkflowStartEntry,
  runtimeOutcome: "succeeded" | "failed" | "cancelled" | "outcome_unknown",
): Promise<void> {
  await settleRunAfterTerminalWorkflow(options.deps, {
    // outcome故意不参与commandId：同一Runtime终态证据若在重复查询中漂移，Product Store
    // 会以“同ID不同请求Hash”失败关闭，而不是接受第二种解释。
    commandId: dispatchCommandId("settle-terminal-workflow", entry.outboxId, entry.productRunId),
    outboxId: entry.outboxId,
    productRunId: entry.productRunId,
    runtimeOutcome,
  });
}

/**
 * Runtime查询未知必须形成连续、耐久的观测窗口。首次unknown只在已确认Start上记录
 * lastErrorCode+updatedAt；后续unknown沿用该时间，active则明确清除，避免长Run被一次抖动误杀。
 */
async function observeWorkflowRuntimeUnknown(
  options: OutboxDispatcherOptions,
  entry: WorkflowStartEntry,
): Promise<void> {
  if (entry.lastErrorCode !== WORKFLOW_RUNTIME_QUERY_UNKNOWN_ERROR_CODE) {
    await markStatus(options, entry, "acknowledged", WORKFLOW_RUNTIME_QUERY_UNKNOWN_ERROR_CODE);
    return;
  }
  if (
    Date.parse(options.deps.now()) - Date.parse(entry.updatedAt) >=
    WORKFLOW_RUNTIME_UNKNOWN_GRACE_MS
  ) {
    await settleTerminalWorkflow(options, entry, "outcome_unknown");
  }
}

async function observeWorkflowRuntimeActive(
  options: OutboxDispatcherOptions,
  entry: WorkflowStartEntry,
): Promise<void> {
  if (entry.lastErrorCode !== WORKFLOW_RUNTIME_QUERY_UNKNOWN_ERROR_CODE) return;
  await markStatus(options, entry, "acknowledged");
}

/** 已确认Start的通用监督：不读取正文、不重启Workflow，只消费安全终态证据。 */
async function superviseAcknowledgedWorkflow(
  options: OutboxDispatcherOptions,
  snapshot: Snapshot,
  entry: WorkflowStartEntry,
): Promise<void> {
  if (
    productRunIsTerminal(snapshot, entry.productRunId) ||
    Date.parse(options.deps.now()) - Date.parse(entry.updatedAt) <
      ACKNOWLEDGED_WORKFLOW_SUPERVISE_MS
  ) {
    return;
  }
  let response: Response;
  try {
    response = await fetch(
      `${options.workflowRuntimeBaseUrl}/internal/workflow/v1/reconcile?${new URLSearchParams({ productRunId: entry.productRunId }).toString()}`,
      {
        headers: { "x-chat-runtime-key": options.credential },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    await observeWorkflowRuntimeUnknown(options, entry);
    return;
  }
  const parsed = response.ok
    ? workflowReconcileResponseSchema.safeParse(await response.json().catch(() => undefined))
    : undefined;
  if (
    parsed === undefined ||
    !parsed.success ||
    parsed.data.startBinding !== "exists" ||
    parsed.data.runtimeRun === undefined ||
    parsed.data.runtimeRun.state === "unknown"
  ) {
    await observeWorkflowRuntimeUnknown(options, entry);
    return;
  }
  if (parsed.data.runtimeRun.state === "active") {
    await observeWorkflowRuntimeActive(options, entry);
    return;
  }
  await settleTerminalWorkflow(options, entry, parsed.data.runtimeRun.outcome);
}

/**
 * Outbox的进程内轮询执行器，不是产品业务状态机。
 *
 * tick每次只读取一份已提交快照，然后按createdAt串行处理：
 * 1. pending：第一次跨边界派发；
 * 2. outcome_unknown：向Runtime查询实际结果，禁止盲目重放副作用；
 * 3. acknowledged的普通Product Workflow：监督Runtime终态是否已经提交回产品；
 * 4. acknowledged的Memory导入：监督异步Workflow是否已经进入终态。
 *
 * 不使用Promise.all是有意设计：单进程内串行可避免同一轮重复派发，也让Trace顺序稳定；
 * 跨进程/崩溃场景的最终幂等仍由outboxId、productRunId和Runtime Binding共同保证。
 * 本轮内状态更新不会反写当前snapshot，而会在下一轮读到新的提交版本。
 */
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

  /**
   * 执行一轮“读快照 → 分组 → 串行处理”。running防止setInterval在慢请求期间重入；
   * finally必须释放锁，否则一次异常会让后续轮询永久停止。
   */
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
        else if (entry.kind === "memory_write_start" || entry.kind === "memory_write_reconcile")
          await dispatchMemoryWrite(this.options, snapshot, entry);
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
        } else if (entry.kind === "memory_write_start" || entry.kind === "memory_write_reconcile") {
          await reconcileMemoryWriteUnknown(this.options, snapshot, entry);
        }
      }
      const acknowledgedWorkflows = Object.values(snapshot.outbox)
        .filter(
          (entry): entry is WorkflowStartEntry =>
            entry.status === "acknowledged" && entry.kind === "workflow_start",
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const entry of acknowledgedWorkflows) {
        try {
          await superviseAcknowledgedWorkflow(this.options, snapshot, entry);
        } catch (error) {
          reportSupervisionFailure({
            kind: "workflow",
            durableId: entry.outboxId,
            error,
          });
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
        try {
          await superviseAcknowledgedImport(this.options, snapshot, entry);
        } catch (error) {
          reportSupervisionFailure({
            kind: "memory_import",
            durableId: entry.memoryImportIntentId,
            error,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
