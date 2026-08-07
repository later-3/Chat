import { Hono } from "hono";
import { z } from "zod";
import { resumeHook, start, getHookByToken } from "workflow/api";
import {
  WORKFLOW_DEFINITION_VERSION,
  workflowResumeRequestSchema,
  workflowStartRequestSchema,
  type TraceEventInput,
} from "@chat/contracts";
import { planningExecutionWorkflowInputSchema } from "./workflow-input.js";
import { loadBailianConfig, runPiExecutor, runPiPlanner } from "@chat/pi-runtime";
import { createRuntimeApiClient } from "./api-client.js";
import { RuntimeBindingStore } from "./runtime-bindings.js";
import {
  setWorkflowRuntimeContext,
  workflowRunTraceId,
  workflowSpanId,
} from "./runtime-context.js";
import { setupWorkflowWorld } from "./workflow-world.js";

/**
 * Workflow Runtime进程（固定端口43112）。
 *
 * 职责：
 * - 承载真实Vercel Workflow本地运行时（Local World + 预构建bundle）。
 * - 暴露后端私有分发端点（start/resume/reconcile），仅loopback + Runtime凭据。
 * - 独占Runtime Binding Store；Hook Token与Workflow Run ID不离开本进程。
 *
 * 本进程不得打开产品JSON文件；产品读写只通过API私有Runtime Router。
 */

export interface WorkflowRuntimeServerOptions {
  readonly repoRoot: string;
  readonly bundleDir: string;
  readonly workflowDataDir: string;
  readonly bindingsPath: string;
  readonly apiBaseUrl: string;
  readonly credential: string;
  readonly traceSink?: { emit: (event: TraceEventInput) => void };
}

