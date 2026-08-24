import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCiSafeEnvironment } from "./safe-environment.mjs";

const CHAT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const CORE_VERIFY_COMMANDS = Object.freeze([
  Object.freeze(["pnpm", "build"]),
  Object.freeze(["pnpm", "lint"]),
  Object.freeze(["pnpm", "format:check"]),
  Object.freeze(["pnpm", "typecheck"]),
  Object.freeze(["pnpm", "test:core"]),
]);

/**
 * 核心合入门只运行构建、静态检查和core lane；contract/integration由CI独立Job运行，
 * compat按变更/main/夜间运行。所有子进程继承同一份去凭据环境，避免开发机恰好
 * 存在Key时把普通验证升级成真实调用。
 */
export function runCoreVerification(environment = process.env) {
  const safeEnvironment = createCiSafeEnvironment(environment);
  for (const [command, ...args] of CORE_VERIFY_COMMANDS) {
    const result = spawnSync(command, args, {
      cwd: CHAT_ROOT,
      env: safeEnvironment,
      stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}失败`);
  }
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    runCoreVerification();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
