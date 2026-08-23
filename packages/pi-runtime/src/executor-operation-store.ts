import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { executorStepCandidateSchema } from "./executor.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  piExecutorEventSchema,
  piExecutorOperationSnapshotSchema,
  piExecutorOperationStatusSchema,
  piOperationIdSchema,
  piRuntimeSessionIdSchema,
  startPiExecutorOperationRequestSchema,
  type PiExecutorEvent,
  type PiExecutorOperationSnapshot,
  type StartPiExecutorOperationRequest,
} from "./executor-service-contract.js";

const STORE_SCHEMA_VERSION = "pi-executor-operation-store.v1";
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
  .max(80);

const operationRecordSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    operationId: piOperationIdSchema,
    requestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    request: startPiExecutorOperationRequestSchema,
    status: piExecutorOperationStatusSchema,
    sessionId: piRuntimeSessionIdSchema.optional(),
    events: z.array(piExecutorEventSchema).max(100_000),
    result: executorStepCandidateSchema.optional(),
    resultSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    errorCode: stableErrorCodeSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

type OperationRecord = z.infer<typeof operationRecordSchema>;
export type PiExecutorEventPayload = PiExecutorEvent extends infer Event
  ? Event extends PiExecutorEvent
    ? Omit<Event, "sequence" | "timestamp">
    : never
  : never;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function hashExecutorValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export class PiExecutorOperationConflictError extends Error {
  readonly code = "executor.operation_id_reused";
  constructor() {
    super("Pi Operation ID已绑定不同请求");
    this.name = "PiExecutorOperationConflictError";
  }
}

export class PiExecutorOperationNotFoundError extends Error {
  readonly code = "executor.operation_not_found";
  constructor() {
    super("Pi Operation不存在");
    this.name = "PiExecutorOperationNotFoundError";
  }
}

export class PiExecutorOperationOutcomeUnknownError extends Error {
  readonly code = "executor.tool_result_persist_failed";
  constructor() {
    super("Tool已经执行但结果Journal未闭合，Operation结果未知");
    this.name = "PiExecutorOperationOutcomeUnknownError";
  }
}

export class PiExecutorOperationStateConflictError extends Error {
  readonly code = "executor.operation_state_conflict";
  constructor() {
    super("Pi Operation当前状态不允许该转换");
    this.name = "PiExecutorOperationStateConflictError";
  }
}

export class PiExecutorToolCallConflictError extends Error {
  readonly code = "executor.tool_call_id_reused";
  constructor() {
    super("同一Pi Operation内的Tool Call ID不能重复");
    this.name = "PiExecutorToolCallConflictError";
  }
}

export class PiExecutorToolResultConflictError extends Error {
  readonly code = "executor.tool_result_intent_mismatch";
  constructor() {
    super("Pi Tool Result没有精确匹配唯一耐久Intent");
    this.name = "PiExecutorToolResultConflictError";
  }
}

export class PiExecutorJournalIntegrityError extends Error {
  readonly code = "executor.journal_integrity_invalid";
  constructor() {
    super("Pi Executor Journal语义完整性校验失败");
    this.name = "PiExecutorJournalIntegrityError";
  }
}

type ToolIntentEvent = Extract<PiExecutorEvent, { type: "tool.intent_persisted" }>;

