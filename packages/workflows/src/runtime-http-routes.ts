import { Hono } from "hono";
import {
  type WorkflowRuntimeHttpAppInput,
  type WorkflowRuntimeHttpRouteContext,
} from "./runtime-http-route-context.js";
import { registerOperationalWorkflowHttpRoutes } from "./runtime-operation-http-routes.js";
import { registerProductWorkflowHttpRoutes } from "./runtime-product-http-routes.js";
import { registerWorkflowRuntimeTraceHttpRoutes } from "./runtime-trace-http-routes.js";

export type { WorkflowRuntimeHttpAppInput } from "./runtime-http-route-context.js";

/**
 * 仅负责loopback私有HTTP协议与SDK分派。产品事实校验仍在Application，
 * Workflow Run ID和Hook Token只在Runtime Binding边界内使用。
 */
export function createWorkflowRuntimeHttpApp(input: WorkflowRuntimeHttpAppInput): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", service: "chat-workflow-runtime" }));

  app.use("/internal/*", async (c, next) => {
    const key = c.req.header("x-chat-runtime-key");
    if (key !== input.credential) {
      return c.json({ code: "forbidden", title: "Runtime凭据无效" }, 403);
    }
    await next();
  });

  const context: WorkflowRuntimeHttpRouteContext = { ...input, app };
  registerProductWorkflowHttpRoutes(context);
  registerOperationalWorkflowHttpRoutes(context);
  registerWorkflowRuntimeTraceHttpRoutes(context);
  return app;
}
