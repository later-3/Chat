import {
  WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION,
  productRunIdSchema,
  workflowRuntimeTraceDtoSchema,
} from "@chat/contracts";
import { projectWorkflowRuntimeTrace } from "./runtime-trace-projection.js";
import type { WorkflowRuntimeHttpRouteContext } from "./runtime-http-route-context.js";

/**
 * API只携带Product Run ID；本路由在Binding边界内解析私有Workflow Run ID，
 * 并在响应前删除SDK身份、Hook Token、原始I/O和错误正文。
 */
export function registerWorkflowRuntimeTraceHttpRoutes(
  context: WorkflowRuntimeHttpRouteContext,
): void {
  const { app, bindings, world } = context;
  app.get("/internal/workflow/v1/runs/:productRunId/trace", async (c) => {
    if (new URL(c.req.url).search !== "") {
      return c.json({ code: "validation_failed", title: "查询参数不受支持" }, 400);
    }
    const parsed = productRunIdSchema.safeParse(c.req.param("productRunId"));
    if (!parsed.success)
      return c.json({ code: "validation_failed", title: "Product Run ID无效" }, 400);
    const productRunId = parsed.data;
    const binding = bindings.getWorkflowBinding(productRunId);
    if (binding === undefined) {
      return c.json(
        workflowRuntimeTraceDtoSchema.parse({
          schemaVersion: WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION,
          productRunId,
          sourceKind: "vercel_workflow",
          availability: "pending",
          reason:
            bindings.getStartState(productRunId) === "outcome_unknown"
              ? "start_outcome_unknown"
              : "not_started",
          refreshAfterMs: 750,
          refreshedAt: new Date().toISOString(),
        }),
        200,
      );
    }
    try {
      return c.json(
        await projectWorkflowRuntimeTrace({
          productRunId,
          workflowRunId: binding.workflowRunId,
          world: world.world,
          now: new Date(),
        }),
        200,
      );
    } catch {
      return c.json({ code: "runtime_trace_unavailable", title: "运行时轨迹暂时不可读" }, 503);
    }
  });
}
