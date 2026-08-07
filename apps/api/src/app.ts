import {
  TRACE_EVENT_NAMES,
  problemDetailSchema,
  type ProblemDetail,
  type ServiceStatus,
} from "@chat/contracts";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createJsonlTraceSink, type TraceEventSink } from "./trace/jsonl-sink.js";

/**
 * Hono API Adapter。
 *
 * 边界：Hono只负责HTTP、Request ID、DTO校验和Problem Detail投影。
 * 产品事务属于Application Coordinator；本路由不得直接修改Product Store、
 * 恢复Workflow Hook或调用pi。
 *
 * Trace（任务书§7.3）：每个请求产生http.command.received与
 * http.command.completed/rejected事件；Trace失败不影响请求处理。
 */
type ApiVariables = { requestId: string };

export interface ApiAppOptions {
  /** 默认使用本地JSONL Sink（CHAT_TRACE_DIR或仓库.data/traces）；测试可注入临时目录。 */
  traceSink?: TraceEventSink | null;
}

function safeEmit(sink: TraceEventSink, emit: () => Parameters<TraceEventSink>[0]): void {
  try {
    sink(emit());
  } catch (error) {
    console.error("[trace] 写入失败（请求继续）:", error instanceof Error ? error.message : error);
  }
}

export function createApiApp(options: ApiAppOptions = {}) {
  const traceSink = options.traceSink === undefined ? createJsonlTraceSink() : options.traceSink;
  const app = new Hono<{ Variables: ApiVariables }>();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? `req_${randomUUID()}`;
    c.set("requestId", requestId);
    await next();
    c.header("x-request-id", requestId);
  });

  app.use("*", async (c, next) => {
    if (!traceSink) {
      await next();
      return;
    }
    const startedAt = performance.now();
    const requestId = c.get("requestId");
    const spanId = `span_${randomUUID()}`;
    const base = { traceId: requestId, spanId, requestId };
    safeEmit(traceSink, () => ({
      ...base,
      level: "info",
      eventName: TRACE_EVENT_NAMES.httpCommandReceived,
      outcome: "unknown",
      attributes: { "http.method": c.req.method, "http.path": c.req.path },
    }));
    await next();
    const status = c.res.status;
    const succeeded = status < 400;
    safeEmit(traceSink, () => ({
      ...base,
      level: succeeded ? "info" : "warn",
      eventName: succeeded
        ? TRACE_EVENT_NAMES.httpCommandCompleted
        : TRACE_EVENT_NAMES.httpCommandRejected,
      outcome: succeeded ? "success" : "failure",
      durationMs: Math.round(performance.now() - startedAt),
      ...(succeeded ? {} : { errorCode: `http_${status}` }),
      attributes: {
        "http.method": c.req.method,
        "http.path": c.req.path,
        "http.status": status,
      },
    }));
  });

  app.get("/api/healthz", (c) => {
    const body: ServiceStatus = { status: "ok", service: "chat-api" };
    return c.json(body);
  });

  app.get("/api/readyz", (c) => {
    // B1：暂无外部依赖；B2/B4将在此检查Product Store与Workflow运行时可达性。
    const body: ServiceStatus = { status: "ok", service: "chat-api" };
    return c.json(body);
  });

  app.notFound((c) => {
    const problem: ProblemDetail = {
      type: "https://chat.dev/problems/not-found",
      title: "Resource not found",
      status: 404,
      code: "not_found",
      requestId: c.get("requestId"),
      retryable: false,
      recoveryAction: "none",
    };
    return c.json(problemDetailSchema.parse(problem), 404);
  });

  return app;
}

export type ApiApp = ReturnType<typeof createApiApp>;
