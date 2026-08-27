import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  traceEventSchema,
  definitionNodeIdSchema,
  workflowNodeTypeSchema,
  productRunIdSchema,
  requestIdSchema,
  runAttemptIdSchema,
  type TraceEvent,
  type TraceEventInput,
} from "@chat/contracts";
import { describe, expect, it, vi } from "vitest";
import { runTraceCli } from "./trace-cli.js";
import { TraceReadError, readTraceEvents } from "./trace-reader.js";
import { createTraceSink } from "./trace-sink.js";
import { createConfiguredTraceSink, tracePolicyFromEnvironment } from "./trace-policy.js";
import { createExecutionTraceReader } from "./execution-trace-reader.js";
import {
  createRunActivityReader,
  createRunActivitySink,
  readRunActivityEvents,
} from "./run-activity-journal.js";
import { migrateLegacyTraceToRunActivity } from "./legacy-trace-activity-migration.js";

/** 合成泄漏标记：证明正文根本无法写入，而不是写入后变成[redacted]。 */
const CONTENT_MARKER = "TRACE_CONTENT_MUST_NEVER_BE_WRITTEN";
const SHA256_A = "a".repeat(64);
const RUN_A = productRunIdSchema.parse("run_abc123");
const RUN_B = productRunIdSchema.parse("run_other99");
const RUN_CLI = productRunIdSchema.parse("run_cli123");
const REQ_T1 = requestIdSchema.parse("req_t1");
const ATT_A = runAttemptIdSchema.parse("att_abc123");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "chat-trace-"));
}

function readAllEvents(dir: string): TraceEvent[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => traceEventSchema.parse(JSON.parse(line))),
    );
}

function rawLines(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== ""),
    );
}

const httpReceivedInput: TraceEventInput = {
  level: "info",
  eventName: "http.command.received",
  traceId: "trace_t1",
  spanId: "span_t1",
  requestId: REQ_T1,
  outcome: "unknown",
  httpMethod: "POST",
};

const providerCompletedInput: TraceEventInput = {
  level: "info",
  eventName: "provider.request.completed",
  traceId: "trace_t2",
  spanId: "span_t2",
  productRunId: RUN_A,
  attemptId: ATT_A,
  promptTemplateVersion: "planner-1.0.0",
  modelConfigVersion: "bailian-qwen-1.0.0",
  outcome: "success",
  provider: "bailian",
  model: "qwen3.7-plus",
  endpointHost: "dashscope.aliyuncs.com",
  operation: "chat_completion",
  httpStatus: 200,
  providerRequestId: "req-0a1b",
  tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  inputManifestSha256: SHA256_A,
  durationMs: 42,
};

