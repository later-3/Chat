import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  RUN_ACTIVITY_SCHEMA_VERSION,
  productRunIdSchema,
  runActivityEventSchema,
  type ProductRunId,
  type RunActivityEvent,
  type RunActivityEventInput,
  type TraceEventInput,
} from "@chat/contracts";
import { resolveRunActivityDir, runActivityFileName } from "./trace-paths.js";
import { runActivityFromTrace } from "./run-activity-mapper.js";

export interface RunActivitySink {
  readonly dir: string;
  emit(input: RunActivityEventInput): RunActivityEvent | undefined;
  emitTrace(input: TraceEventInput, timestamp?: string): RunActivityEvent | undefined;
}

export interface RunActivityReader {
  read(input: { readonly productRunId: ProductRunId }): Promise<readonly RunActivityEvent[]>;
}

export interface RunActivityJournalOptions {
  readonly dir?: string;
  readonly now?: () => Date;
}

interface RunState {
  sequence: number;
  fileSize: number;
  readonly sourcePayloads: Map<string, string>;
  readonly sourceSequences: Map<string, number>;
}

interface ReaderState {
  readonly events: RunActivityEvent[];
  readonly sourceKeys: Set<string>;
  completeBytes: number;
  observedBytes: number;
  mtimeMs: number;
}

function completePrefix(content: string): string {
  if (content.endsWith("\n")) return content;
  return content.slice(0, content.lastIndexOf("\n") + 1);
}

function eventPayload(event: RunActivityEvent): string {
  const payload = { ...event } as Partial<RunActivityEvent>;
  delete payload.schemaVersion;
  delete payload.sequence;
  return JSON.stringify(payload);
}

