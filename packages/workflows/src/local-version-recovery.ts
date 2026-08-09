import { access, readdir } from "node:fs/promises";
import { getRun } from "workflow/api";
import type { ProductRunId } from "@chat/contracts";
import { RuntimeBindingStore } from "./runtime-bindings.js";
import {
  RuntimeVersionConflictError,
  assertRunVersionMatchesBuild,
  loadRuntimeBuildEvidence,
} from "./runtime-version-evidence.js";
import { setupWorkflowWorld, type WorkflowWorldHandle } from "./workflow-world.js";

export interface LocalVersionRecoveryOptions {
  readonly bundleDir: string;
  readonly workflowDataDir: string;
  readonly bindingsPath: string;
  readonly settleProductRun: (productRunId: ProductRunId) => Promise<void>;
}

/**
 * 开发启动前收敛无法用当前Bundle恢复的Planning Run。
 *
 * 同版本Run保持原样并继续由正式Runtime恢复。确认证据冲突时，先通过Application把产品Run与
 * Workflow Outbox收敛为失败，再使用Workflow SDK cancel写入Runtime终态；两边的历史文件、
 * Trace、Binding和版本证据全部保留。证据缺失/损坏、Binding缺失或SDK取消失败仍失败关闭。
 */
export async function settleIncompatibleLocalWorkflowRuns(
  options: LocalVersionRecoveryOptions,
): Promise<readonly ProductRunId[]> {
  const hasData = await directoryContainsFiles(options.workflowDataDir);
  const hasBindings = await fileExists(options.bindingsPath);
  if (!hasData && !hasBindings) return [];

  const bindings = await RuntimeBindingStore.open(options.bindingsPath, {
    allowCreate: !hasData,
  });
  if (!hasData && bindings.hasDurableBindings()) {
    throw new Error("Runtime Binding存在但Workflow耐久数据缺失，拒绝自动收敛");
  }
  const buildEvidence = await loadRuntimeBuildEvidence(options.bundleDir);
  const settled: ProductRunId[] = [];
  let world: WorkflowWorldHandle | undefined;
  try {
    world = await setupWorkflowWorld({
      dataDir: options.workflowDataDir,
      bundleDir: options.bundleDir,
      recoverActiveRuns: false,
      beforeStart: async () => {
        for (const { productRunId, binding } of bindings.listWorkflowBindings()) {
          const run = getRun(binding.workflowRunId);
          if (!(await run.exists)) {
            throw new Error("Runtime Binding引用的Workflow Run不存在，拒绝自动收敛");
          }
          const status = String(await run.status);
          if (["completed", "failed", "cancelled"].includes(status)) continue;
          try {
            await assertRunVersionMatchesBuild({
              workflowDataDir: options.workflowDataDir,
              productRunId,
              buildEvidence,
            });
          } catch (error) {
            if (!(error instanceof RuntimeVersionConflictError)) throw error;
            // Product Store先形成用户可见终态；SDK cancel失败时下次启动会幂等重试取消。
            await options.settleProductRun(productRunId);
            await run.cancel();
            settled.push(productRunId);
          }
        }
      },
    });
    return settled;
  } finally {
    await world?.close();
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function directoryContainsFiles(path: string): Promise<boolean> {
  try {
    return (await readdir(path, { recursive: true })).length > 0;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