/** v1文件加载时重放Tool身份状态机，结构合法但时序/身份矛盾的成功记录必须失败关闭。 */
function scanToolJournal(record: OperationRecord): readonly ToolIntentEvent[] {
  const intents = new Map<string, ToolIntentEvent>();
  const closed = new Set<string>();
  let hasUnknownToolResult = false;
  for (const [index, event] of record.events.entries()) {
    if (event.sequence !== index + 1 || event.operationId !== record.operationId) {
      throw new PiExecutorJournalIntegrityError();
    }
    if (event.type === "tool.intent_persisted") {
      if (intents.has(event.toolCallId) || event.sessionId !== record.sessionId) {
        throw new PiExecutorJournalIntegrityError();
      }
      intents.set(event.toolCallId, event);
      continue;
    }
    if (
      event.type !== "tool.completed" &&
      event.type !== "tool.failed" &&
      event.type !== "tool.outcome_unknown"
    ) {
      continue;
    }
    const intent = intents.get(event.toolCallId);
    if (
      intent === undefined ||
      closed.has(event.toolCallId) ||
      intent.sessionId !== event.sessionId ||
      intent.turnIndex !== event.turnIndex ||
      intent.toolName !== event.toolName ||
      (event.inputSha256 !== undefined && intent.inputSha256 !== event.inputSha256)
    ) {
      throw new PiExecutorJournalIntegrityError();
    }
    closed.add(event.toolCallId);
    if (event.type === "tool.outcome_unknown") hasUnknownToolResult = true;
  }
  const open = [...intents.values()].filter((intent) => !closed.has(intent.toolCallId));
  if (record.request.operationId !== record.operationId) {
    throw new PiExecutorJournalIntegrityError();
  }
  if (hashExecutorValue(record.request) !== record.requestSha256) {
    throw new PiExecutorJournalIntegrityError();
  }
  if (record.status === "succeeded") {
    const completed = record.events.filter((event) => event.type === "operation.completed");
    if (
      open.length > 0 ||
      hasUnknownToolResult ||
      completed.length !== 1 ||
      record.events.at(-1)?.type !== "operation.completed" ||
      record.sessionId === undefined ||
      record.result === undefined ||
      record.resultSha256 !== hashExecutorValue(record.result) ||
      record.errorCode !== undefined
    ) {
      throw new PiExecutorJournalIntegrityError();
    }
  }
  return open;
}

interface PersistBoundaryEvidence {
  readonly operationId: string;
  readonly status: OperationRecord["status"];
  readonly lastEventType: PiExecutorEvent["type"] | undefined;
}

/**
 * 每个Operation一个0600 JSON文件。事件与状态在同一次原子rename中提交，因此
 * “tool.intent_persisted”成功返回时，副作用意图一定已耐久化。服务重启不自动重放
 * running Operation，而是把未闭合Tool与Operation收敛为outcome_unknown。
 */
export class PiExecutorOperationStore {
  private readonly records = new Map<string, OperationRecord>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  private constructor(
    private readonly directory: string,
    private readonly now: () => Date,
    private readonly beforePersist?:
      ((evidence: PersistBoundaryEvidence) => void | Promise<void>) | undefined,
  ) {}

  static async open(
    directory: string,
    options: {
      readonly now?: () => Date;
      /** 只用于确定性存储故障测试；回调不接收Prompt、Tool正文或完整Record。 */
      readonly beforePersist?: (evidence: PersistBoundaryEvidence) => void | Promise<void>;
    } = {},
  ): Promise<PiExecutorOperationStore> {
    const store = new PiExecutorOperationStore(
      directory,
      options.now ?? (() => new Date()),
      options.beforePersist,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = await readFile(join(directory, entry.name), "utf8");
      const record = operationRecordSchema.parse(JSON.parse(raw));
      if (`${record.operationId}.json` !== entry.name) {
        throw new Error("Pi Executor Operation文件名与内容身份不一致");
      }
      scanToolJournal(record);
      store.records.set(record.operationId, record);
    }
    await store.reconcileInterruptedOperations();
    return store;
  }