function parseLines(
  content: string,
  fileName: string,
  startSequence = 0,
  existingSourceKeys: ReadonlySet<string> = new Set(),
): RunActivityEvent[] {
  const events = completePrefix(content)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return runActivityEventSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `${fileName}:${String(startSequence + index + 1)} Run Activity合同损坏：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  const sourceKeys = new Set(existingSourceKeys);
  for (const [index, event] of events.entries()) {
    if (event.sequence !== startSequence + index + 1) {
      throw new Error(
        `${fileName}:${String(startSequence + index + 1)} Run Activity sequence不连续`,
      );
    }
    if (sourceKeys.has(event.sourceKey)) {
      throw new Error(
        `${fileName}:${String(startSequence + index + 1)} Run Activity sourceKey重复`,
      );
    }
    sourceKeys.add(event.sourceKey);
  }
  return events;
}

function assertRunIdentity(
  events: readonly RunActivityEvent[],
  productRunId: ProductRunId,
  fileName: string,
): void {
  if (events.some((event) => event.productRunId !== productRunId)) {
    throw new Error(`${fileName}包含其他Product Run的Activity`);
  }
}

/**
 * Workflow唯一写者使用的Run级Journal。每次追加前都会核对文件大小，因此测试进程或
 * 误配置的第二Sink不会凭旧缓存写出重复sequence；真正的并发多写者仍属于启动拓扑违规。
 */
export function createRunActivitySink(options: RunActivityJournalOptions = {}): RunActivitySink {
  const dir = resolveRunActivityDir(options);
  const now = options.now ?? (() => new Date());
  const states = new Map<string, RunState>();
  const nodeKinds = new Map<
    string,
    Extract<RunActivityEvent, { activityType: "agent" }>["nodeKind"]
  >();
  mkdirSync(dir, { recursive: true });

  const loadState = (productRunId: ProductRunId): RunState => {
    const fileName = runActivityFileName(productRunId);
    const file = join(dir, fileName);
    const content = existsSync(file) ? readFileSync(file, "utf8") : "";
    // Reader可短暂忽略并发append的尾行；Writer必须对残缺文件失败关闭，避免粘连JSON。
    if (content !== "" && !content.endsWith("\n")) {
      throw new Error(`${fileName}存在未完成尾行，拒绝继续写入`);
    }
    const events = parseLines(content, fileName);
    assertRunIdentity(events, productRunId, fileName);
    const sourceSequences = new Map<string, number>();
    for (const event of events) {
      if (event.activityType === "agent" && event.attemptId !== undefined) {
        nodeKinds.set(`${event.productRunId}:${event.attemptId}`, event.nodeKind);
      }
      if (event.sourceOperationId !== undefined && event.sourceSequence !== undefined) {
        sourceSequences.set(
          event.sourceOperationId,
          Math.max(sourceSequences.get(event.sourceOperationId) ?? 0, event.sourceSequence),
        );
      }
    }
    const state = {
      sequence: events.at(-1)?.sequence ?? 0,
      fileSize: Buffer.byteLength(content),
      sourcePayloads: new Map(events.map((event) => [event.sourceKey, eventPayload(event)])),
      sourceSequences,
    };
    states.set(productRunId, state);
    return state;
  };

  const stateFor = (productRunId: ProductRunId): RunState => {
    const file = join(dir, runActivityFileName(productRunId));
    const cached = states.get(productRunId);
    const actualSize = existsSync(file) ? statSync(file).size : 0;
    return cached === undefined || cached.fileSize !== actualSize
      ? loadState(productRunId)
      : cached;
  };

  const sink: RunActivitySink = {
    dir,
    emit(input) {
      // 在任何路径拼接/读取前先校验，防止内部边界漂移演化为路径穿越。
      const productRunId = productRunIdSchema.parse(input.productRunId);
      const state = stateFor(productRunId);
      const event = runActivityEventSchema.parse({
        schemaVersion: RUN_ACTIVITY_SCHEMA_VERSION,
        sequence: state.sequence + 1,
        ...input,
        productRunId,
      });
      const payload = eventPayload(event);
      const existingPayload = state.sourcePayloads.get(event.sourceKey);
      if (existingPayload !== undefined) {
        if (existingPayload !== payload) {
          throw new Error(`Run Activity sourceKey冲突：${event.sourceKey}`);
        }
        return undefined;
      }
      if (event.sourceOperationId !== undefined && event.sourceSequence !== undefined) {
        const highWater = state.sourceSequences.get(event.sourceOperationId) ?? 0;
        if (event.sourceSequence < highWater) {
          throw new Error(
            `Run Activity源序列倒退：${event.sourceOperationId}:${String(event.sourceSequence)} < ${String(highWater)}`,
          );
        }
      }
      const line = `${JSON.stringify(event)}\n`;
      appendFileSync(join(dir, runActivityFileName(event.productRunId)), line, {
        encoding: "utf8",
        mode: 0o600,
      });
      state.sequence = event.sequence;
      state.fileSize += Buffer.byteLength(line);
      state.sourcePayloads.set(event.sourceKey, payload);
      if (event.sourceOperationId !== undefined && event.sourceSequence !== undefined) {
        state.sourceSequences.set(
          event.sourceOperationId,
          Math.max(state.sourceSequences.get(event.sourceOperationId) ?? 0, event.sourceSequence),
        );
      }
      return event;
    },
    emitTrace(input, timestamp) {
      let activity = runActivityFromTrace(input, timestamp ?? now().toISOString());
      if (activity === undefined) return undefined;
      if (activity.activityType === "agent" && activity.attemptId !== undefined) {
        nodeKinds.set(`${activity.productRunId}:${activity.attemptId}`, activity.nodeKind);
      } else if (activity.activityType === "model" && activity.attemptId !== undefined) {
        const nodeKind = nodeKinds.get(`${activity.productRunId}:${activity.attemptId}`);
        if (nodeKind !== undefined) activity = { ...activity, nodeKind };
      }
      return sink.emit(activity);
    },
  };
  return sink;
}

async function fileStat(file: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const value = await stat(file);
    return { size: value.size, mtimeMs: value.mtimeMs };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readBytes(file: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * API进程共享的增量Reader：文件未变化时零I/O，append后只读取新增字节；并发Writer留下的
 * 未换行尾段暂不发布，下一次读取会从最后一个完整换行继续。
 */
export function createRunActivityReader(
  options: { readonly dir?: string } = {},
): RunActivityReader {
  const dir = resolveRunActivityDir(options);
  const cache = new Map<ProductRunId, ReaderState>();

  return {
    async read({ productRunId }) {
      const validatedRunId = productRunIdSchema.parse(productRunId);
      const fileName = runActivityFileName(validatedRunId);
      const file = join(dir, fileName);
      const metadata = await fileStat(file);
      if (metadata === undefined) {
        cache.delete(validatedRunId);
        return [];
      }

      const cached = cache.get(validatedRunId);
      if (
        cached !== undefined &&
        metadata.size === cached.observedBytes &&
        metadata.mtimeMs === cached.mtimeMs
      ) {
        return cached.events;
      }

      const canAppend = cached !== undefined && metadata.size >= cached.observedBytes;
      const start = canAppend ? cached.completeBytes : 0;
      const bytes = await readBytes(file, start, metadata.size - start);
      const content = bytes.toString("utf8");
      const complete = completePrefix(content);
      const baseEvents = canAppend ? cached.events : [];
      const sourceKeys = canAppend ? cached.sourceKeys : new Set<string>();
      const appended = parseLines(complete, fileName, baseEvents.length, sourceKeys);
      assertRunIdentity(appended, validatedRunId, fileName);
      const events = canAppend ? [...baseEvents, ...appended] : appended;
      const next: ReaderState = {
        events,
        sourceKeys: new Set(events.map((event) => event.sourceKey)),
        completeBytes: start + Buffer.byteLength(complete),
        observedBytes: start + bytes.byteLength,
        mtimeMs: metadata.mtimeMs,
      };
      cache.set(validatedRunId, next);
      return next.events;
    },
  };
}

export async function readRunActivityEvents(input: {
  readonly dir?: string;
  readonly productRunId: ProductRunId;
}): Promise<RunActivityEvent[]> {
  const reader = createRunActivityReader(input.dir === undefined ? {} : { dir: input.dir });
  return [...(await reader.read({ productRunId: input.productRunId }))];
}