export async function createWorkflowRuntimeServer(options: WorkflowRuntimeServerOptions) {
  const bindings = await RuntimeBindingStore.open(options.bindingsPath);
  const trace =
    options.traceSink !== undefined
      ? (event: TraceEventInput) => {
          try {
            options.traceSink?.emit(event);
          } catch {
            // Trace失败不影响业务；故障计数由Sink Owner看护
          }
        }
      : () => undefined;

  setWorkflowRuntimeContext({
    api: createRuntimeApiClient({ baseUrl: options.apiBaseUrl, credential: options.credential }),
    bindings,
    trace,
    now: () => new Date().toISOString(),
    bailian: loadBailianConfig(process.env),
    planner: runPiPlanner,
    executor: runPiExecutor,
  });

  const world = await setupWorkflowWorld({
    dataDir: options.workflowDataDir,
    bundleDir: options.bundleDir,
    recoverActiveRuns: true,
  });

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", service: "chat-workflow-runtime" }));

  app.use("/internal/*", async (c, next) => {
    const key = c.req.header("x-chat-runtime-key");
    if (key !== options.credential) {
      return c.json({ code: "forbidden", title: "Runtime凭据无效" }, 403);
    }
    await next();
  });

  app.post("/internal/workflow/v1/start", async (c) => {
    const parsed = workflowStartRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    const existing = bindings.getWorkflowBinding(request.productRunId);
    if (existing !== undefined) {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_started" }, 200);
    }
    try {
      const run = await start({ workflowId: world.workflowId }, [
        planningExecutionWorkflowInputSchema.parse({
          schemaVersion: "planning-execution-workflow-input.v1",
          productRunId: request.productRunId,
          attemptId: request.attemptId,
          maxPlanRevisions: 5,
        }),
      ]);
      await bindings.claimWorkflowBinding({
        productRunId: request.productRunId,
        workflowRunId: run.runId,
        workflowDefinitionVersion: request.workflowDefinitionVersion,
        now: new Date().toISOString(),
      });
      trace({
        level: "info",
        eventName: "workflow.start.started",
        outcome: "unknown",
        traceId: workflowRunTraceId(request.productRunId),
        spanId: workflowSpanId(),
        productRunId: request.productRunId,
        attemptId: request.attemptId,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        workflowDefinitionId: "wfd_planning_execution",
        runMappingRef: `map_${request.productRunId.slice(4)}`,
      } as TraceEventInput);
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "started" }, 201);
    } catch (error) {
      trace({
        level: "warn",
        eventName: "workflow.start.failed",
        outcome: "failure",
        traceId: workflowRunTraceId(request.productRunId),
        spanId: workflowSpanId(),
        productRunId: request.productRunId,
        attemptId: request.attemptId,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        workflowDefinitionId: "wfd_planning_execution",
        error: { code: "workflow.start_failed", type: "WorkflowStartError" },
      } as TraceEventInput);
      throw error;
    }
  });

  app.post("/internal/workflow/v1/resume", async (c) => {
    const parsed = workflowResumeRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    // Decision可能在Workflow完成Hook Claim之前到达（用户决定与后台规划竞速）；
    // 有界等待Claim落地，仍缺失才按映射缺失失败关闭，不盲目重试
    let binding = bindings.getHookBinding(request.approvalRequestId);
    if (binding === undefined) {
      const deadline = Date.now() + 5_000;
      while (binding === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        binding = bindings.getHookBinding(request.approvalRequestId);
      }
    }
    if (binding === undefined || binding.productRunId !== request.productRunId) {
      return c.json({ code: "workflow_resume_unknown", title: "Hook映射缺失或冲突" }, 409);
    }
    if (binding.resumeDispatchState === "dispatched") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_resumed" }, 200);
    }
    try {
      const payload = {
        schemaVersion: "plan-decision-hook-payload.v1",
        productRunId: request.productRunId,
        approvalRequestId: request.approvalRequestId,
        decisionId: request.decisionId,
      };
      try {
        await resumeHook(binding.hookToken, payload);
      } catch (firstError) {
        // Hook Claim先於Hook注册：Decision竞速到达时注册可能尚未提交，
        // 有界等待注册落地后重试一次；仍失败则按终态失败关闭，不盲目循环
        const notFound = firstError instanceof Error && firstError.name === "HookNotFoundError";
        if (!notFound) throw firstError;
        const deadline = Date.now() + 5_000;
        let registered = false;
        while (!registered && Date.now() < deadline) {
          try {
            await getHookByToken(binding.hookToken);
            registered = true;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!registered) throw firstError;
        await resumeHook(binding.hookToken, payload);
      }
      await bindings.markResumeDispatched(request.approvalRequestId, new Date().toISOString());
      trace({
        level: "info",
        eventName: "workflow.hook.resume_dispatched",
        outcome: "success",
        traceId: workflowRunTraceId(request.productRunId),
        spanId: workflowSpanId(),
        productRunId: request.productRunId,
        attemptId: request.attemptId,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        resumeAttempt: 1,
      } as TraceEventInput);
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "resumed" }, 200);
    } catch (resumeError) {
      const detail =
        resumeError instanceof Error
          ? `${resumeError.name}:${resumeError.message}`
          : String(resumeError);
      console.error("[workflow-runtime] resumeHook失败:", detail);
      await bindings.markResumeFailedTerminal(request.approvalRequestId, new Date().toISOString());
      trace({
        level: "warn",
        eventName: "workflow.hook.resume_failed",
        outcome: "failure",
        traceId: workflowRunTraceId(request.productRunId),
        spanId: workflowSpanId(),
        productRunId: request.productRunId,
        attemptId: request.attemptId,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        resumeAttempt: 1,
        error: { code: "workflow.hook_resume_failed", type: "HookResumeError" },
      } as TraceEventInput);
      return c.json({ code: "workflow_resume_unknown", title: "Hook恢复失败" }, 409);
    }
  });

  const reconcileQuerySchema = z.object({
    productRunId: z.string().min(1),
    approvalRequestId: z.string().min(1).optional(),
  });
  app.get("/internal/workflow/v1/reconcile", async (c) => {
    const query = reconcileQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const binding = bindings.getWorkflowBinding(query.data.productRunId as never);
    const hookBinding =
      query.data.approvalRequestId !== undefined
        ? bindings.getHookBinding(query.data.approvalRequestId as never)
        : undefined;
    return c.json({
      schemaVersion: "chat-workflow-dispatch.v1",
      productRunId: query.data.productRunId,
      startBinding: binding !== undefined ? "exists" : "missing",
      ...(query.data.approvalRequestId !== undefined
        ? {
            hookResumeState:
              hookBinding === undefined ? "missing" : hookBinding.resumeDispatchState,
          }
        : {}),
    });
  });

  return { app, world, bindings };
}
