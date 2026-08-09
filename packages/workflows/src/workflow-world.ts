import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setWorld } from "workflow/runtime";
import { createLocalWorld, type LocalWorld } from "@workflow/world-local";

/**
 * 本地Workflow World装配（真实Vercel Workflow本地运行时）。
 *
 * 生产（Workflow Runtime进程）与集成测试共用同一装配路径：
 * 预构建的workflows/steps bundle + 本地World + 直接进程内handler。
 * 不用手写状态机冒充Vercel Workflow。
 */

export interface WorkflowWorldSetupOptions {
  readonly dataDir: string;
  readonly bundleDir: string;
  /** 进程重启后是否从存储恢复pending/running的Run（生产true；测试false并清理）。 */
  readonly recoverActiveRuns: boolean;
  readonly tag?: string;
  /** 测试隔离：启动前清空该tag下的运行数据。 */
  readonly clearBeforeStart?: boolean;
  /** setWorld后、恢复队列前执行的只读安全门。 */
  readonly beforeStart?: () => Promise<void>;
}

export interface WorkflowWorldHandle {
  readonly world: LocalWorld;
  /** 兼容现有调用方：始终是PlanningExecutionWorkflow。 */
  readonly workflowId: string;
  readonly memoryImportWorkflowId: string;
  readonly projectIntakeWorkflowId: string;
  readonly projectAdvancementWorkflowId: string;
  /** S3实验室入口；Runtime Server不公开分发路由，不影响活动产品Run。 */
  readonly definitionKernelLabWorkflowId: string;
  close(): Promise<void>;
}

interface WorkflowManifestFile {
  workflows: Record<string, Record<string, { workflowId: string }>>;
}

async function resolveWorkflowIds(bundleDir: string): Promise<{
  planningExecution: string;
  memoryImport: string;
  projectIntake: string;
  projectAdvancement: string;
  definitionKernelLab: string;
}> {
  const raw = await readFile(join(bundleDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as WorkflowManifestFile;
  let planningExecution: string | undefined;
  let memoryImport: string | undefined;
  let projectIntake: string | undefined;
  let projectAdvancement: string | undefined;
  let definitionKernelLab: string | undefined;
  for (const [filePath, entries] of Object.entries(manifest.workflows)) {
    if (filePath.includes("planning-execution-workflow")) {
      const entry = entries["planningExecutionWorkflow"];
      if (entry !== undefined) planningExecution = entry.workflowId;
    }
    if (filePath.includes("memory-import-workflow")) {
      const entry = entries["memoryImportWorkflow"];
      if (entry !== undefined) memoryImport = entry.workflowId;
    }
    if (filePath.includes("project-intake-workflow")) {
      const entry = entries["projectIntakeWorkflow"];
      if (entry !== undefined) projectIntake = entry.workflowId;
    }
    if (filePath.includes("project-advancement-workflow")) {
      const entry = entries["projectAdvancementWorkflow"];
      if (entry !== undefined) projectAdvancement = entry.workflowId;
    }
    if (filePath.includes("definition-kernel-lab-workflow")) {
      const entry = entries["definitionKernelLabWorkflow"];
      if (entry !== undefined) definitionKernelLab = entry.workflowId;
    }
  }
  if (
    planningExecution === undefined ||
    memoryImport === undefined ||
    projectIntake === undefined ||
    projectAdvancement === undefined ||
    definitionKernelLab === undefined
  ) {
    throw new Error("manifest.json缺少活动Workflow或Definition Kernel Lab Workflow");
  }
  return {
    planningExecution,
    memoryImport,
    projectIntake,
    projectAdvancement,
    definitionKernelLab,
  };
}

type QueueHandler = (req: Request) => Promise<Response>;

function lazyBundleHandler(bundlePath: string): QueueHandler {
  let handler: QueueHandler | undefined;
  let loading: Promise<QueueHandler> | undefined;
  return async (req) => {
    if (handler === undefined) {
      loading ??= import(/* @vite-ignore */ pathToFileURL(bundlePath).href).then(
        (mod) => mod.POST as QueueHandler,
      );
      handler = await loading;
    }
    return handler(req);
  };
}

export async function setupWorkflowWorld(
  options: WorkflowWorldSetupOptions,
): Promise<WorkflowWorldHandle> {
  const workflowIds = await resolveWorkflowIds(options.bundleDir);
  const world = createLocalWorld({
    dataDir: options.dataDir,
    recoverActiveRuns: options.recoverActiveRuns,
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
  });
  if (options.clearBeforeStart === true) {
    await world.clear();
  }
  // Handler必须先于start注册，避免恢复派发与handler安装竞争
  world.registerHandler(
    "__wkf_workflow_",
    lazyBundleHandler(join(options.bundleDir, "workflows.mjs")),
  );
  world.registerHandler("__wkf_step_", lazyBundleHandler(join(options.bundleDir, "steps.mjs")));
  setWorld(world);
  try {
    await options.beforeStart?.();
    await world.start?.();
  } catch (error) {
    setWorld(undefined);
    await world.close?.();
    throw error;
  }
  return {
    world,
    workflowId: workflowIds.planningExecution,
    memoryImportWorkflowId: workflowIds.memoryImport,
    projectIntakeWorkflowId: workflowIds.projectIntake,
    projectAdvancementWorkflowId: workflowIds.projectAdvancement,
    definitionKernelLabWorkflowId: workflowIds.definitionKernelLab,
    close: async () => {
      setWorld(undefined);
      await world.close?.();
    },
  };
}
