import {
  TRACE_EVENT_NAMES,
  problemDetailSchema,
  requestIdSchema,
  type PrincipalId,
  type ProblemDetail,
  type RequestId,
  type ServiceStatus,
  type TraceEventInput,
} from "@chat/contracts";
import type { ApplicationDeps } from "@chat/application";
import { createExecutionTraceReader, createTraceSink, type TraceSink } from "@chat/realtime";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createProductRouter } from "./product-routes.js";
import { createInternalRuntimeRouter } from "./internal-runtime-router.js";

/**
 * Hono API Adapter。
 *
 * 边界：Hono只负责HTTP、Request ID、DTO校验和Problem Detail投影。
 * 产品事务属于Application Coordinator；本路由不得直接修改Product Store、
 * 恢复Workflow Hook或调用pi。
 *
 * Trace（任务书§7.3）：每个请求产生http.command.received与
 * http.command.completed/rejected事件。只记录HTTP方法与路由模板，
 * 不记录请求Body、Query或可能携带用户内容的原始URL。
 *
 * Request ID：不信任客户端传入值；只有通过受限Schema（req_前缀）的ID才复用，
 * 否则生成新的服务端ID，响应头始终返回最终生效ID。
 *
 * Trace失败可观测：写入失败不影响业务响应，但递增内部故障计数并输出
 * 不含事件内容的稳定错误日志，不允许整段时间线悄悄消失。
 */
type ApiVariables = { requestId: RequestId };

export interface ApiAppOptions {
  /** 默认使用@chat/realtime JSONL Sink（CHAT_TRACE_DIR或仓库.data/traces）；测试可注入临时目录。 */
  traceSink?: TraceSink | null;
  /** 产品路由上下文；缺省时只暴露健康检查（骨架模式）。 */
  product?: {
    readonly deps: ApplicationDeps;
    readonly principalId: PrincipalId;
  };
  /** 私有Runtime Router（仅服务端凭据）；缺省时不挂载。 */
  internalRuntime?: {
    readonly credential: string;
  };
  /** Provider配置状态（readiness只报告布尔，永不泄漏凭据）。 */
  providerReady?: boolean;
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

function newRequestId(): RequestId {
  return requestIdSchema.parse(`req_${randomUUID().replaceAll("-", "")}`);
}

export function createApiApp(options: ApiAppOptions = {}) {
  const traceSink = options.traceSink === undefined ? createTraceSink() : options.traceSink;
  const app = new Hono<{ Variables: ApiVariables }>();

  let traceEmitFailures = 0;
  const safeEmit = (build: () => TraceEventInput): void => {
    if (!traceSink) return;
    try {
      traceSink.emit(build());
    } catch {
      traceEmitFailures += 1;
      console.error(`[trace] emit_failed code=trace.emit_failed total=${traceEmitFailures}`);
    }
  };

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const parsed = incoming !== undefined ? requestIdSchema.safeParse(incoming) : null;
    const requestId = parsed?.success === true ? parsed.data : newRequestId();
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
    const spanId = `span_${randomUUID().replaceAll("-", "")}`;
    const base = { traceId: requestId as string, spanId, requestId };
    safeEmit(() => ({
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
    const durationMs = Math.round(performance.now() - startedAt);
    if (succeeded) {
      safeEmit(() => ({
        ...base,
        level: "info",
        eventName: TRACE_EVENT_NAMES.httpCommandCompleted,
        outcome: "success",
        durationMs,
        httpMethod,
        statusCode: status,
        ...(routeTemplate !== undefined ? { routeTemplate } : {}),
      }));
    } else {
      safeEmit(() => ({
        ...base,
        level: "warn",
        eventName: TRACE_EVENT_NAMES.httpCommandRejected,
        outcome: "rejected",
        durationMs,
        httpMethod,
        statusCode: status,
        ...(routeTemplate !== undefined ? { routeTemplate } : {}),
        errorCode: status >= 500 ? "http_5xx" : "http_4xx",
      }));
    }
  });

  app.get("/api/healthz", (c) => {
    const body: ServiceStatus = { status: "ok", service: "chat-api" };
    return c.json(body);
  });

  app.get("/api/readyz", async (c) => {
    // 产品模式下探活Product Store；骨架模式只报告进程存活。
    if (options.product !== undefined) {
      await options.product.deps.store.read({ kind: "committedSnapshot" });
    }
    const body = {
      status: "ok" as const,
      service: "chat-api",
      ...(options.providerReady !== undefined
        ? { provider: { name: "bailian" as const, ready: options.providerReady } }
        : {}),
    };
    return c.json(body);
  });

  if (options.product !== undefined) {
    const productDeps =
      traceSink === null
        ? options.product.deps
        : {
            ...options.product.deps,
            executionTraceReader: createExecutionTraceReader({ dir: traceSink.dir }),
          };
    app.route(
      "/api",
      createProductRouter({ deps: productDeps, principalId: options.product.principalId }),
    );
  }

  if (options.product !== undefined && options.internalRuntime !== undefined) {
    app.route(
      "/internal/runtime/v1",
      createInternalRuntimeRouter({
        deps: options.product.deps,
        credential: options.internalRuntime.credential,
      }),
    );
  }

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

  return Object.assign(app, {
    /** Trace写入失败次数（内部可观测性；测试与运维探针使用）。 */
    getTraceEmitFailures: () => traceEmitFailures,
  });
}

export type ApiApp = ReturnType<typeof createApiApp>;