  async createOrGet(
    rawRequest: StartPiExecutorOperationRequest,
  ): Promise<{ readonly snapshot: PiExecutorOperationSnapshot; readonly created: boolean }> {
    const request = startPiExecutorOperationRequestSchema.parse(rawRequest);
    const requestSha256 = hashExecutorValue(request);
    return this.mutate<{
      readonly snapshot: PiExecutorOperationSnapshot;
      readonly created: boolean;
    }>(request.operationId, async (existing) => {
      if (existing !== undefined) {
        if (existing.requestSha256 !== requestSha256) throw new PiExecutorOperationConflictError();
        return {
          record: existing,
          value: { snapshot: this.snapshot(existing), created: false as boolean },
        };
      }
      const timestamp = this.now().toISOString();
      const accepted = piExecutorEventSchema.parse({
        sequence: 1,
        timestamp,
        operationId: request.operationId,
        type: "operation.accepted",
        requestSha256,
        ...(request.contract.workspaceRef !== undefined
          ? { workspaceRootId: request.contract.workspaceRef.rootId }
          : {}),
      });
      const record = operationRecordSchema.parse({
        schemaVersion: STORE_SCHEMA_VERSION,
        operationId: request.operationId,
        requestSha256,
        request,
        status: "queued",
        events: [accepted],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return { record, value: { snapshot: this.snapshot(record), created: true as boolean } };
    });
  }

  getRequest(operationId: string): StartPiExecutorOperationRequest {
    return structuredClone(this.requireRecord(operationId).request);
  }

  getSnapshot(operationId: string): PiExecutorOperationSnapshot {
    return this.snapshot(this.requireRecord(operationId));
  }

  getEvents(operationId: string, afterSequence = 0): readonly PiExecutorEvent[] {
    const record = this.requireRecord(operationId);
    return structuredClone(record.events.filter((event) => event.sequence > afterSequence));
  }

  async markRunning(operationId: string): Promise<void> {
    await this.mutate(operationId, async (record) => {
      const current = this.requireMutableRecord(record);
      if (current.status !== "queued") return { record: current, value: undefined };
      const next = this.appendToRecord(current, {
        operationId: current.operationId,
        type: "operation.started",
        requestSha256: current.requestSha256,
      });
      return { record: { ...next, status: "running" }, value: undefined };
    });
  }

  async setSession(
    operationId: string,
    sessionId: string,
    enabledTools: readonly string[],
  ): Promise<void> {
    await this.mutate(operationId, async (record) => {
      const current = this.requireMutableRecord(record);
      const next = this.appendToRecord(current, {
        operationId: current.operationId,
        type: "session.started",
        sessionId: piRuntimeSessionIdSchema.parse(sessionId),
        enabledTools: enabledTools as never,
      });
      return { record: { ...next, sessionId }, value: undefined };
    });
  }

  async append(operationId: string, payload: PiExecutorEventPayload): Promise<PiExecutorEvent> {
    return this.mutate(operationId, async (record) => {
      const current = this.requireMutableRecord(record);
      if (current.status !== "running") throw new Error("只有running Operation能追加运行事件");
      if (
        payload.type === "tool.intent_persisted" &&
        current.events.some(
          (event) =>
            event.type === "tool.intent_persisted" && event.toolCallId === payload.toolCallId,
        )
      ) {
        // Tool Call ID是一次Operation内不可复用的Intent身份；否则旧Result会误闭合新Intent。
        throw new PiExecutorToolCallConflictError();
      }
      if (payload.type === "tool.completed" || payload.type === "tool.failed") {
        const intent = this.openToolIntents(current).find(
          (candidate) => candidate.toolCallId === payload.toolCallId,
        );
        if (
          intent === undefined ||
          intent.sessionId !== payload.sessionId ||
          intent.turnIndex !== payload.turnIndex ||
          intent.toolName !== payload.toolName ||
          intent.inputSha256 !== payload.inputSha256
        ) {
          throw new PiExecutorToolResultConflictError();
        }
      }
      const next = this.appendToRecord(current, payload);
      const event = next.events.at(-1);
      if (event === undefined) throw new Error("Pi Executor事件追加失败");
      return { record: next, value: structuredClone(event) };
    });
  }

  async complete(
    operationId: string,
    result: z.infer<typeof executorStepCandidateSchema>,
    durationMs: number,
  ): Promise<void> {
    const completed = await this.mutate(operationId, async (record) => {
      let current = this.requireMutableRecord(record);
      if (current.status === "succeeded") {
        return { record: current, value: "already_succeeded" as const };
      }
      if (current.status === "outcome_unknown") {
        return { record: current, value: "outcome_unknown" as const };
      }
      if (current.status !== "running") {
        return { record: current, value: "state_conflict" as const };
      }
      if (this.openToolIntents(current).length > 0) {
        current = this.closeOpenToolIntentsAsUnknown(current);
        const unknown = this.appendToRecord(current, {
          operationId: current.operationId,
          type: "operation.outcome_unknown",
          requestSha256: current.requestSha256,
          errorCode: "executor.tool_result_persist_failed",
          durationMs,
        });
        return {
          record: {
            ...unknown,
            status: "outcome_unknown" as const,
            errorCode: "executor.tool_result_persist_failed",
          },
          value: "outcome_unknown" as const,
        };
      }
      const parsedResult = executorStepCandidateSchema.parse(result);
      const resultSha256 = hashExecutorValue(parsedResult);
      const next = this.appendToRecord(current, {
        operationId: current.operationId,
        type: "operation.completed",
        requestSha256: current.requestSha256,
        resultSha256,
        durationMs,
      });
      return {
        record: {
          ...next,
          status: "succeeded",
          result: parsedResult,
          resultSha256,
          errorCode: undefined,
        },
        value: "completed" as const,
      };
    });
    if (completed === "outcome_unknown") throw new PiExecutorOperationOutcomeUnknownError();
    if (completed === "state_conflict") throw new PiExecutorOperationStateConflictError();
  }

  async markOutcomeUnknown(
    operationId: string,
    errorCode: string,
    durationMs: number,
  ): Promise<void> {
    await this.mutate(operationId, async (record) => {
      let current = this.requireMutableRecord(record);
      if (current.status === "outcome_unknown") return { record: current, value: undefined };
      if (current.status !== "running") throw new PiExecutorOperationStateConflictError();
      current = this.closeOpenToolIntentsAsUnknown(current);
      const next = this.appendToRecord(current, {
        operationId: current.operationId,
        type: "operation.outcome_unknown",
        requestSha256: current.requestSha256,
        errorCode: stableErrorCodeSchema.parse(errorCode),
        durationMs,
      });
      return {
        record: {
          ...next,
          status: "outcome_unknown" as const,
          errorCode: stableErrorCodeSchema.parse(errorCode),
        },
        value: undefined,
      };
    });
  }

  async fail(operationId: string, errorCode: string, durationMs: number): Promise<void> {
    await this.mutate(operationId, async (record) => {
      let current = this.requireMutableRecord(record);
      if (
        current.status === "succeeded" ||
        current.status === "failed" ||
        current.status === "outcome_unknown"
      ) {
        return { record: current, value: undefined };
      }
      if (this.openToolIntents(current).length > 0) {
        current = this.closeOpenToolIntentsAsUnknown(current);
        const next = this.appendToRecord(current, {
          operationId: current.operationId,
          type: "operation.outcome_unknown",
          requestSha256: current.requestSha256,
          errorCode: "executor.tool_result_persist_failed",
          durationMs,
        });
        return {
          record: {
            ...next,
            status: "outcome_unknown",
            errorCode: "executor.tool_result_persist_failed",
          },
          value: undefined,
        };
      }
      const next = this.appendToRecord(current, {
        operationId: current.operationId,
        type: "operation.failed",
        requestSha256: current.requestSha256,
        errorCode: stableErrorCodeSchema.parse(errorCode),
        durationMs,
      });
      return { record: { ...next, status: "failed", errorCode }, value: undefined };
    });
  }

  private async reconcileInterruptedOperations(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.status !== "queued" && record.status !== "running") continue;
      await this.mutate(record.operationId, async (loaded) => {
        let current = this.requireMutableRecord(loaded);
        current = this.closeOpenToolIntentsAsUnknown(current);
        const startedAt = current.events.find(
          (event) => event.type === "operation.started",
        )?.timestamp;
        const durationMs =
          startedAt === undefined ? 0 : Math.max(0, this.now().getTime() - Date.parse(startedAt));
        current = this.appendToRecord(current, {
          operationId: current.operationId,
          type: "operation.outcome_unknown",
          requestSha256: current.requestSha256,
          errorCode: "executor.operation_interrupted",
          durationMs,
        });
        return {
          record: {
            ...current,
            status: "outcome_unknown",
            errorCode: "executor.operation_interrupted",
          },
          value: undefined,
        };
      });
    }
  }

