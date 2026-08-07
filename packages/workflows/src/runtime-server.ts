import { Hono } from "hono";
import { z } from "zod";
import { readdir } from "node:fs/promises";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
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
import {
  assertRunVersionMatchesBuild,
  captureRunVersionEvidence,
  loadRuntimeBuildEvidence,
} from "./runtime-version-evidence.js";

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
  const hasWorkflowData = await directoryContainsFiles(options.workflowDataDir);
  const bindings = await RuntimeBindingStore.open(options.bindingsPath, {
    allowCreate: !hasWorkflowData,
  });
  if (!hasWorkflowData && bindings.hasDurableBindings()) {
    throw new Error("Runtime Binding存在但Workflow耐久数据缺失，拒绝用陈旧映射启动");
  }
  const buildEvidence = await loadRuntimeBuildEvidence(options.bundleDir);
  let traceEmitFailures = 0;
  const trace =
    options.traceSink !== undefined
      ? (event: TraceEventInput) => {
          try {
            options.traceSink?.emit(event);
          } catch {
            traceEmitFailures += 1;
            console.error(
              `[trace] emit_failed code=trace.emit_failed owner=workflow total=${String(traceEmitFailures)}`,
            );
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
    beforeStart: async () => {
      for (const { productRunId, binding } of bindings.listWorkflowBindings()) {
        const run = getRun(binding.workflowRunId);
        if (!(await run.exists)) {
          throw new Error("Runtime Binding引用的Workflow Run不存在，拒绝恢复");
        }
        const status = String(await run.status);
        if (["completed", "failed", "cancelled"].includes(status)) continue;
        await assertRunVersionMatchesBuild({
          workflowDataDir: options.workflowDataDir,
          productRunId,
          buildEvidence,
        });
      }
    },
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
    await captureRunVersionEvidence({
      workflowDataDir: options.workflowDataDir,
      productRunId: request.productRunId,
      buildEvidence,
      now: new Date().toISOString(),
    });
    const startClaim = await bindings.claimStartIntent({
      productRunId: request.productRunId,
      outboxId: request.outboxId as never,
      workflowDefinitionVersion: request.workflowDefinitionVersion,
      now: new Date().toISOString(),
    });
    if (startClaim === "already_started") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_started" }, 200);
    }
    if (startClaim === "outcome_unknown") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
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
        outboxId: request.outboxId as never,
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
    } catch {
      await bindings.markStartOutcomeUnknown(request.productRunId, new Date().toISOString());
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
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  app.post("/internal/workflow/v1/resume", async (c) => {
    const parsed = workflowResumeRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    // Plan先成为可见产品事实，Workflow随后提交Hook绑定；Decision可能落在这段窄窗口。
    // 只等待绑定出现，不把超时猜成终态；Hook注册已由getConflict在绑定Step之前耐久提交。
    let binding = bindings.getHookBinding(request.approvalRequestId);
    if (binding === undefined) {
      const deadline = Date.now() + 5_000;
      while (binding === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        binding = bindings.getHookBinding(request.approvalRequestId);
      }
    }
    if (binding === undefined || binding.productRunId !== request.productRunId) {
      // Decision可能先于Workflow完成Hook绑定；没有映射证明不了终态，等待对账后重派。
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    if (binding.resumeDispatchState === "dispatched") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_resumed" }, 200);
    }
    if (
      binding.resumeDispatchState === "dispatching" ||
      binding.resumeDispatchState === "outcome_unknown"
    ) {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    if (binding.resumeDispatchState === "failed_terminal") {
      return c.json({ code: "workflow_resume_unknown", title: "Hook恢复已终止" }, 409);
    }
    try {
      await getHookByToken(binding.hookToken);
    } catch {
      // 绑定只应在Hook注册后出现；恢复中的短暂不可见保持未知，不作终态猜测。
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    await bindings.markResumeDispatching(request.approvalRequestId, new Date().toISOString());
    try {
      const payload = {
        schemaVersion: "plan-decision-hook-payload.v1",
        productRunId: request.productRunId,
        approvalRequestId: request.approvalRequestId,
        decisionId: request.decisionId,
      };
      await resumeHook(binding.hookToken, payload);
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
      void resumeError;
      await bindings.markResumeOutcomeUnknown(request.approvalRequestId, new Date().toISOString());
      console.error("[workflow-runtime] resumeHook失败，结果=outcome_unknown");
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
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  const reconcileQuerySchema = z
    .object({
      productRunId: z.string().min(1),
      approvalRequestId: z.string().min(1).optional(),
    })
    .strict();
  app.get("/internal/workflow/v1/reconcile", async (c) => {
    const query = reconcileQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const startBinding = bindings.getStartState(query.data.productRunId as never);
    const hookBinding =
      query.data.approvalRequestId !== undefined
        ? bindings.getHookBinding(query.data.approvalRequestId as never)
        : undefined;
    return c.json({
      schemaVersion: "chat-workflow-dispatch.v1",
      productRunId: query.data.productRunId,
      startBinding,
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

async function directoryContainsFiles(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.some((entry) => entry.isFile());
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
