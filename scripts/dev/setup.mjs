import { resolve } from "node:path";

import {
  assertLocalSetupPrerequisites,
  assertLocalSetupIdle,
  assertRuntimeFiles,
  parseDevArgs,
  prepareLocalArtifacts,
  setupUsage,
} from "./app-runtime.mjs";
import { installRuntimeInstanceEnvironment, resolveRuntimeInstance } from "./runtime-instance.mjs";

const root = resolve(import.meta.dirname, "../..");
const abortController = new AbortController();

function handleSignal(signal) {
  if (!abortController.signal.aborted) abortController.abort(new Error(`收到${signal}`));
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));

try {
  const options = parseDevArgs(process.argv.slice(2));
  if (options.debug) throw new Error("pnpm run setup不接受--debug；调试模式只属于pnpm dev:debug");
  if (options.help) {
    console.log(setupUsage());
  } else {
    const runtime = resolveRuntimeInstance(root, options.instance, process.env);
    installRuntimeInstanceEnvironment(process.env, runtime);
    assertRuntimeFiles(root);
    const prerequisites = assertLocalSetupPrerequisites();
    console.log(
      `[setup] 工具链就绪：${prerequisites.platform}/${prerequisites.arch}/${prerequisites.libc} Node ${prerequisites.nodeVersion} ABI ${prerequisites.nodeModuleAbi} pnpm ${prerequisites.pnpmVersion}`,
    );
    await assertLocalSetupIdle(root, {
      instance: options.instance,
      environment: process.env,
    });
    await prepareLocalArtifacts({
      root,
      instance: options.instance,
      memory: options.memory,
      workbench: options.workbench,
      signal: abortController.signal,
      environment: process.env,
    });
    console.log(
      `[setup] Chat本地运行工件已准备完成；下一步运行 ${runtime.name === "debug" ? "pnpm dev:debug" : "pnpm dev"}`,
    );
  }
} catch (error) {
  const interrupted =
    abortController.signal.aborted &&
    /^收到SIG(?:INT|TERM)$/u.test(String(abortController.signal.reason?.message));
  if (!interrupted) {
    console.error(`[setup] 准备失败：${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = interrupted ? 130 : 1;
}
