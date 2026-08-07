import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACE_REDACTED, traceEventSchema } from "@chat/contracts";
import { describe, expect, it } from "vitest";
import { TraceReadError, readTraceEvents } from "./trace-reader.js";
import { createTraceSink } from "./trace-sink.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "chat-trace-"));
}

function readAllEvents(dir: string) {
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

describe("createTraceSink", () => {
  it("写入合法JSONL并生成schemaVersion与timestamp", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    const event = sink.emit({
      level: "info",
      eventName: "http.command.received",
      traceId: "trace_1",
      spanId: "span_1",
      outcome: "unknown",
      attributes: { "http.method": "POST" },
    });
    expect(event.schemaVersion).toBe(1);
    const events = readAllEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.traceId).toBe("trace_1");
  });

  it("写入前脱敏敏感字段、保留tokenUsage并截断超长字符串", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    sink.emit({
      level: "info",
      eventName: "provider.request.completed",
      traceId: "trace_2",
      spanId: "span_2",
      outcome: "success",
      attributes: {
        provider: "bailian",
        model: "qwen3.7-plus",
        apiKey: "sk-secret",
        prompt: "用户完整正文不应进入Trace",
        tokenUsage: { promptTokens: 3, completionTokens: 5 },
        body: "y".repeat(1200),
      },
    });
    const event = readAllEvents(dir)[0];
    expect(event?.attributes["apiKey"]).toBe(TRACE_REDACTED);
    expect(event?.attributes["prompt"]).toBe(TRACE_REDACTED);
    expect(event?.attributes["tokenUsage"]).toEqual({ promptTokens: 3, completionTokens: 5 });
    expect(String(event?.attributes["body"])).toContain("[truncated 200 chars]");
  });

  it("非法事件失败关闭，不产生半行写入", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    expect(() =>
      sink.emit({
        level: "info",
        eventName: "INVALID NAME",
        traceId: "trace_3",
        spanId: "span_3",
        outcome: "success",
      }),
    ).toThrow();
    expect(readAllEvents(dir)).toHaveLength(0);
  });
});

describe("readTraceEvents", () => {
  it("按productRunId过滤并按时间排序", () => {
    const dir = tempDir();
    const sink = createTraceSink({ dir });
    const base = Date.parse("2026-08-07T00:00:00.000Z");
    let tick = 0;
    const timed = createTraceSink({
      dir,
      now: () => new Date(base + (tick += 1) * 1000),
    });
    timed.emit({
      level: "info",
      eventName: "product_run.created",
      traceId: "t1",
      spanId: "s1",
      outcome: "success",
      productRunId: "run_a",
    });
    timed.emit({
      level: "info",
      eventName: "workflow.step.started",
      traceId: "t2",
      spanId: "s2",
      outcome: "unknown",
      productRunId: "run_b",
    });
    timed.emit({
      level: "info",
      eventName: "workflow.step.completed",
      traceId: "t3",
      spanId: "s3",
      outcome: "success",
      productRunId: "run_a",
    });
    expect(sink.dir).toBe(dir);
    const runA = readTraceEvents({ dir, productRunId: "run_a" });
    expect(runA.map((event) => event.eventName)).toEqual([
      "product_run.created",
      "workflow.step.completed",
    ]);
  });

  it("损坏行失败关闭并报告文件与行号，原始文件保持未修改", () => {
    const dir = tempDir();
    const file = join(dir, "chat-trace-2026-08-07.jsonl");
    const original = '{"bad json\n';
    writeFileSync(file, original, "utf8");
    expect(() => readTraceEvents({ dir })).toThrowError(TraceReadError);
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

  it("目录不存在时返回空结果", () => {
    expect(readTraceEvents({ dir: join(tempDir(), "missing") })).toEqual([]);
  });

  it("读取输出再次脱敏", () => {
    const dir = tempDir();
    const file = join(dir, "chat-trace-2026-08-07.jsonl");
    const event = traceEventSchema.parse({
      schemaVersion: 1,
      timestamp: "2026-08-07T00:00:00.000Z",
      level: "info",
      eventName: "provider.request.completed",
      traceId: "t9",
      spanId: "s9",
      outcome: "success",
      attributes: { authorization: "Bearer sk-x", model: "qwen3.7-plus" },
    });
    writeFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
    const events = readTraceEvents({ dir });
    expect(events[0]?.attributes["authorization"]).toBe(TRACE_REDACTED);
    expect(events[0]?.attributes["model"]).toBe("qwen3.7-plus");
  });
});
