import { problemDetailSchema, serviceStatusSchema, traceEventSchema } from "@chat/contracts";
import { createTraceSink } from "@chat/realtime";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApiApp } from "./app.js";

describe("chat api skeleton", () => {
  // 骨架测试不产生Trace文件；Trace行为由独立describe用临时目录验证。
  const app = createApiApp({ traceSink: null });

  it("GET /api/healthz 返回合同形状并回显requestId", async () => {
    const res = await app.request("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    expect(serviceStatusSchema.parse(await res.json()).status).toBe("ok");
  });

  it("未知路由返回Problem Detail错误族", async () => {
    const res = await app.request("/api/nope", {
      headers: { "x-request-id": "req_test-1" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe("req_test-1");
    const problem = problemDetailSchema.parse(await res.json());
    expect(problem.code).toBe("not_found");
    expect(problem.retryable).toBe(false);
  });

  it("GET /api/readyz 返回合同形状", async () => {
    const res = await app.request("/api/readyz");
    expect(res.status).toBe(200);
    expect(serviceStatusSchema.parse(await res.json()).status).toBe("ok");
  });
});

describe("chat api trace", () => {
  function readTraceEventsFromDir(dir: string) {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        readFileSync(join(dir, name), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => traceEventSchema.parse(JSON.parse(line))),
      );
  }

  it("请求产生received/completed结构化Trace，可按requestId关联", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-api-trace-"));
    const app = createApiApp({ traceSink: createTraceSink({ dir }) });
    const res = await app.request("/api/healthz", {
      headers: { "x-request-id": "req_trace-1" },
    });
    expect(res.status).toBe(200);
    const events = readTraceEventsFromDir(dir).filter((event) => event.requestId === "req_trace-1");
    const received = events.find((event) => event.eventName === "http.command.received");
    const completed = events.find((event) => event.eventName === "http.command.completed");
    expect(received?.outcome).toBe("unknown");
    expect(completed?.outcome).toBe("success");
    expect(completed?.traceId).toBe("req_trace-1");
    expect(completed?.spanId).toBe(received?.spanId);
    expect(typeof completed?.durationMs).toBe("number");
    // 只记录方法与路由模板，不记录Body/Query/原始URL
    if (completed?.eventName === "http.command.completed") {
      expect(completed.httpMethod).toBe("GET");
      expect(completed.routeTemplate).toBe("/api/healthz");
      expect(completed.statusCode).toBe(200);
    }
    expect(JSON.stringify(events)).not.toContain('"body"');
  });

  it("4xx响应记录为rejected并携带稳定错误码，不记录原始路径", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-api-trace-"));
    const app = createApiApp({ traceSink: createTraceSink({ dir }) });
    const res = await app.request("/api/nope-with-user-content", {
      headers: { "x-request-id": "req_trace-2" },
    });
    expect(res.status).toBe(404);
    const events = readTraceEventsFromDir(dir).filter((event) => event.requestId === "req_trace-2");
    const rejected = events.find((event) => event.eventName === "http.command.rejected");
    expect(rejected?.outcome).toBe("failure");
    if (rejected?.eventName === "http.command.rejected") {
      expect(rejected.errorCode).toBe("http_4xx");
      expect(rejected.statusCode).toBe(404);
      // 未匹配路由不记录可能携带用户内容的原始路径
      expect(rejected.routeTemplate).toBeUndefined();
    }
    expect(JSON.stringify(events)).not.toContain("nope-with-user-content");
  });
});