  private appendToRecord(
    record: OperationRecord,
    payload: PiExecutorEventPayload,
  ): OperationRecord {
    const timestamp = this.now().toISOString();
    const event = piExecutorEventSchema.parse({
      ...payload,
      sequence: record.events.length + 1,
      timestamp,
    });
    return operationRecordSchema.parse({
      ...record,
      events: [...record.events, event],
      updatedAt: timestamp,
    });
  }

  private openToolIntents(
    record: OperationRecord,
  ): Array<Extract<PiExecutorEvent, { type: "tool.intent_persisted" }>> {
    return [...scanToolJournal(record)];
  }

  private closeOpenToolIntentsAsUnknown(record: OperationRecord): OperationRecord {
    let current = record;
    for (const intent of this.openToolIntents(record)) {
      current = this.appendToRecord(current, {
        operationId: current.operationId,
        type: "tool.outcome_unknown",
        sessionId: intent.sessionId,
        turnIndex: intent.turnIndex,
        toolCallId: intent.toolCallId,
        toolName: intent.toolName,
        inputSha256: intent.inputSha256,
        inputDisplay: intent.inputDisplay,
        inputDisplayTruncated: intent.inputDisplayTruncated,
      });
    }
    return current;
  }

  private snapshot(record: OperationRecord): PiExecutorOperationSnapshot {
    return piExecutorOperationSnapshotSchema.parse({
      schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
      operationId: record.operationId,
      requestSha256: record.requestSha256,
      status: record.status,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      lastEventSequence: record.events.at(-1)?.sequence ?? 0,
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.resultSha256 !== undefined ? { resultSha256: record.resultSha256 } : {}),
      ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private requireRecord(operationId: string): OperationRecord {
    piOperationIdSchema.parse(operationId);
    const record = this.records.get(operationId);
    if (record === undefined) throw new PiExecutorOperationNotFoundError();
    return record;
  }

  private requireMutableRecord(record: OperationRecord | undefined): OperationRecord {
    if (record === undefined) throw new PiExecutorOperationNotFoundError();
    return record;
  }

  private async persist(record: OperationRecord): Promise<void> {
    const parsed = operationRecordSchema.parse(record);
    await this.beforePersist?.({
      operationId: parsed.operationId,
      status: parsed.status,
      lastEventType: parsed.events.at(-1)?.type,
    });
    const target = join(this.directory, `${parsed.operationId}.json`);
    const temporary = join(this.directory, `.${parsed.operationId}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
    this.records.set(parsed.operationId, parsed);
  }

  private async mutate<T>(
    operationId: string,
    mutation: (
      record: OperationRecord | undefined,
    ) => Promise<{ readonly record: OperationRecord; readonly value: T }>,
  ): Promise<T> {
    const previous = this.mutationTails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.mutationTails.set(operationId, queued);
    await previous;
    try {
      const output = await mutation(this.records.get(operationId));
      await this.persist(output.record);
      return output.value;
    } finally {
      release();
      if (this.mutationTails.get(operationId) === queued) this.mutationTails.delete(operationId);
    }
  }
}
