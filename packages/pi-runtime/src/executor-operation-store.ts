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
  ) {}

  static async open(
    directory: string,
    options: { readonly now?: () => Date } = {},
  ): Promise<PiExecutorOperationStore> {
    const store = new PiExecutorOperationStore(directory, options.now ?? (() => new Date()));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = await readFile(join(directory, entry.name), "utf8");
      const record = operationRecordSchema.parse(JSON.parse(raw));
      if (`${record.operationId}.json` !== entry.name) {
        throw new Error("Pi Executor Operation文件名与内容身份不一致");
      }
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
    await this.mutate(operationId, async (record) => {
      const current = this.requireMutableRecord(record);
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
        value: undefined,
      };
    });
  }

  async fail(operationId: string, errorCode: string, durationMs: number): Promise<void> {
    await this.mutate(operationId, async (record) => {
      const current = this.requireMutableRecord(record);
      if (current.status === "succeeded" || current.status === "failed") {
        return { record: current, value: undefined };
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
        const completedToolCalls = new Set(
          current.events.flatMap((event) =>
            event.type === "tool.completed" ||
            event.type === "tool.failed" ||
            event.type === "tool.outcome_unknown"
              ? [event.toolCallId]
              : [],
          ),
        );
        for (const intent of current.events) {
          if (
            intent.type !== "tool.intent_persisted" ||
            completedToolCalls.has(intent.toolCallId)
          ) {
            continue;
          }
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
