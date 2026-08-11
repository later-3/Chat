import { readdir } from "node:fs/promises";
import { getRun } from "workflow/api";
import {
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  PROJECT_ADVANCEMENT_WORKFLOW_DEFINITION_VERSION,
  PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION,
  type TraceEventInput,
} from "@chat/contracts";
import { loadBailianConfig, runPiExecutor, runPiNoteCapture, runPiPlanner } from "@chat/pi-runtime";
import { createMemoryBackendRegistry } from "@chat/memory-runtime";
import { ZodError } from "zod";
import { createRuntimeApiClient } from "./api-client.js";
import { RuntimeBindingStore } from "./runtime-bindings.js";
import { setWorkflowRuntimeContext, type WorkflowRuntimeContext } from "./runtime-context.js";
import { setupWorkflowWorld } from "./workflow-world.js";
import { createWorkflowRuntimeHttpApp } from "./runtime-http-routes.js";
import {
  assertRunVersionMatchesBuild,
  loadRuntimeBuildEvidence,
} from "./runtime-version-evidence.js";
import { isSupportedProductWorkflowRunnerFamily } from "./planning-runner-dispatch.js";

/**
 * Workflow Runtime进程（固定端口43112）。
 *
 * 职责：
 * - 承载真实Vercel Workflow本地运行时（Local World + 预构建bundle）。
 * - 暴露后端私有分发端点（start/resume/reconcile），仅loopback + Runtime凭据。
 * - 独占Runtime Binding Store；Hook Token与Workflow Run ID不离开本进程。
 *
 * 本进程不得打开产品JSON文件；产品读写只通过API私有Runtime Router。
 *
 * 调试导航：入口先打开Binding并核对Workflow耐久目录，再读取当前bundle的build
 * evidence；Local World恢复活动Run之前逐项验证Binding身份、Runner family、私有
 * Workflow Run存在性和历史版本证据。全部通过后才挂载HTTP分派路由：正式
 * Planning/Note见runtime-product-http-routes，Memory/Project见
 * runtime-operation-http-routes。任一身份、版本或耐久数据不一致都会在world.start
 * 前失败关闭；start/resume越过SDK边界后无法确认则只记录outcome_unknown，绝不盲重试。
 */

export interface WorkflowRuntimeServerOptions {
  readonly repoRoot: string;
  readonly bundleDir: string;
  readonly workflowDataDir: string;
  readonly bindingsPath: string;
  readonly apiBaseUrl: string;
  readonly credential: string;
  readonly traceSink?: { emit: (event: TraceEventInput) => void };
  /**
   * 确定性集成测试只替换付费/外部边界；API Client、Binding Store、bundle、
   * Hook 与Local World仍由本组合根真实装配。覆盖必须在world.start()前生效，
   * 否则recoverActiveRuns可能先用生产配置执行恢复后的第一个Step。
   */
  readonly runtimeOverrides?: Partial<
    Pick<
      WorkflowRuntimeContext,
      | "memoryBackends"
      | "memoryImportBackends"
      | "bailian"
      | "planner"
      | "noteCapture"
      | "executor"
      | "now"
    >
  >;
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
          } catch (error) {
            traceEmitFailures += 1;
            console.error(
              `[trace] emit_failed code=trace.emit_failed owner=workflow event=${event.eventName} cause=${traceFailureCause(error)} total=${String(traceEmitFailures)}`,
            );
          }
        }
      : () => undefined;

  const memoryRegistry = createMemoryBackendRegistry(process.env);
  setWorkflowRuntimeContext({
    api: createRuntimeApiClient({ baseUrl: options.apiBaseUrl, credential: options.credential }),
    bindings,
    memoryBackends: memoryRegistry,
    memoryImportBackends: memoryRegistry,
    trace,
    now: () => new Date().toISOString(),
    bailian: loadBailianConfig(process.env),
    planner: runPiPlanner,
    noteCapture: runPiNoteCapture,
    executor: runPiExecutor,
    ...options.runtimeOverrides,
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
        if (!isSupportedProductWorkflowRunnerFamily(binding.runnerFamily)) {
          throw new Error("活动Product Workflow的Runner family不受当前构建支持，拒绝恢复");
        }
        await assertRunVersionMatchesBuild({
          workflowDataDir: options.workflowDataDir,
          productRunId,
          buildEvidence,
        });
      }
      for (const { binding } of bindings.listMemoryImportBindings()) {
        const run = getRun(binding.workflowRunId);
        if (!(await run.exists)) {
          throw new Error("Memory Import Binding引用的Workflow Run不存在，拒绝恢复");
        }
        const status = String(await run.status);
        if (["completed", "failed", "cancelled"].includes(status)) continue;
        if (
          binding.workflowDefinitionVersion !== MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION ||
          !buildEvidence.workflowDefinitionVersions.includes(binding.workflowDefinitionVersion)
        ) {
          throw new Error("活动Memory Import Workflow版本与当前构建不一致，拒绝恢复");
        }
      }
      for (const { binding } of bindings.listProjectIntakeBindings()) {
        const run = getRun(binding.workflowRunId);
        if (!(await run.exists)) {
          throw new Error("Project Intake Binding引用的Workflow Run不存在，拒绝恢复");
        }
        const status = String(await run.status);
        if (["completed", "failed", "cancelled"].includes(status)) continue;
        const supportedProjectVersion =
          binding.workflowDefinitionVersion === PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION ||
          binding.workflowDefinitionVersion === PROJECT_ADVANCEMENT_WORKFLOW_DEFINITION_VERSION;
        if (
          !supportedProjectVersion ||
          !buildEvidence.workflowDefinitionVersions.includes(binding.workflowDefinitionVersion)
        ) {
          throw new Error("活动Project Candidate Workflow版本与当前构建不一致，拒绝恢复");
        }
      }
    },
  });

  const app = createWorkflowRuntimeHttpApp({
    workflowDataDir: options.workflowDataDir,
    credential: options.credential,
    bindings,
    world,
    buildEvidence,
    trace,
  });
  return { app, world, bindings };
}

/**
 * Trace失败日志只能暴露合同字段路径或稳定I/O错误码，不能输出异常message，避免
 * Zod收到意外正文后把原值带进控制台。完整输入仍由严格Trace合同负责拒绝。
 */
function traceFailureCause(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues
      .slice(0, 3)
      .map((issue) => `${issue.code}@${issue.path.join(".") || "root"}`)
      .join(",");
    return `validation:${issues || "unknown"}`;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,40}$/.test(error.code)
  ) {
    return `io:${error.code}`;
  }
  return "unknown";
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
