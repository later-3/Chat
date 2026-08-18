import {
  checkPorts,
  loadPidEntries,
  repoRoot,
  terminateOwnedChatPortProcesses,
  terminateRecorded,
} from "./lib.mjs";
import { cleanupOwnedDebugBrowser } from "../dev/browser-lifecycle.mjs";
import { reconcileManagedWorkbench } from "../workbench/process-lifecycle.mjs";
import {
  installRuntimeInstanceEnvironment,
  parseRuntimeInstanceArgs,
  resolveRuntimeInstance,
} from "../dev/runtime-instance.mjs";

/**
 * Chat本地开发环境的显式停止入口。
 *
 * 停止本仓库记录过或可严格证明的Chat进程，以及当前worktree专属调试浏览器；
 * 端口被其他进程占用只警告不清理。
 */

const root = repoRoot();
const instance = parseRuntimeInstanceArgs(process.argv.slice(2));
const runtime = resolveRuntimeInstance(root, instance, process.env);
installRuntimeInstanceEnvironment(process.env, runtime);

const entries = loadPidEntries();
const results = terminateRecorded(entries);
let workbenchRecovery;
try {
  workbenchRecovery = await reconcileManagedWorkbench(root);
} catch (error) {
  console.error(
    `[stop] Workbench Unix socket回收失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
const browserCleanup = await cleanupOwnedDebugBrowser(root, {
  profileRoot: runtime.browserProfile,
});
let failed = process.exitCode === 1;
for (const result of results) {
  console.log(`[stop] ${result.role} pid=${result.pid}: ${result.action}`);
  if (result.action === "kill-failed") failed = true;
}
if (workbenchRecovery !== undefined && workbenchRecovery.action !== "no-evidence") {
  console.log(`[stop] Workbench transport=unix-socket: ${workbenchRecovery.action}`);
}
if (browserCleanup.terminatedPids.length > 0 || browserCleanup.removedLocks.length > 0) {
  console.log(
    `[stop] browser: processes=${browserCleanup.terminatedPids.length}, locks=${browserCleanup.removedLocks.length}`,
  );
}

let occupied = checkPorts();
const recovered = terminateOwnedChatPortProcesses(root, occupied);
for (const result of recovered) {
  console.log(`[stop] 同仓库遗留 ${result.role} pid=${result.pid}: ${result.action}`);
  if (result.action === "kill-failed") failed = true;
}
if (recovered.length > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  occupied = checkPorts();
}

for (const item of occupied) {
  // 只报告端口/PID/安全进程名，不输出完整argv
  console.warn(
    `[stop] 警告：端口 ${item.port} 仍被 pid=${item.pid}（${item.processName}）占用，非本轮记录进程，未处理。`,
  );
}

process.exit(failed ? 1 : 0);
