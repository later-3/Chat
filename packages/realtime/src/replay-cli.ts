import { resolve } from "node:path";
import {
  assembleMemoryImportReplay,
  assembleRunReplay,
  ReplayError,
  type ReplayAssemblerDeps,
  type ReplayContentAccess,
} from "./replay.js";

/**
 * 回放调试入口（任务书§16）：
 *   pnpm debug:replay (--run run_xxx | --import mii_xxx) [--store <path>] [--dir <traceDir>]
 *     [--evidence <runtime-version-evidence.json>] [--include-content]
 *
 * 本地授权环境使用：按对象ID/revision/Hash读取产品正文并组装回放。
 * 对象缺失、revision缺失、Hash不一致、Trace缺口或版本证据缺失
 * 显式标红并以退出码3失败。
 * 输出约定：回放视图JSON写stdout（含正文引用状态，不含密钥），摘要写stderr。
 */

const USAGE = `用法: pnpm debug:replay (--run <productRunId> | --import <memoryImportIntentId>) [--store <storePath>] [--dir <traceDir>] [--evidence <runtime-version-evidence.json>] [--bindings <runtime-bindings.json>] [--include-content]
输出: 默认不含正文；--include-content须由组合根显式授权；任何完整性失败以退出码3结束。`;

export function runReplayCli(argv: string[], deps: ReplayAssemblerDeps): number {
  let productRunId: string | undefined;
  let memoryImportIntentId: string | undefined;
  let storePath: string | undefined;
  let traceDir: string | undefined;
  let versionEvidencePath: string | undefined;
  let runtimeBindingsPath: string | undefined;
  let includeContent = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--include-content":
        includeContent = true;
        break;
      case "--run":
        if (value === undefined) return usageError(`参数${flag}缺少值`);
        productRunId = value;
        index += 1;
        break;
      case "--import":
        if (value === undefined) return usageError(`参数${flag}缺少值`);
        memoryImportIntentId = value;
        index += 1;
        break;
      case "--store":
        if (value === undefined) return usageError(`参数${flag}缺少值`);
        storePath = value;
        index += 1;
        break;
      case "--dir":
        if (value === undefined) return usageError(`参数${flag}缺少值`);
        traceDir = value;
        index += 1;
        break;
      case "--evidence":
        if (value === undefined) return usageError(`参数${flag}缺少值`);
        versionEvidencePath = value;
        index += 1;
        break;
      case "--bindings":
        if (value === undefined) return usageError(`参数${flag}缺少值`);
        runtimeBindingsPath = value;
        index += 1;
        break;
      default:
        return usageError(`未知参数: ${flag ?? ""}`);
    }
  }
  if ((productRunId === undefined) === (memoryImportIntentId === undefined)) {
    console.error("必须且只能提供 --run 或 --import 之一。");
    console.error(USAGE);
    return 2;
  }
  const repoRoot = process.env.CHAT_REPO_ROOT ?? process.cwd();
  const resolvedStore =
    storePath ??
    process.env.CHAT_PRODUCT_STORE_PATH ??
    resolve(repoRoot, ".data/product/chat-product-store.v1.json");
  const resolvedEvidence =
    versionEvidencePath ??
    resolve(
      process.env.CHAT_WORKFLOW_DATA_DIR ?? resolve(repoRoot, ".data/workflow"),
      "version-evidence",
      `${productRunId}.json`,
    );
  const resolvedBindings =
    runtimeBindingsPath ??
    process.env.CHAT_RUNTIME_BINDINGS_PATH ??
    resolve(repoRoot, ".data/runtime/runtime-bindings.v1.json");

  try {
    const contentAccess: ReplayContentAccess | undefined = includeContent
      ? {
          mode: "authorized",
          principalId: process.env.USER ?? "local-operator",
          purpose: "local-run-replay",
        }
      : undefined;
    const view =
      productRunId !== undefined
        ? assembleRunReplay(
            {
              productRunId,
              storePath: resolvedStore,
              ...(traceDir !== undefined ? { traceDir } : {}),
              versionEvidencePath: resolvedEvidence,
              ...(contentAccess !== undefined ? { contentAccess } : {}),
            },
            deps,
          )
        : assembleMemoryImportReplay(
            {
              memoryImportIntentId: memoryImportIntentId!,
              storePath: resolvedStore,
              ...(traceDir !== undefined ? { traceDir } : {}),
              runtimeBindingsPath: resolvedBindings,
              ...(contentAccess !== undefined ? { contentAccess } : {}),
            },
            deps,
          );
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    if (view.failures.length > 0) {
      console.error(`replay: ${view.failures.length} 项完整性失败（标红）:`);
      for (const failure of view.failures) console.error(`  - ${failure}`);
      return 3;
    }
    console.error(
      "versionEvidence" in view
        ? `replay: ${view.timeline.length} 个事件，${view.versionEvidence.workflowDefinitionVersions.length} 个Workflow版本，全部对象引用校验通过`
        : `replay: ${view.timeline.length} 个Memory Import事件，Runtime与产品事实校验通过`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ReplayError) {
      console.error(`replay失败: ${error.message}`);
    } else {
      console.error(`replay失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 3;
  }
}

function usageError(message: string): number {
  console.error(message);
  console.error(USAGE);
  return 2;
}
