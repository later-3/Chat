import {
  TRACE_EVENT_NAMES,
  problemDetailSchema,
  type ProblemDetail,
  type ServiceStatus,
  type TraceEventInput,
} from "@chat/contracts";
import { createTraceSink, type TraceSink } from "@chat/realtime";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

/**
 * Hono API Adapter。
 *
 * 边界：Hono只负责HTTP、Request ID、DTO校验和Problem Detail投影。
 * 产品事务属于Application Coordinator；本路由不得直接修改Product Store、
 * 恢复Workflow Hook或调用pi。
 *
 * Trace（任务书§7.3）：每个请求产生http.command.received与
 * http.command.completed/rejected事件。只记录HTTP方法与路由模板，
 * 不记录请求Body、Query或可能携带用户内容的原始URL；Trace失败不影响请求处理。
 */
type ApiVariables = { requestId: string };

export interface ApiAppOptions {
  /** 默认使用@chat/realtime JSONL Sink（CHAT_TRACE_DIR或仓库.data/traces）；测试可注入临时目录。 */
  traceSink?: TraceSink | null;
}

function safeEmit(sink: TraceSink, build: () => TraceEventInput): void {
  try {
    sink.emit(build());
  } catch (error) {
    console.error("[trace] 写入失败（请求继续）:", error instanceof Error ? error.message : error);
  }
}

type HttpMethod = Extract<TraceEventInput, { eventName: "http.command.received" }>["httpMethod"];

function toHttpMethod(method: string): HttpMethod | null {
  switch (method) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return method;
    default:
      return null;
  }
}

export function createApiApp(options: ApiAppOptions = {}) {
  const traceSink = options.traceSink === undefined ? createTraceSink() : options.traceSink;
  const app = new Hono<{ Variables: ApiVariables }>();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? `req_${randomUUID()}`;
    c.set("requestId", requestId);
    await next();
    c.header("x-request-id", requestId);
  });

  app.use("*", async (c, next) => {
    const httpMethod = toHttpMethod(c.req.method);
    if (!traceSink || httpMethod === null) {
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
      httpMethod,
    }));
    await next();
    const status = c.res.status;
    const succeeded = status < 400;
    // 404来自未匹配路由，此时routePath可能回退为原始路径（含用户内容），一律省略模板
    const routeTemplate = status === 404 ? undefined : c.req.routePath;
    safeEmit(traceSink, () => ({
      ...base,
      level: succeeded ? "info" : "warn",
      eventName: succeeded
        ? TRACE_EVENT_NAMES.httpCommandCompleted
        : TRACE_EVENT_NAMES.httpCommandRejected,
      outcome: succeeded ? "success" : "failure",
      durationMs: Math.round(performance.now() - startedAt),
      httpMethod,
      statusCode: status,
      ...(routeTemplate !== undefined ? { routeTemplate } : {}),
      ...(succeeded ? {} : { errorCode: status >= 500 ? "http_5xx" : "http_4xx" }),
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
