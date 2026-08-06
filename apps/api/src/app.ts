import { problemDetailSchema, type ProblemDetail, type ServiceStatus } from "@chat/contracts";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

/**
 * Hono API Adapter（P0骨架）。
 *
 * 边界：Hono只负责HTTP、Request ID、DTO校验和Problem Detail投影。
 * 产品事务属于Application Coordinator；本路由不得直接修改Product Store、
 * 恢复Workflow Hook或调用pi。
 */
type ApiVariables = { requestId: string };

export function createApiApp() {
  const app = new Hono<{ Variables: ApiVariables }>();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? `req_${randomUUID()}`;
    c.set("requestId", requestId);
    await next();
    c.header("x-request-id", requestId);
  });

  app.get("/api/healthz", (c) => {
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
