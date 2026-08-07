import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  traceEventSchema,
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

  it("目录不存在时返回空结果", () => {
    expect(readTraceEvents({ dir: join(tempDir(), "missing") })).toEqual([]);
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
