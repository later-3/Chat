import { readFileSync } from "node:fs";
import {
  productSnapshotSchema,
  runtimeVersionEvidenceSchema,
  type Artifact,
  type ContextPackage,
  type Decision,
  type ExecutionCandidate,
  type ExecutionContract,
  type Message,
  type MemoryAdoption,
  type MemoryImportIntent,
  type MemoryImportResult,
  type MemoryQuery,
  type MemoryResultSnapshot,
  type PlanRevision,
  type ProductSnapshot,
  type RevisionInput,
  type RunContextRequest,
  type TraceEvent,
  type TraceObjectRef,
  type ValidationResult,
  type RuntimeVersionEvidence,
} from "@chat/contracts";
import { computePlanSha256 } from "@chat/application";
import {
  computeContextPackageSha256,
  hashCanonical,
  resolveMemoryImportContent,
  sha256Hex,
} from "@chat/domain";
import { readTraceEvents } from "./trace-reader.js";

/**
 * 历史回放只读取已保存证据，不读取当前git HEAD，也不重新执行Workflow或模型。
 * Product Store完整性检查是必需Port，由组合根注入唯一的Store完整性实现。
 */

export type SnapshotIntegrityCheck = (snapshot: ProductSnapshot) => void;

export interface ReplayContentAccess {
  readonly mode: "authorized";
  readonly principalId: string;
  readonly purpose: string;
}

export interface ReplayAssemblerDeps {
  readonly snapshotIntegrityCheck: SnapshotIntegrityCheck;
  readonly authorizeContentAccess?: (access: ReplayContentAccess) => boolean;
  readonly readMemoryImportRuntimeEvidence?: (input: {
    readonly path: string | undefined;
    readonly memoryImportIntentId: string;
    readonly memoryImportResultId: string;
    readonly outbox: readonly {
      readonly outboxId: string;
      readonly kind: "memory_import_start" | "memory_import_reconcile";
    }[];
  }) => MemoryImportRuntimeEvidence;
}

export type HistoricalVersionEvidence = RuntimeVersionEvidence;

export interface ReplayObjectCheck {
  readonly ref: TraceObjectRef;
  readonly status:
    "ok" | "missing" | "wrong_run" | "revision_mismatch" | "hash_mismatch" | "unsupported_type";
  readonly detail?: string;
}

export interface ReplayTimelineEntry {
  readonly timestamp: string;
  readonly eventName: string;
  readonly outcome: string;
  readonly refs: readonly ReplayObjectCheck[];
}

export interface ReplayProductContent {
  readonly sourceMessage: Message;
  readonly finalMessage?: Message;
  readonly plans: readonly PlanRevision[];
  readonly revisionInputs: readonly RevisionInput[];
  readonly decisions: readonly Decision[];
  readonly executionContracts: readonly ExecutionContract[];
  readonly executionCandidates: readonly ExecutionCandidate[];
  readonly validationResults: readonly ValidationResult[];
  readonly artifacts: readonly Artifact[];
  readonly contextRequests: readonly RunContextRequest[];
  readonly memoryQueries: readonly MemoryQuery[];
  readonly memoryResultSnapshots: readonly MemoryResultSnapshot[];
  readonly memoryAdoptions: readonly MemoryAdoption[];
  readonly contextPackages: readonly ContextPackage[];
}

export type ReplayContentProjection =
  { readonly included: false } | { readonly included: true; readonly facts: ReplayProductContent };

export interface RunReplayView {
  readonly productRunId: string;
  readonly versionEvidence: {
    readonly status: "ok" | "dirty" | "missing" | "invalid" | "mismatch";
    readonly gitSha: string | null;
    readonly capturedAt: string | null;
    readonly sourceState: "clean" | "dirty" | null;
    readonly sourceManifestSha256: string | null;
    readonly bundleManifestSha256: string | null;
    readonly workflowDefinitionVersions: readonly string[];
    readonly promptTemplateVersions: readonly string[];
    readonly modelConfigVersions: readonly string[];
  };
  readonly run: { status: string; phase: string; revision: number };
  readonly timeline: readonly ReplayTimelineEntry[];
  readonly content: ReplayContentProjection;
  readonly failures: readonly string[];
}

export interface MemoryImportReplayContent {
  readonly sourceMessage: Message;
  readonly selectedContent: string;
}

export type MemoryImportReplayContentProjection =
  | { readonly included: false }
  | { readonly included: true; readonly facts: MemoryImportReplayContent };

export interface MemoryImportRuntimeEvidence {
  readonly status: "ok" | "missing" | "invalid" | "mismatch";
  readonly entries: readonly {
    readonly outboxId: string;
    readonly mode: "import" | "reconcile";
    readonly state: "started" | "outcome_unknown" | "missing";
    readonly workflowDefinitionVersion: string | null;
  }[];
}