describe("createTraceSink", () => {
  it("写入合法JSONL并生成schemaVersion/eventId/timestamp", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    const event = sink.emit(httpReceivedInput);
    expect(event.schemaVersion).toBe(1);
    expect(event.eventId).toMatch(/^evt_/);
    const events = readAllEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.traceId).toBe("trace_t1");
  });

  it("Provider事件白名单字段完整保留", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    sink.emit(providerCompletedInput);
    const event = readAllEvents(dir)[0];
    expect(event?.eventName).toBe("provider.request.completed");
    if (event?.eventName === "provider.request.completed") {
      expect(event.model).toBe("qwen3.7-plus");
      expect(event.providerRequestId).toBe("req-0a1b");
      expect(event.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    }
  });

  it("未声明字段失败关闭且不写入JSONL", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    for (const key of ["body", "content", "message", "prompt", "payload", "attributes"]) {
      expect(() =>
        sink.emit({ ...httpReceivedInput, [key]: CONTENT_MARKER } as TraceEventInput),
      ).toThrow();
    }
    expect(rawLines(dir)).toHaveLength(0);
  });

  it("嵌套对象中的未声明字段同样失败关闭", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    expect(() =>
      sink.emit({
        ...providerCompletedInput,
        tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, raw: CONTENT_MARKER },
      } as unknown as TraceEventInput),
    ).toThrow();
    expect(rawLines(dir)).toHaveLength(0);
  });

  it("合成正文标记无法写入Trace文件", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    sink.emit(httpReceivedInput);
    sink.emit(providerCompletedInput);
    // 合法写入的事件本身不含标记；含标记的写入全部失败
    for (const line of rawLines(dir)) {
      expect(line).not.toContain(CONTENT_MARKER);
    }
  });

  it("按日bounded文件达到容量上限后停止增长但不影响调用方", () => {
    const dir = tempDir();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sink = createTraceSink({ dir, maxDailyBytes: 700 });
      for (let index = 0; index < 10; index += 1) {
        expect(() =>
          sink.emit({ ...httpReceivedInput, traceId: `trace_capacity${index}` }),
        ).not.toThrow();
      }
      expect(sink.droppedEvents).toBeGreaterThan(0);
      expect(rawLines(dir).length).toBeGreaterThan(0);
      expect(rawLines(dir).length).toBeLessThan(10);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("capacity_reached"));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("模块化Trace策略", () => {
  it("默认完全关闭，且显式full只启用选中的模块", () => {
    expect(tracePolicyFromEnvironment({}).mode).toBe("off");
    expect(createConfiguredTraceSink({ scope: "api", env: {} })).toBeUndefined();
    const dir = tempDir();
    const sink = createConfiguredTraceSink({
      scope: "workflow",
      env: { CHAT_TRACE_MODE: "full", CHAT_TRACE_SCOPES: "workflow,pi" },
      sinkOptions: { dir },
    });
    expect(sink).toBeDefined();
    sink?.emit(httpReceivedInput);
    expect(readAllEvents(dir)).toHaveLength(1);
    expect(
      createConfiguredTraceSink({
        scope: "api",
        env: { CHAT_TRACE_MODE: "full", CHAT_TRACE_SCOPES: "workflow,pi" },
        sinkOptions: { dir },
      }),
    ).toBeUndefined();
  });

  it("errors模式只持久化失败或拒绝事件", () => {
    const dir = tempDir();
    const sink = createConfiguredTraceSink({
      scope: "api",
      env: { CHAT_TRACE_MODE: "errors", CHAT_TRACE_SCOPES: "api" },
      sinkOptions: { dir },
    });
    sink?.emit(httpReceivedInput);
    sink?.emit({
      level: "warn",
      eventName: "http.command.rejected",
      traceId: "trace_policy1",
      spanId: "span_policy1",
      requestId: REQ_T1,
      outcome: "rejected",
      httpMethod: "POST",
      statusCode: 422,
      errorCode: "http_4xx",
    });
    expect(readAllEvents(dir).map((event) => event.eventName)).toEqual(["http.command.rejected"]);
  });

  it("未知模块配置失败关闭", () => {
    expect(() =>
      tracePolicyFromEnvironment({ CHAT_TRACE_MODE: "full", CHAT_TRACE_SCOPES: "api,unknown" }),
    ).toThrow(/未知模块/u);
  });
});

describe("readTraceEvents", () => {
  function emitAt(dir: string, offsetMs: number, input: TraceEventInput) {
    createTraceSink({
      dir,
      now: () => new Date(Date.parse("2026-08-07T00:00:00.000Z") + offsetMs),
    }).emit(input);
  }

  it("按productRunId过滤并按时间排序", () => {
    const dir = tempDir();
    // http.command.received尚无Run关联；用Provider事件验证按Run过滤
    emitAt(dir, 2000, { ...providerCompletedInput, traceId: "t_a1" });
    emitAt(dir, 3000, { ...httpReceivedInput, traceId: "t_b1" });
    emitAt(dir, 1000, { ...providerCompletedInput, traceId: "t_a2" });
    emitAt(dir, 500, { ...providerCompletedInput, traceId: "t_c1", productRunId: RUN_B });
    const runA = readTraceEvents({ dir, productRunId: "run_abc123" });
    expect(runA.map((event) => event.traceId)).toEqual(["t_a2", "t_a1"]);
  });

  it("损坏行失败关闭并报告文件与行号，原始文件保持未修改", () => {
    const dir = tempDir();
    const file = join(dir, "chat-trace-2026-08-07.jsonl");
    const original = '{"bad json\n';
    writeFileSync(file, original, "utf8");
    try {
      readTraceEvents({ dir });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TraceReadError);
      expect((error as TraceReadError).file).toBe("chat-trace-2026-08-07.jsonl");
      expect((error as TraceReadError).line).toBe(1);
    }
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("旧版任意attributes事件失败关闭且不修改原文件", () => {
    const dir = tempDir();
    const file = join(dir, "chat-trace-2026-08-06.jsonl");
    const legacy = JSON.stringify({
      schemaVersion: 1,
      eventId: "evt_legacy",
      timestamp: "2026-08-06T00:00:00.000Z",
      level: "info",
      eventName: "http.command.received",
      traceId: "trace_legacy",
      spanId: "span_legacy",
      outcome: "unknown",
      attributes: { "http.method": "GET", body: CONTENT_MARKER },
    });
    writeFileSync(file, `${legacy}\n`, "utf8");
    expect(() => readTraceEvents({ dir })).toThrowError(TraceReadError);
    expect(readFileSync(file, "utf8")).toBe(`${legacy}\n`);
  });

  it("跳过已退役Project事件且继续读取同文件中的当前事件", () => {
    const dir = tempDir();
    const file = join(dir, "chat-trace-2026-08-07.jsonl");
    const retired = JSON.stringify({
      schemaVersion: 1,
      eventId: "evt_retired1",
      timestamp: "2026-08-07T00:00:00.000Z",
      level: "info",
      traceId: "trace_retired1",
      spanId: "span_retired1",
      outcome: "unknown",
      eventName: "project.intake.started",
    });
    writeFileSync(file, `${retired}\n`, "utf8");
    emitAt(dir, 1000, { ...providerCompletedInput, traceId: "t_current1" });

    expect(readTraceEvents({ dir }).map((event) => event.traceId)).toEqual(["t_current1"]);
    expect(readFileSync(file, "utf8")).toContain(retired);
  });

  it("未知或缺少公共Envelope的project事件仍失败关闭", () => {
    const dir = tempDir();
    const file = join(dir, "chat-trace-2026-08-07.jsonl");
    writeFileSync(file, `${JSON.stringify({ eventName: "project.evil" })}\n`, "utf8");

    expect(() => readTraceEvents({ dir })).toThrowError(TraceReadError);
  });

  it("目录不存在时返回空结果", () => {
    expect(readTraceEvents({ dir: join(tempDir(), "missing") })).toEqual([]);
  });
});

describe("createExecutionTraceReader", () => {
  it("Run Activity按Run隔离并在Workflow重放时按sourceKey去重", async () => {
    const dir = tempDir();
    const sink = createRunActivitySink({ dir });
    const activity = {
      productRunId: RUN_A,
      attemptId: ATT_A,
      timestamp: "2026-08-21T00:00:00.000Z",
      sourceKey: "workflow:run_abc123:att_abc123:agent:planner:started",
      sourceKind: "workflow" as const,
      activityType: "agent" as const,
      phase: "started" as const,
      nodeKind: "planner" as const,
    };
    expect(sink.emit(activity)?.sequence).toBe(1);
    expect(sink.emit(activity)).toBeUndefined();
    sink.emit({ ...activity, productRunId: RUN_B, sourceKey: "workflow:run_other99:agent" });
    expect(await readRunActivityEvents({ dir, productRunId: RUN_A })).toHaveLength(1);
    expect(await readRunActivityEvents({ dir, productRunId: RUN_B })).toHaveLength(1);

    // 进程重启后仍从现有Run文件恢复sequence与去重集合。
    const reopened = createRunActivitySink({ dir });
    expect(reopened.emit(activity)).toBeUndefined();
    expect(
      reopened.emit({
        ...activity,
        sourceKey: `${activity.sourceKey}:completed`,
        phase: "completed",
      })?.sequence,
    ).toBe(2);
  });

  it("两个Sink交错追加时会刷新文件位置且保持唯一sequence", async () => {
    const dir = tempDir();
    const first = createRunActivitySink({ dir });
    const second = createRunActivitySink({ dir });
    const activity = {
      productRunId: RUN_A,
      attemptId: ATT_A,
      timestamp: "2026-08-21T00:00:00.000Z",
      sourceKind: "workflow" as const,
      activityType: "agent" as const,
      nodeKind: "planner" as const,
    };
    first.emit({ ...activity, sourceKey: "workflow:agent:1", phase: "started" });
    second.emit({ ...activity, sourceKey: "workflow:agent:2", phase: "completed" });
    first.emit({ ...activity, sourceKey: "workflow:agent:3", phase: "started" });
    expect(
      (await readRunActivityEvents({ dir, productRunId: RUN_A })).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });

  it("相同sourceKey内容漂移失败关闭，非法来源身份在落盘前被拒绝", async () => {
    const dir = tempDir();
    const sink = createRunActivitySink({ dir });
    const activity = {
      productRunId: RUN_A,
      attemptId: ATT_A,
      timestamp: "2026-08-21T00:00:00.000Z",
      sourceKey: "workflow:agent:conflict",
      sourceKind: "workflow" as const,
      activityType: "agent" as const,
      phase: "started" as const,
      nodeKind: "planner" as const,
    };
    sink.emit(activity);
    expect(() => sink.emit({ ...activity, phase: "completed" })).toThrow(/sourceKey冲突/u);
    expect(() =>
      sink.emit({ ...activity, sourceKey: "workflow:missing-attempt", attemptId: undefined }),
    ).toThrow(/Attempt/u);
    expect(() =>
      sink.emit({
        ...activity,
        sourceKey: "pi:missing-operation",
        sourceKind: "pi_executor",
      }),
    ).toThrow(/Operation/u);
    expect(await readRunActivityEvents({ dir, productRunId: RUN_A })).toHaveLength(1);
  });

  it("共享Reader在文件不变时复用缓存，追加后只扩展已发布事件", async () => {
    const dir = tempDir();
    const sink = createRunActivitySink({ dir });
    const reader = createRunActivityReader({ dir });
    const activity = {
      productRunId: RUN_A,
      attemptId: ATT_A,
      timestamp: "2026-08-21T00:00:00.000Z",
      sourceKind: "workflow" as const,
      activityType: "agent" as const,
      nodeKind: "planner" as const,
    };
    sink.emit({ ...activity, sourceKey: "workflow:cached:1", phase: "started" });
    const first = await reader.read({ productRunId: RUN_A });
    const unchanged = await reader.read({ productRunId: RUN_A });
    expect(unchanged).toBe(first);
    sink.emit({ ...activity, sourceKey: "workflow:cached:2", phase: "completed" });
    const appended = await reader.read({ productRunId: RUN_A });
    expect(appended).not.toBe(first);
    expect(appended.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("Memory读写节点投影为浏览器可见tool call/result且不携带记忆正文", async () => {
    const dir = tempDir();
    const sink = createRunActivitySink({ dir });
    const common = {
      level: "info" as const,
      traceId: "trace_memorynode1",
      spanId: "span_memorynode1",
      productRunId: RUN_A,
      attemptId: ATT_A,
      workflowNodeRunId: "wnr_memorynode1" as never,
      definitionNodeId: definitionNodeIdSchema.parse("memory-planning.query"),
      nodeType: workflowNodeTypeSchema.parse("memory.query"),
    };
    sink.emitTrace({
      ...common,
      eventName: "workflow.memory_node.started",
      outcome: "unknown",
      publicSummary: "正在查询Memory",
    });
    sink.emitTrace({
      ...common,
      eventName: "workflow.memory_node.completed",
      outcome: "success",
      outcomeCode: "success",
      publicSummary: "Memory查询完成，冻结2条快照",
      durationMs: 12,
    });
    const writeCommon = {
      ...common,
      traceId: "trace_memorynode2",
      spanId: "span_memorynode2",
      workflowNodeRunId: "wnr_memorywrite1" as never,
      definitionNodeId: definitionNodeIdSchema.parse("memory-planning.write"),
      nodeType: workflowNodeTypeSchema.parse("memory.write"),
    };
    sink.emitTrace({
      ...writeCommon,
      eventName: "workflow.memory_node.started",
      outcome: "unknown",
      publicSummary: "正在保存本次输入到Memory Provider",
    });
    sink.emitTrace({
      ...writeCommon,
      eventName: "workflow.memory_node.completed",
      outcome: "success",
      outcomeCode: "materialized",
      publicSummary: "本次输入已写入并可查询",
      durationMs: 20,
    });

    const page = await createExecutionTraceReader({ dir }).read({
      productRunId: RUN_A,
      afterSequence: 0,
      limit: 100,
    });
    expect(page.items).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "tool_call",
        toolCallId: "memory-node:wnr_memorynode1",
        toolName: "memory_query",
        input: JSON.stringify({ operation: "memory.query", summary: "正在查询Memory" }),
      }),
      expect.objectContaining({
        sequence: 2,
        type: "tool_result",
        toolCallId: "memory-node:wnr_memorynode1",
        toolName: "memory_query",
        outcome: "success",
        output: "Memory查询完成，冻结2条快照",
        durationMs: 12,
      }),
      expect.objectContaining({
        sequence: 3,
        type: "tool_call",
        toolCallId: "memory-node:wnr_memorywrite1",
        toolName: "memory_write",
        input: JSON.stringify({
          operation: "memory.write",
          summary: "正在保存本次输入到Memory Provider",
        }),
      }),
      expect.objectContaining({
        sequence: 4,
        type: "tool_result",
        toolCallId: "memory-node:wnr_memorywrite1",
        toolName: "memory_write",
        outcome: "success",
        output: "本次输入已写入并可查询",
        durationMs: 20,
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain(CONTENT_MARKER);
  });

  it("公开投影保留Pi工具输入、结果和耗时，并使用单调cursor", async () => {
    const dir = tempDir();
    const sink = createRunActivitySink({ dir });
    const common = {
      level: "info" as const,
      traceId: "trace_pi1",
      spanId: "span_pi1",
      productRunId: RUN_A,
      attemptId: ATT_A,
      promptTemplateVersion: "executor-1.0.0",
      modelConfigVersion: "bailian-qwen-1.0.0",
      piOperationId: "pio_trace1",
      piRuntimeSessionId: "pis_trace1",
      sourceTimestamp: "2026-08-07T00:00:00.000Z",
    };
    sink.emitTrace({
      ...common,
      eventName: "pi.tool.intent_persisted",
      outcome: "unknown",
      operationEventSequence: 1,
      turnIndex: 0,
      toolCallId: "call_read_1",
      toolName: "read",
      inputSha256: SHA256_A,
      inputDisplay: '{"path":"src/index.ts"}',
      inputDisplayTruncated: false,
    });
    sink.emitTrace({
      ...common,
      eventName: "pi.tool.completed",
      outcome: "success",
      operationEventSequence: 2,
      turnIndex: 0,
      toolCallId: "call_read_1",
      toolName: "read",
      resultSha256: SHA256_A,
      resultDisplay: "1: export const ready = true;",
      resultDisplayTruncated: false,
      durationMs: 12,
    });
    const reader = createExecutionTraceReader({ dir });
    const first = await reader.read({ productRunId: RUN_A, afterSequence: 0, limit: 1 });
    expect(first.items).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "tool_call",
        toolName: "read",
        input: '{"path":"src/index.ts"}',
      }),
    ]);
    expect(first.hasMore).toBe(true);
    const second = await reader.read({
      productRunId: RUN_A,
      afterSequence: first.nextCursor,
      limit: 100,
    });
    expect(second.items).toEqual([
      expect.objectContaining({
        sequence: 2,
        type: "tool_result",
        output: "1: export const ready = true;",
        durationMs: 12,
      }),
    ]);
    expect(second.nextCursor).toBe(2);
    expect(second.hasMore).toBe(false);
  });

  it("Pi事件缺少显示字段时仍可读取且明确标记原生Session边界", async () => {
    const dir = tempDir();
    const sink = createRunActivitySink({ dir });
    sink.emitTrace({
      level: "info",
      eventName: "pi.tool.intent_persisted",
      traceId: "trace_legacypi",
      spanId: "span_legacypi",
      productRunId: RUN_A,
      attemptId: ATT_A,
      promptTemplateVersion: "executor-legacy",
      modelConfigVersion: "bailian-legacy",
      outcome: "unknown",
      piOperationId: "pio_legacytrace1",
      operationEventSequence: 1,
      sourceTimestamp: "2026-08-07T00:00:00.000Z",
      piRuntimeSessionId: "pis_legacytrace1",
      turnIndex: 0,
      toolCallId: "call_legacy_1",
      toolName: "read",
      inputSha256: SHA256_A,
    });
    const page = await createExecutionTraceReader({ dir }).read({
      productRunId: RUN_A,
      afterSequence: 0,
      limit: 100,
    });
    expect(page.items).toEqual([
      expect.objectContaining({
        type: "tool_call",
        input: "工具输入只保留在原生 Agent Session 中",
      }),
    ]);
  });
});

describe("migrateLegacyTraceToRunActivity", () => {
  it("只扫描一次历史会话相关Trace，正常HTTP行不进入Activity", async () => {
    const root = tempDir();
    const traceDir = join(root, "trace");
    const activityDir = join(root, "activity");
    const trace = createTraceSink({
      dir: traceDir,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    trace.emit(httpReceivedInput);
    trace.emit(providerCompletedInput);
    const activity = createRunActivitySink({ dir: activityDir });
    const migrated = await migrateLegacyTraceToRunActivity({ traceDir, activitySink: activity });
    expect(migrated).toMatchObject({
      status: "completed",
      traceFiles: 1,
      scannedLines: 2,
      candidateLines: 1,
      migratedEvents: 1,
    });
    expect(await readRunActivityEvents({ dir: activityDir, productRunId: RUN_A })).toHaveLength(1);
    expect(
      await migrateLegacyTraceToRunActivity({ traceDir, activitySink: activity }),
    ).toMatchObject({
      status: "already_completed",
      migratedEvents: 0,
    });
  });

  it("拒绝把Debug Trace与Session Activity配置到同一目录", async () => {
    const dir = tempDir();
    await expect(
      migrateLegacyTraceToRunActivity({
        traceDir: dir,
        activitySink: createRunActivitySink({ dir }),
      }),
    ).rejects.toThrow(/不得相同/u);
  });
});

describe("runTraceCli", () => {
  it("stdout仅输出合同事件，不包含正文标记", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    sink.emit({ ...providerCompletedInput, productRunId: RUN_CLI });
    const written: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = runTraceCli(["--run", "run_cli123", "--dir", dir]);
      expect(code).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    const output = written.join("");
    expect(output).toContain("provider.request.completed");
    expect(output).not.toContain(CONTENT_MARKER);
    for (const line of output.split("\n").filter((line) => line.trim() !== "")) {
      expect(() => traceEventSchema.parse(JSON.parse(line))).not.toThrow();
    }
  });

  it("缺少选择器返回用法错误码2", () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(runTraceCli([])).toBe(2);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("损坏文件返回失败码3", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "chat-trace-2026-08-07.jsonl"), "{broken\n", "utf8");
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(runTraceCli(["--run", "run_x", "--dir", dir])).toBe(3);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