export interface MemoryImportReplayView {
  readonly memoryImportIntentId: string;
  readonly intent: {
    readonly memoryImportResultId: string;
    readonly sourceMessageId: string;
    readonly selectionKind: "full_message" | "utf16_range";
    readonly backendId: string;
    readonly intentRevision: number;
    readonly requestSha256: string;
    readonly backendDescriptorSha256: string;
  };
  readonly result: {
    readonly status: MemoryImportResult["status"];
    readonly revision: number;
    readonly dispatchAttempts: number;
    readonly reconcileAttempts: number;
    readonly externalObjectIdSha256: string | null;
    readonly errorCode: string | null;
  };
  readonly outbox: readonly {
    readonly outboxId: string;
    readonly kind: "memory_import_start" | "memory_import_reconcile";
    readonly status: string;
    readonly revision: number;
    readonly dispatchAttempts: number;
  }[];
  readonly runtimeEvidence: MemoryImportRuntimeEvidence;
  readonly downstreamUse: readonly {
    readonly productRunId: string;
    readonly memoryQueryId: string;
    readonly contextPackageIds: readonly string[];
    readonly planRefs: readonly {
      readonly planId: string;
      readonly revision: number;
      readonly sha256: string;
    }[];
  }[];
  readonly timeline: readonly ReplayTimelineEntry[];
  readonly content: MemoryImportReplayContentProjection;
  readonly failures: readonly string[];
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

function loadSnapshot(storePath: string, check: SnapshotIntegrityCheck): ProductSnapshot {
  let raw: string;
  try {
    raw = readFileSync(storePath, "utf8");
  } catch {
    throw new ReplayError(`无法读取Product Store: ${storePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReplayError("Product Store不是合法JSON");
  }
  const result = productSnapshotSchema.safeParse(parsed);
  if (!result.success) throw new ReplayError("Product Store Schema校验失败");
  try {
    check(result.data);
  } catch {
    throw new ReplayError("Product Store完整对象图校验失败");
  }
  return result.data;
}

function messageSha256(message: Message): string {
  return hashCanonical("message.v1", {
    messageId: message.messageId,
    sessionId: message.sessionId,
    sessionSequence: message.sessionSequence,
    role: message.role,
    content: message.content,
  });
}

function decisionSha256(decision: Decision): string {
  return hashCanonical("decision.v1", {
    decisionId: decision.decisionId,
    approvalRequestId: decision.approvalRequestId,
    productRunId: decision.productRunId,
    planId: decision.planId,
    planRevision: decision.planRevision,
    planSha256: decision.planSha256,
    kind: decision.kind,
    ...(decision.revisionInputId !== undefined
      ? { revisionInputId: decision.revisionInputId }
      : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    principalId: decision.principalId,
    commandId: decision.commandId,
  });
}

function checkRevision(actual: number, ref: TraceObjectRef): ReplayObjectCheck | undefined {
  if (ref.revision !== undefined && ref.revision !== actual) {
    return {
      ref,
      status: "revision_mismatch",
      detail: `期望revision ${String(ref.revision)}，实际${String(actual)}`,
    };
  }
  return undefined;
}

function checkHash(ref: TraceObjectRef, actual: string, label: string): ReplayObjectCheck {
  return actual === ref.sha256
    ? { ref, status: "ok" }
    : { ref, status: "hash_mismatch", detail: `${label} Hash不一致` };
}

function wrongRun(ref: TraceObjectRef): ReplayObjectCheck {
  return { ref, status: "wrong_run", detail: "对象不属于目标Product Run" };
}

function checkRef(
  snapshot: ProductSnapshot,
  productRunId: string,
  ref: TraceObjectRef,
): ReplayObjectCheck {
  switch (ref.objectType) {
    case "plan": {
      // planId不是Map键；历史版本必须用planId + revision精确定位，绝不能取第一条。
      const plan = Object.values(snapshot.entities.plans).find(
        (candidate) => candidate.planId === ref.objectId && candidate.planRevision === ref.revision,
      );
      if (plan === undefined) {
        return { ref, status: "missing", detail: "指定Plan revision不存在" };
      }
      if (plan.productRunId !== productRunId) return wrongRun(ref);
      const recomputed = computePlanSha256({
        planId: plan.planId,
        productRunId: plan.productRunId,
        planRevision: plan.planRevision,
        content: plan.content,
      });
      return checkHash(ref, recomputed, "Plan");
    }
    case "decision": {
      const decision = snapshot.entities.decisions[ref.objectId as never];
      if (decision === undefined) return { ref, status: "missing", detail: "Decision不存在" };
      if (decision.productRunId !== productRunId) return wrongRun(ref);
      const revision = checkRevision(decision.revision, ref);
      return revision ?? checkHash(ref, decisionSha256(decision), "Decision");
    }
    case "message": {
      const message = snapshot.entities.messages[ref.objectId as never];
      if (message === undefined) return { ref, status: "missing", detail: "Message不存在" };
      const run = snapshot.entities.runs[productRunId as never];
      if (
        run === undefined ||
        message.sessionId !== run.sessionId ||
        (message.messageId !== run.sourceMessageId && message.sourceRunId !== productRunId)
      ) {
        return wrongRun(ref);
      }
      const revision = checkRevision(message.revision, ref);
      return revision ?? checkHash(ref, messageSha256(message), "Message");
    }
    case "execution_contract": {
      const contract = snapshot.entities.executionContracts[ref.objectId as never];
      if (contract === undefined) {
        return { ref, status: "missing", detail: "Execution Contract不存在" };
      }
      if (contract.productRunId !== productRunId) return wrongRun(ref);
      const revision = checkRevision(contract.revision, ref);
      return revision ?? checkHash(ref, contract.sha256, "Execution Contract");
    }
    case "execution_candidate": {
      const candidate = snapshot.entities.executionCandidates[ref.objectId as never];
      if (candidate === undefined) {
        return { ref, status: "missing", detail: "Execution Candidate不存在" };
      }
      if (candidate.productRunId !== productRunId) return wrongRun(ref);
      const revision = checkRevision(candidate.revision, ref);
      return revision ?? checkHash(ref, candidate.sha256, "Execution Candidate");
    }
    case "artifact": {
      const artifact = snapshot.entities.artifacts[ref.objectId as never];
      if (artifact === undefined) return { ref, status: "missing", detail: "Artifact不存在" };
      if (artifact.productRunId !== productRunId) return wrongRun(ref);
      const revision = checkRevision(artifact.revision, ref);
      return revision ?? checkHash(ref, artifact.sha256, "Artifact");
    }
    case "context_package": {
      const contextPackage = snapshot.entities.contextPackages[ref.objectId as never];
      if (contextPackage === undefined) {
        return { ref, status: "missing", detail: "Context Package不存在" };
      }
      if (contextPackage.productRunId !== productRunId) return wrongRun(ref);
      const revision = checkRevision(contextPackage.revision, ref);
      if (revision !== undefined) return revision;
      const recomputed = computeContextPackageSha256({
        contextRequestId: contextPackage.contextRequestId,
        productRunId: contextPackage.productRunId,
        assembledForPlanRevision: contextPackage.assembledForPlanRevision,
        purpose: contextPackage.purpose,
        memoryQueryId: contextPackage.memoryQueryId,
        items: contextPackage.items,
        exclusions: contextPackage.exclusions,
      });
      return checkHash(ref, recomputed, "Context Package");
    }
  }
}

function eventRefs(event: TraceEvent): TraceObjectRef[] {
  const refs: TraceObjectRef[] = [];
  if ("planRef" in event && event.planRef !== undefined) refs.push(event.planRef);
  if ("decisionRef" in event && event.decisionRef !== undefined) refs.push(event.decisionRef);
  if ("candidateRef" in event && event.candidateRef !== undefined) refs.push(event.candidateRef);
  if ("contextPackageRef" in event && event.contextPackageRef !== undefined) {
    refs.push(event.contextPackageRef);
  }
  if ("outputRefs" in event && event.outputRefs !== undefined) refs.push(...event.outputRefs);
  if ("inputRefs" in event && event.inputRefs !== undefined) refs.push(...event.inputRefs);
  return refs;
}

function sameRef(left: TraceObjectRef, right: TraceObjectRef): boolean {
  return (
    left.objectType === right.objectType &&
    left.objectId === right.objectId &&
    left.revision === right.revision &&
    left.sha256 === right.sha256
  );
}

function matchingRefCount(
  events: readonly TraceEvent[],
  name: string,
  ref: TraceObjectRef,
): number {
  return events.filter(
    (event) =>
      event.eventName === name && eventRefs(event).some((candidate) => sameRef(candidate, ref)),
  ).length;
}

function count(events: readonly TraceEvent[], eventName: string): number {
  return events.filter((event) => event.eventName === eventName).length;
}

function requireCount(
  failures: Set<string>,
  events: readonly TraceEvent[],
  eventName: string,
  expected: number,
): void {
  const actual = count(events, eventName);
  if (actual !== expected) {
    failures.add(`Trace缺口：${eventName} 期望${String(expected)}条，实际${String(actual)}条`);
  }
}

/** started/terminal必须严格一进一出；不能用一条孤立事件冒充完整调用。 */
function checkSequentialPairs(
  failures: Set<string>,
  events: readonly TraceEvent[],
  label: string,
  isStarted: (event: TraceEvent) => boolean,
  isTerminal: (event: TraceEvent) => boolean,
  keyOf: (event: TraceEvent) => string,
  terminalWithoutStart?: (event: TraceEvent) => boolean,
): void {
  const open = new Map<string, number>();
  for (const event of events) {
    if (isStarted(event)) {
      const key = keyOf(event);
      open.set(key, (open.get(key) ?? 0) + 1);
      continue;
    }
    if (!isTerminal(event)) continue;
    if (terminalWithoutStart?.(event) === true) continue;
    const key = keyOf(event);
    const pending = open.get(key) ?? 0;
    if (pending === 0) failures.add(`Trace缺口：${label}终态没有对应started（${key}）`);
    else open.set(key, pending - 1);
  }
  for (const [key, pending] of open) {
    if (pending > 0)
      failures.add(`Trace缺口：${label}有${String(pending)}个started没有终态（${key}）`);
  }
}

const CONTEXT_EVENT_NAMES = new Set([
  "context.assembly.started",
  "context.assembly.completed",
  "context.assembly.failed",
]);
const MEMORY_QUERY_EVENT_NAMES = new Set([
  "memory.query.started",
  "memory.query.completed",
  "memory.query.failed",
]);

function checkContextMemoryCompleteness(
  snapshot: ProductSnapshot,
  productRunId: string,
  events: readonly TraceEvent[],
  failures: Set<string>,
): void {
  const requests = Object.values(snapshot.entities.contextRequests).filter(
    (request) => request.productRunId === productRunId,
  );
  if (requests.length !== 1) {
    failures.add(
      `产品事实缺口：Run ${productRunId} 的ContextRequest期望1个，实际${String(requests.length)}个`,
    );
    return;
  }

  const request = requests[0]!;
  const contextEvents = events.filter((event) => CONTEXT_EVENT_NAMES.has(event.eventName));
  const memoryEvents = events.filter((event) => MEMORY_QUERY_EVENT_NAMES.has(event.eventName));
  for (const event of contextEvents) {
    if (
      !("contextRequestId" in event) ||
      event.contextRequestId !== request.contextRequestId ||
      !("memoryRequested" in event) ||
      event.memoryRequested !== (request.memory !== undefined)
    ) {
      failures.add(`Trace关联错误：${event.eventName} 未指向该Run唯一ContextRequest`);
    }
  }

  if (request.memory === undefined) {
    if (memoryEvents.length > 0) {
      failures.add("Trace关联错误：no-memory ContextRequest不应出现memory.query事件");
    }
    checkSequentialPairs(
      failures,
      contextEvents,
      "Context assembly",
      (event) => event.eventName === "context.assembly.started",
      (event) =>
        event.eventName === "context.assembly.completed" ||
        event.eventName === "context.assembly.failed",
      (event) => ("contextRequestId" in event ? event.contextRequestId : "invalid"),
    );
    return;
  }

  const queries = Object.values(snapshot.entities.memoryQueries).filter(
    (query) => query.contextRequestId === request.contextRequestId,
  );
  if (queries.length !== 1) {
    failures.add(
      `产品事实缺口：Memory ContextRequest ${request.contextRequestId} 的Query期望1个，实际${String(queries.length)}个`,
    );
    return;
  }
  const query = queries[0]!;

  const contextStarted = contextEvents.filter(
    (event) =>
      event.eventName === "context.assembly.started" &&
      event.contextRequestId === request.contextRequestId,
  );
  const contextTerminal = contextEvents.filter(
    (event) =>
      (event.eventName === "context.assembly.completed" ||
        event.eventName === "context.assembly.failed") &&
      event.contextRequestId === request.contextRequestId,
  );
  if (contextStarted.length !== 1 || contextTerminal.length !== 1) {
    failures.add(
      `Trace缺口：Memory Context assembly期望started/terminal各1条，实际${String(contextStarted.length)}/${String(contextTerminal.length)}`,
    );
  }
  checkSequentialPairs(
    failures,
    contextEvents,
    "Context assembly",
    (event) => event.eventName === "context.assembly.started",
    (event) =>
      event.eventName === "context.assembly.completed" ||
      event.eventName === "context.assembly.failed",
    (event) => ("contextRequestId" in event ? event.contextRequestId : "invalid"),
  );

  for (const event of memoryEvents) {
    if (
      !("memoryQueryId" in event) ||
      event.memoryQueryId !== query.memoryQueryId ||
      event.contextRequestId !== request.contextRequestId ||
      event.backendId !== query.backendId ||
      event.requirement !== query.requirement ||
      event.sourceMessageSha256 !== query.sourceMessageSha256 ||
      event.tagCount !== query.tags.length ||
      event.layerCount !== query.layers.length ||
      event.requestedLimit !== query.limit ||
      event.contextBudget !== query.contextBudget
    ) {
      failures.add(`Trace关联错误：${event.eventName} 与持久化Memory Query不一致`);
    }
  }
  const queryStarted = memoryEvents.filter(
    (event) =>
      event.eventName === "memory.query.started" && event.memoryQueryId === query.memoryQueryId,
  ).length;
  const queryCompleted = memoryEvents.filter(
    (event) =>
      event.eventName === "memory.query.completed" && event.memoryQueryId === query.memoryQueryId,
  ).length;
  const queryFailed = memoryEvents.filter(
    (event) =>
      event.eventName === "memory.query.failed" && event.memoryQueryId === query.memoryQueryId,
  ).length;
  const expectedCompleted = query.status === "completed" ? 1 : 0;
  const expectedFailed = query.status === "failed" ? 1 : 0;
  if (
    queryStarted !== 1 ||
    queryCompleted !== expectedCompleted ||
    queryFailed !== expectedFailed
  ) {
    failures.add(
      `Trace缺口：Memory Query ${query.memoryQueryId} 与持久化终态${query.status}不一致（started=${String(queryStarted)}, completed=${String(queryCompleted)}, failed=${String(queryFailed)}）`,
    );
  }
  const completedQueryEvent = memoryEvents.find(
    (event): event is Extract<TraceEvent, { eventName: "memory.query.completed" }> =>
      event.eventName === "memory.query.completed" && event.memoryQueryId === query.memoryQueryId,
  );
  const failedQueryEvent = memoryEvents.find(
    (event): event is Extract<TraceEvent, { eventName: "memory.query.failed" }> =>
      event.eventName === "memory.query.failed" && event.memoryQueryId === query.memoryQueryId,
  );
  if (
    query.status === "completed" &&
    (completedQueryEvent?.resultSetSha256 !== query.resultSetSha256 ||
      completedQueryEvent.hitCount !== query.hitCount ||
      completedQueryEvent.adoptedCount !== query.adoptedCount)
  ) {
    failures.add(`Trace关联错误：Memory Query ${query.memoryQueryId} completed统计或Hash不一致`);
  }
  if (query.status === "failed" && failedQueryEvent?.error.code !== query.errorCode) {
    failures.add(`Trace关联错误：Memory Query ${query.memoryQueryId} failed错误码不一致`);
  }
  checkSequentialPairs(
    failures,
    memoryEvents,
    "Memory Query",
    (event) => event.eventName === "memory.query.started",
    (event) =>
      event.eventName === "memory.query.completed" || event.eventName === "memory.query.failed",
    (event) => ("memoryQueryId" in event ? event.memoryQueryId : "invalid"),
  );

  const packages = Object.values(snapshot.entities.contextPackages).filter(
    (contextPackage) =>
      contextPackage.productRunId === productRunId &&
      contextPackage.contextRequestId === request.contextRequestId &&
      contextPackage.memoryQueryId === query.memoryQueryId,
  );
  const completedEvent = contextTerminal.find(
    (event) => event.eventName === "context.assembly.completed",
  );
  const failedEvent = contextTerminal.find(
    (event) => event.eventName === "context.assembly.failed",
  );

  if (
    query.status === "completed" ||
    (query.status === "failed" && query.requirement === "optional")
  ) {
    const expectedStatus = query.status === "completed" ? "ready" : "optional_failed";
    const contextPackage = packages[0];
    if (
      packages.length !== 1 ||
      completedEvent?.status !== expectedStatus ||
      completedEvent.contextPackageRef === undefined ||
      contextPackage === undefined
    ) {
      failures.add(
        `Trace关联错误：Memory Query ${query.memoryQueryId} 的${expectedStatus}终态必须精确引用唯一Context Package`,
      );
    } else {
      const expectedRef: TraceObjectRef = {
        objectType: "context_package",
        objectId: contextPackage.contextPackageId,
        revision: contextPackage.revision,
        sha256: contextPackage.sha256,
      };
      if (!sameRef(completedEvent.contextPackageRef, expectedRef)) {
        failures.add(
          `Trace关联错误：context.assembly.completed未精确引用Memory Query ${query.memoryQueryId} 的Context Package`,
        );
      }
      if (
        completedEvent.adoptedCount !== contextPackage.items.length ||
        completedEvent.excludedCount !== contextPackage.exclusions.length ||
        (expectedStatus === "optional_failed" &&
          (contextPackage.items.length !== 0 ||
            contextPackage.exclusions.length !== 1 ||
            contextPackage.exclusions[0]?.backendId !== query.backendId))
      ) {
        failures.add(
          `Trace关联错误：Context Package ${contextPackage.contextPackageId} 的采用/排除结果与终态不一致`,
        );
      }
    }
    if (failedEvent !== undefined) {
      failures.add(
        `Trace关联错误：Memory Query ${query.memoryQueryId} 不应以Context assembly失败终止`,
      );
    }
    return;
  }

  if (query.status === "failed" && query.requirement === "required") {
    if (packages.length !== 0 || failedEvent === undefined || completedEvent !== undefined) {
      failures.add(
        `Trace关联错误：required Memory Query ${query.memoryQueryId} 失败时必须无Context Package且以失败终态结束`,
      );
    }
  }
}

function checkTimelineCompleteness(
  snapshot: ProductSnapshot,
  productRunId: string,
  events: readonly TraceEvent[],
  failures: Set<string>,
): void {
  const run = snapshot.entities.runs[productRunId as never];
  if (run === undefined) return;
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) failures.add(`Trace损坏：eventId重复 ${event.eventId}`);
    eventIds.add(event.eventId);
  }
  requireCount(failures, events, "product_run.created", 1);

  const messageReceipt = Object.values(snapshot.commandReceipts).find(
    (receipt) =>
      receipt.commandType === "SubmitUserMessage" &&
      receipt.resultRefs["productRunId"] === productRunId,
  );
  if (messageReceipt !== undefined) {
    const accepted = events.filter(
      (event) =>
        event.eventName === "http.command.accepted" &&
        event.commandId === messageReceipt.commandId &&
        event.productRunId === productRunId,
    ).length;
    if (accepted !== 1) {
      failures.add(
        `Trace缺口：Message Command ${messageReceipt.commandId} accepted期望1条，实际${String(accepted)}条`,
      );
    }
    for (const eventName of [
      "product.transaction.started",
      "product.transaction.committed",
    ] as const) {
      const actual = events.filter(
        (event) => event.eventName === eventName && event.commandId === messageReceipt.commandId,
      ).length;
      if (actual !== 1) {
        failures.add(
          `Trace缺口：Message Command ${messageReceipt.commandId} ${eventName}期望1条，实际${String(actual)}条`,
        );
      }
    }
  }

  const plans = Object.values(snapshot.entities.plans).filter(
    (plan) => plan.productRunId === productRunId,
  );
  const approvals = Object.values(snapshot.entities.approvalRequests).filter(
    (approval) => approval.productRunId === productRunId,
  );
  const decisions = Object.values(snapshot.entities.decisions).filter(
    (decision) => decision.productRunId === productRunId,
  );
  const planningAttempts = Object.values(snapshot.entities.attempts).filter(
    (attempt) => attempt.productRunId === productRunId && attempt.kind === "planning",
  );

  const startOutbox = Object.values(snapshot.outbox).find(
    (entry) => entry.kind === "workflow_start" && entry.productRunId === productRunId,
  );
  if (startOutbox?.status === "failed_terminal") {
    requireCount(failures, events, "workflow.start.failed", 1);
  } else if (startOutbox?.status === "outcome_unknown") {
    const boundaryCount =
      count(events, "workflow.start.started") + count(events, "workflow.start.failed");
    if (boundaryCount === 0) {
      failures.add("Trace缺口：Workflow Start结果未知但没有started/failed边界证据");
    }
  } else if (
    startOutbox?.status === "acknowledged" ||
    plans.length > 0 ||
    run.status !== "pending"
  ) {
    requireCount(failures, events, "workflow.start.started", 1);
  }
  requireCount(failures, events, "workflow.hook.waiting", plans.length);
  requireCount(failures, events, "workflow.hook.resume_dispatched", decisions.length);
  requireCount(failures, events, "workflow.hook.resumed", decisions.length);

  for (const plan of plans) {
    const ref: TraceObjectRef = {
      objectType: "plan",
      objectId: plan.planId,
      revision: plan.planRevision,
      sha256: plan.sha256,
    };
    const published = matchingRefCount(events, "plan.candidate.published", ref);
    if (published !== 1) {
      failures.add(
        `Trace缺口：Plan ${plan.planId}@${String(plan.planRevision)} published期望1条，实际${String(published)}条`,
      );
    }
    const approval = approvals.find(
      (candidate) =>
        candidate.planId === plan.planId && candidate.planRevision === plan.planRevision,
    );
    if (approval === undefined) {
      failures.add(`产品事实缺口：Plan ${plan.planId}@${String(plan.planRevision)} 缺少Approval`);
    } else {
      const created = events.filter(
        (event) =>
          event.eventName === "approval.created" &&
          event.approvalRequestId === approval.approvalRequestId &&
          sameRef(event.planRef, ref),
      ).length;
      if (created !== 1) {
        failures.add(
          `Trace缺口：Approval ${approval.approvalRequestId} created期望1条，实际${String(created)}条`,
        );
      }
    }
  }

  for (const attempt of planningAttempts) {
    const scoped = events.filter(
      (event) => "attemptId" in event && event.attemptId === attempt.attemptId,
    );
    const preRequestFailure = scoped.some(
      (event) =>
        event.eventName === "provider.request.failed" &&
        event.inputManifestSha256 === undefined &&
        event.error.code.startsWith("provider.pre_request."),
    );
    // 凭据/配置等请求前失败没有越过Provider边界，因此started必须为0；
    // failed事件本身就是失败关闭证据。其它失败仍必须先有started。
    requireCount(failures, scoped, "provider.request.started", preRequestFailure ? 0 : 1);
    requireCount(
      failures,
      scoped,
      attempt.outcome === "success" ? "provider.request.completed" : "provider.request.failed",
      1,
    );
    requireCount(failures, scoped, "pi.node.started", preRequestFailure ? 0 : 1);
    requireCount(
      failures,
      scoped,
      attempt.outcome === "success" ? "pi.node.completed" : "pi.node.failed",
      1,
    );
  }

  for (const decision of decisions) {
    const ref: TraceObjectRef = {
      objectType: "decision",
      objectId: decision.decisionId,
      revision: decision.revision,
      sha256: decisionSha256(decision),
    };
    const committed = matchingRefCount(events, "decision.committed", ref);
    if (committed !== 1) {
      failures.add(
        `Trace缺口：Decision ${decision.decisionId} committed期望1条，实际${String(committed)}条`,
      );
    }
  }

  const executionAttemptIds = new Set(
    Object.values(snapshot.entities.attempts)
      .filter((attempt) => attempt.productRunId === productRunId && attempt.kind === "execution")
      .map((attempt) => attempt.attemptId),
  );

  if (run.status === "succeeded") {
    const contracts = Object.values(snapshot.entities.executionContracts).filter(
      (contract) => contract.productRunId === productRunId,
    );
    const candidates = Object.values(snapshot.entities.executionCandidates).filter(
      (candidate) => candidate.productRunId === productRunId,
    );
    const validations = Object.values(snapshot.entities.validationResults).filter(
      (validation) => validation.productRunId === productRunId,
    );
    if (contracts.length !== 1 || candidates.length !== 1 || validations.length !== 1) {
      failures.add("产品事实缺口：成功Run必须恰有一个Execution Contract/Candidate/Validation");
    }
    const candidate = candidates[0];
    if (candidate !== undefined) {
      const ref: TraceObjectRef = {
        objectType: "execution_candidate",
        objectId: candidate.executionCandidateId,
        sha256: candidate.sha256,
      };
      if (matchingRefCount(events, "execution.validated", ref) !== 1) {
        failures.add(
          `Trace缺口：Execution Candidate ${candidate.executionCandidateId} 缺少唯一validated事件`,
        );
      }
    }
    const stepCount = contracts[0]?.steps.length ?? 0;
    const executionEvents = events.filter(
      (event) => "attemptId" in event && executionAttemptIds.has(event.attemptId),
    );
    const executorStarted = executionEvents.filter(
      (event) => event.eventName === "pi.node.started" && event.nodeKind === "executor",
    ).length;
    const executorCompleted = executionEvents.filter(
      (event) => event.eventName === "pi.node.completed" && event.nodeKind === "executor",
    ).length;
    if (executorStarted !== stepCount || executorCompleted !== stepCount) {
      failures.add(
        `Trace缺口：Executor步骤期望${String(stepCount)}次，started=${String(executorStarted)}, completed=${String(executorCompleted)}`,
      );
    }
    requireCount(failures, events, "product_commit.started", 1);
    requireCount(failures, events, "product_commit.committed", 1);
    const final =
      run.finalMessageId === undefined ? undefined : snapshot.entities.messages[run.finalMessageId];
    if (final === undefined) failures.add("产品事实缺口：成功Run缺少正式Assistant Message");
    else {
      const ref: TraceObjectRef = {
        objectType: "message",
        objectId: final.messageId,
        sha256: messageSha256(final),
      };
      if (matchingRefCount(events, "product_commit.committed", ref) !== 1) {
        failures.add("Trace缺口：Product Commit没有精确引用正式Assistant Message");
      }
    }
  }

  if (run.status === "failed") {
    const hasFailureBoundary = events.some(
      (event) =>
        event.outcome === "failure" ||
        (event.eventName === "product_run.transitioned" && event.toStatus === "failed"),
    );
    if (!hasFailureBoundary) failures.add("Trace缺口：失败Run没有任何失败边界或失败状态转换");
  }

  checkSequentialPairs(
    failures,
    events,
    "Workflow Step",
    (event) => event.eventName === "workflow.step.started",
    (event) =>
      event.eventName === "workflow.step.completed" || event.eventName === "workflow.step.failed",
    (event) =>
      "stepKey" in event
        ? `${event.attemptId}/${event.stepKey}/${String(event.stepAttempt)}`
        : "invalid",
  );
  const preRequestAttemptIds = new Set(
    events.flatMap((event) =>
      event.eventName === "provider.request.failed" &&
      event.inputManifestSha256 === undefined &&
      event.error.code.startsWith("provider.pre_request.")
        ? [event.attemptId]
        : [],
    ),
  );
  checkSequentialPairs(
    failures,
    events,
    "Provider请求",
    (event) => event.eventName === "provider.request.started",
    (event) =>
      event.eventName === "provider.request.completed" ||
      event.eventName === "provider.request.failed",
    (event) => ("attemptId" in event ? String(event.attemptId) : "invalid"),
    (event) =>
      event.eventName === "provider.request.failed" &&
      event.inputManifestSha256 === undefined &&
      event.error.code.startsWith("provider.pre_request."),
  );
  checkSequentialPairs(
    failures,
    events,
    "pi节点",
    (event) => event.eventName === "pi.node.started",
    (event) => event.eventName === "pi.node.completed" || event.eventName === "pi.node.failed",
    (event) => ("nodeKind" in event ? `${event.attemptId}/${event.nodeKind}` : "invalid"),
    (event) => event.eventName === "pi.node.failed" && preRequestAttemptIds.has(event.attemptId),
  );
  checkContextMemoryCompleteness(snapshot, productRunId, events, failures);
}

function parseVersionEvidence(raw: unknown): HistoricalVersionEvidence | undefined {
  return runtimeVersionEvidenceSchema.safeParse(raw).data;
}

function loadVersionEvidence(path: string | undefined): {
  evidence?: HistoricalVersionEvidence;
  status: "missing" | "invalid" | "loaded";
} {
  if (path === undefined) return { status: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { status: "invalid" };
  }
  const evidence = parseVersionEvidence(parsed);
  return evidence === undefined ? { status: "invalid" } : { status: "loaded", evidence };
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function containsObservedVersions(
  captured: readonly string[],
  observed: readonly string[],
): boolean {
  const capturedSet = new Set(captured);
  return observed.every((value) => capturedSet.has(value));
}

function collectContent(snapshot: ProductSnapshot, productRunId: string): ReplayProductContent {
  const run = snapshot.entities.runs[productRunId as never];
  if (run === undefined) throw new ReplayError(`Product Run不存在: ${productRunId}`);
  const sourceMessage = snapshot.entities.messages[run.sourceMessageId];
  if (sourceMessage === undefined) throw new ReplayError("Product Run源Message不存在");
  const finalMessage =
    run.finalMessageId === undefined ? undefined : snapshot.entities.messages[run.finalMessageId];
  const byCreatedAt = <T extends { createdAt: string }>(left: T, right: T) =>
    left.createdAt.localeCompare(right.createdAt);
  return {
    sourceMessage,
    ...(finalMessage !== undefined ? { finalMessage } : {}),
    plans: Object.values(snapshot.entities.plans)
      .filter((entity) => entity.productRunId === productRunId)
      .sort((left, right) => left.planRevision - right.planRevision),
    revisionInputs: Object.values(snapshot.entities.revisionInputs)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    decisions: Object.values(snapshot.entities.decisions)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    executionContracts: Object.values(snapshot.entities.executionContracts)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    executionCandidates: Object.values(snapshot.entities.executionCandidates)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    validationResults: Object.values(snapshot.entities.validationResults)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    artifacts: Object.values(snapshot.entities.artifacts)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    contextRequests: Object.values(snapshot.entities.contextRequests)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    memoryQueries: Object.values(snapshot.entities.memoryQueries)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    memoryResultSnapshots: Object.values(snapshot.entities.memoryResultSnapshots)
      .filter((entity) => {
        const query = snapshot.entities.memoryQueries[entity.memoryQueryId];
        return query?.productRunId === productRunId;
      })
      .sort(byCreatedAt),
    memoryAdoptions: Object.values(snapshot.entities.memoryAdoptions)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
    contextPackages: Object.values(snapshot.entities.contextPackages)
      .filter((entity) => entity.productRunId === productRunId)
      .sort(byCreatedAt),
  };
}

export function assembleRunReplay(
  input: {
    productRunId: string;
    storePath: string;
    traceDir?: string | undefined;
    versionEvidencePath?: string | undefined;
    contentAccess?: ReplayContentAccess | undefined;
  },
  deps: ReplayAssemblerDeps,
): RunReplayView {
  const snapshot = loadSnapshot(input.storePath, deps.snapshotIntegrityCheck);
  const run = snapshot.entities.runs[input.productRunId as never];
  if (run === undefined) throw new ReplayError(`Product Run不存在: ${input.productRunId}`);

  const events = readTraceEvents({
    productRunId: input.productRunId,
    ...(input.traceDir !== undefined ? { dir: input.traceDir } : {}),
  });
  const failures = new Set<string>();
  const timeline: ReplayTimelineEntry[] = events.map((event) => {
    const refs = eventRefs(event).map((ref) => checkRef(snapshot, input.productRunId, ref));
    for (const check of refs) {
      if (check.status !== "ok") {
        failures.add(
          `${event.eventName}: ${check.ref.objectType}/${check.ref.objectId} ${check.status}${check.detail !== undefined ? `:${check.detail}` : ""}`,
        );
      }
    }
    return { timestamp: event.timestamp, eventName: event.eventName, outcome: event.outcome, refs };
  });
  checkTimelineCompleteness(snapshot, input.productRunId, events, failures);

  const observedWorkflow = sorted(
    events.flatMap((event) =>
      "workflowDefinitionVersion" in event ? [event.workflowDefinitionVersion] : [],
    ),
  );
  const observedPrompt = sorted(
    events.flatMap((event) =>
      "promptTemplateVersion" in event ? [event.promptTemplateVersion] : [],
    ),
  );
  const observedModel = sorted(
    events.flatMap((event) => ("modelConfigVersion" in event ? [event.modelConfigVersion] : [])),
  );
  const loadedEvidence = loadVersionEvidence(input.versionEvidencePath);
  let versionStatus: RunReplayView["versionEvidence"]["status"];
  if (loadedEvidence.status === "missing") {
    versionStatus = "missing";
    failures.add("版本证据缺失：未提供运行当时保存的版本证据文件");
  } else if (loadedEvidence.status === "invalid" || loadedEvidence.evidence === undefined) {
    versionStatus = "invalid";
    failures.add("版本证据无效：文件不可读或不符合严格合同");
  } else {
    const evidence = loadedEvidence.evidence;
    const matches =
      evidence.productRunId === input.productRunId &&
      containsObservedVersions(evidence.workflowDefinitionVersions, observedWorkflow) &&
      containsObservedVersions(evidence.promptTemplateVersions, observedPrompt) &&
      containsObservedVersions(evidence.modelConfigVersions, observedModel);
    versionStatus = evidence.sourceState === "dirty" ? "dirty" : matches ? "ok" : "mismatch";
    if (evidence.sourceState === "dirty") {
      failures.add("版本证据不可复现：运行由dirty源码构建，不能归因为记录的Git SHA");
    } else if (!matches) {
      failures.add("版本证据不匹配：Trace出现了保存证据未捕获的运行版本");
    }
  }

  let content: ReplayContentProjection = { included: false };
  if (input.contentAccess !== undefined) {
    if (
      input.contentAccess.mode !== "authorized" ||
      input.contentAccess.principalId.trim() === "" ||
      input.contentAccess.purpose.trim() === ""
    ) {
      throw new ReplayError("正文访问授权上下文无效");
    }
    if (deps.authorizeContentAccess?.(input.contentAccess) !== true) {
      throw new ReplayError("未授权读取Product Store正文");
    }
    content = { included: true, facts: collectContent(snapshot, input.productRunId) };
  }

  return {
    productRunId: input.productRunId,
    versionEvidence: {
      status: versionStatus,
      gitSha: loadedEvidence.evidence?.gitSha ?? null,
      capturedAt: loadedEvidence.evidence?.capturedAt ?? null,
      sourceState: loadedEvidence.evidence?.sourceState ?? null,
      sourceManifestSha256: loadedEvidence.evidence?.sourceManifestSha256 ?? null,
      bundleManifestSha256: loadedEvidence.evidence?.bundleManifestSha256 ?? null,
      workflowDefinitionVersions: observedWorkflow,
      promptTemplateVersions: observedPrompt,
      modelConfigVersions: observedModel,
    },
    run: { status: run.status, phase: run.phase, revision: run.revision },
    timeline,
    content,
    failures: [...failures],
  };
}

function checkMemoryImportTimeline(
  intent: MemoryImportIntent,
  result: MemoryImportResult,
  outboxIds: ReadonlySet<string>,
  events: readonly TraceEvent[],
  failures: Set<string>,
): void {
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) failures.add(`Trace损坏：eventId重复 ${event.eventId}`);
    eventIds.add(event.eventId);
    if (!("memoryImportIntentId" in event)) {
      failures.add(`Trace关联错误：${event.eventName} 不是Memory Import事件`);
      continue;
    }
    if (
      event.memoryImportResultId !== result.memoryImportResultId ||
      event.operationId !== intent.operationId ||
      event.backendId !== intent.backendId ||
      event.requestSha256 !== intent.requestSha256 ||
      event.intentRevision !== intent.revision ||
      event.resultRevision > result.revision ||
      !outboxIds.has(event.outboxId)
    ) {
      failures.add(`Trace关联错误：${event.eventName} 与持久化Intent/Result/Outbox不一致`);
    }
  }

  requireCount(failures, events, "memory.import.intent_created", 1);
  requireCount(failures, events, "memory.import.started", result.dispatchAttempts);
  checkSequentialPairs(
    failures,
    events,
    "Memory Import外部写入",
    (event) => event.eventName === "memory.import.started",
    (event) =>
      event.eventName === "memory.import.accepted" ||
      (event.eventName === "memory.import.outcome_unknown" && event.origin === "dispatch") ||
      (event.eventName === "memory.import.failed" && event.origin === "dispatch"),
    (event) =>
      "memoryImportIntentId" in event
        ? `${event.memoryImportIntentId}/${String(
            "dispatchAttempt" in event
              ? event.dispatchAttempt
              : "attempt" in event
                ? event.attempt
                : 1,
          )}`
        : "invalid",
  );
  checkSequentialPairs(
    failures,
    events,
    "Memory Import对账",
    (event) => event.eventName === "memory.import.reconcile.started",
    (event) =>
      event.eventName === "memory.import.reconcile.completed" ||
      event.eventName === "memory.import.reconcile.failed",
    (event) =>
      "memoryImportIntentId" in event
        ? `${event.memoryImportIntentId}/${String("reconcileAttempt" in event ? event.reconcileAttempt : 1)}`
        : "invalid",
  );

  const terminalByStatus: Partial<Record<MemoryImportResult["status"], string>> = {
    materialized: "memory.import.materialized",
    failed: "memory.import.failed",
    outcome_unknown: "memory.import.outcome_unknown",
  };
  const expectedTerminal = terminalByStatus[result.status];
  if (expectedTerminal !== undefined && count(events, expectedTerminal) === 0) {
    failures.add(`Trace缺口：持久化终态${result.status}缺少${expectedTerminal}`);
  }
  if (
    result.status === "accepted" &&
    !events.some(
      (event) =>
        event.eventName === "memory.import.accepted" ||
        (event.eventName === "memory.import.reconcile.completed" &&
          event.resolution === "accepted"),
    )
  ) {
    failures.add("Trace缺口：持久化终态accepted缺少写入接收或对账接收证据");
  }
  if ("externalObjectId" in result) {
    const expectedHash = sha256Hex(result.externalObjectId);
    const externalHashes = events.flatMap((event) =>
      "externalObjectIdSha256" in event && event.externalObjectIdSha256 !== undefined
        ? [event.externalObjectIdSha256]
        : [],
    );
    if (!externalHashes.includes(expectedHash)) {
      failures.add("Trace关联错误：accepted/materialized未记录外部对象ID的不可逆Hash");
    }
  }
}

function collectMemoryImportDownstreamUse(
  snapshot: ProductSnapshot,
  result: MemoryImportResult,
): MemoryImportReplayView["downstreamUse"] {
  if (!("externalObjectId" in result)) return [];
  return Object.values(snapshot.entities.memoryResultSnapshots)
    .filter((memory) => memory.externalObjectIds.includes(result.externalObjectId))
    .flatMap((memory) => {
      const query = snapshot.entities.memoryQueries[memory.memoryQueryId];
      if (query === undefined) return [];
      const packages = Object.values(snapshot.entities.contextPackages).filter(
        (contextPackage) =>
          contextPackage.memoryQueryId === query.memoryQueryId &&
          contextPackage.items.some(
            (item) => item.memoryResultSnapshotId === memory.memoryResultSnapshotId,
          ),
      );
      const plans = Object.values(snapshot.entities.plans).filter(
        (plan) => plan.productRunId === query.productRunId,
      );
      return [
        {
          productRunId: query.productRunId,
          memoryQueryId: query.memoryQueryId,
          contextPackageIds: packages.map((item) => item.contextPackageId).sort(),
          planRefs: plans
            .map((plan) => ({
              planId: plan.planId,
              revision: plan.planRevision,
              sha256: plan.sha256,
            }))
            .sort((left, right) => left.revision - right.revision),
        },
      ];
    });
}

export function assembleMemoryImportReplay(
  input: {
    memoryImportIntentId: string;
    storePath: string;
    traceDir?: string | undefined;
    runtimeBindingsPath?: string | undefined;
    contentAccess?: ReplayContentAccess | undefined;
  },
  deps: ReplayAssemblerDeps,
): MemoryImportReplayView {
  const snapshot = loadSnapshot(input.storePath, deps.snapshotIntegrityCheck);
  const intent = snapshot.entities.memoryImportIntents[input.memoryImportIntentId as never];
  if (intent === undefined) {
    throw new ReplayError(`Memory Import Intent不存在: ${input.memoryImportIntentId}`);
  }
  const result = Object.values(snapshot.entities.memoryImportResults).find(
    (candidate) => candidate.memoryImportIntentId === intent.memoryImportIntentId,
  );
  if (result === undefined) throw new ReplayError("Memory Import Result不存在");
  const sourceMessage = snapshot.entities.messages[intent.sourceSelection.sourceMessageId];
  if (sourceMessage === undefined) throw new ReplayError("Memory Import源Message不存在");

  const outbox = Object.values(snapshot.outbox)
    .filter(
      (
        entry,
      ): entry is Extract<
        (typeof snapshot.outbox)[string],
        { kind: "memory_import_start" | "memory_import_reconcile" }
      > =>
        (entry.kind === "memory_import_start" || entry.kind === "memory_import_reconcile") &&
        entry.memoryImportIntentId === intent.memoryImportIntentId,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((entry) => ({
      outboxId: entry.outboxId,
      kind: entry.kind,
      status: entry.status,
      revision: entry.revision,
      dispatchAttempts: entry.dispatchAttempts,
    }));
  const failures = new Set<string>();
  if (outbox.length === 0) failures.add("产品事实缺口：Memory Import没有关联Outbox");
  const runtimeEvidence = deps.readMemoryImportRuntimeEvidence?.({
    path: input.runtimeBindingsPath,
    memoryImportIntentId: intent.memoryImportIntentId,
    memoryImportResultId: result.memoryImportResultId,
    outbox,
  }) ?? { status: "missing", entries: [] };
  if (runtimeEvidence.status !== "ok") {
    failures.add(`Runtime证据${runtimeEvidence.status}：无法完整确认Import Workflow派发栅栏`);
  }
  const events = readTraceEvents({
    memoryImportIntentId: intent.memoryImportIntentId,
    ...(input.traceDir !== undefined ? { dir: input.traceDir } : {}),
  });
  checkMemoryImportTimeline(
    intent,
    result,
    new Set(outbox.map((entry) => entry.outboxId)),
    events,
    failures,
  );
  const timeline = events.map((event) => ({
    timestamp: event.timestamp,
    eventName: event.eventName,
    outcome: event.outcome,
    refs: [],
  }));

  let content: MemoryImportReplayContentProjection = { included: false };
  if (input.contentAccess !== undefined) {
    if (
      input.contentAccess.mode !== "authorized" ||
      input.contentAccess.principalId.trim() === "" ||
      input.contentAccess.purpose.trim() === "" ||
      deps.authorizeContentAccess?.(input.contentAccess) !== true
    ) {
      throw new ReplayError("未授权读取Product Store正文");
    }
    content = {
      included: true,
      facts: {
        sourceMessage,
        selectedContent: resolveMemoryImportContent({
          message: sourceMessage,
          selection: intent.sourceSelection,
          maxContentChars: intent.backendDescriptor.capabilities.maxContentChars,
        }),
      },
    };
  }

  return {
    memoryImportIntentId: intent.memoryImportIntentId,
    intent: {
      memoryImportResultId: result.memoryImportResultId,
      sourceMessageId: sourceMessage.messageId,
      selectionKind: intent.sourceSelection.kind,
      backendId: intent.backendId,
      intentRevision: intent.revision,
      requestSha256: intent.requestSha256,
      backendDescriptorSha256: intent.backendDescriptorSha256,
    },
    result: {
      status: result.status,
      revision: result.revision,
      dispatchAttempts: result.dispatchAttempts,
      reconcileAttempts: result.reconcileAttempts,
      externalObjectIdSha256:
        "externalObjectId" in result ? sha256Hex(result.externalObjectId) : null,
      errorCode: "errorCode" in result ? result.errorCode : null,
    },
    outbox,
    runtimeEvidence,
    downstreamUse: collectMemoryImportDownstreamUse(snapshot, result),
    timeline,
    content,
    failures: [...failures],
  };
}
