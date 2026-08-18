import {
  assertRetiredPortsEmpty,
  checkPorts,
  frozenPortList,
  loadPidEntries,
  repoRoot,
  terminateOwnedChatPortProcesses,
  terminateRecorded,
} from "./lib.mjs";
import { reconcileManagedWorkbench } from "../workbench/process-lifecycle.mjs";
import {
  installRuntimeInstanceEnvironment,
  parseRuntimeInstanceArgs,
  resolveRuntimeInstance,
} from "../dev/runtime-instance.mjs";

/**
 * chat-debug:preclean（任务书§8.2）。
 *
 * 1. 按pids.json向上次Chat调试进程发送SIGTERM，有限等待后仅对仍存活且
 *    身份一致者SIGKILL；
 * 2. 检查全部冻结端口；
 * 3. PID登记缺失时只清理经端口角色、命令、cwd与Git Common Directory四重验证的同仓库进程；
 * 4. 清理后复查一次；
 * 5. 端口被未知应用占用时报告端口/PID/进程名并失败退出，绝不杀未知进程；
 * 6. 端口全部释放才退出码0。
 */

const root = repoRoot();
const instance = parseRuntimeInstanceArgs(process.argv.slice(2));
const runtime = resolveRuntimeInstance(root, instance, process.env);
installRuntimeInstanceEnvironment(process.env, runtime);

// 退役43113即使属于旧受管wrapper也不自动终止，必须先于任何清理失败关闭。
await assertRetiredPortsEmpty();
const entries = loadPidEntries();
const results = terminateRecorded(entries);
for (const result of results) {
  console.log(`[preclean] ${result.role} pid=${result.pid}: ${result.action}`);
}
const workbenchRecovery = await reconcileManagedWorkbench(root);
if (workbenchRecovery.action !== "no-evidence") {
  console.log(`[preclean] Workbench transport=unix-socket: ${workbenchRecovery.action}`);
}

let occupied = checkPorts();
const recovered = terminateOwnedChatPortProcesses(root, occupied);
for (const result of recovered) {
  console.log(`[preclean] 同仓库遗留 ${result.role} pid=${result.pid}: ${result.action}`);
}
if (occupied.length > 0 && (entries.length > 0 || recovered.length > 0)) {
  // 刚清理的进程可能尚未释放端口，等待后复查一次
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  occupied = checkPorts();
}

if (occupied.length > 0) {
  console.error("[preclean] 失败：以下冻结端口被未记录的进程占用，已拒绝清理（不杀未知进程）：");
  for (const item of occupied) {
    // 只报告端口/PID/安全进程名；完整argv可能含其他应用秘密，绝不输出
    console.error(`  端口 ${item.port} pid=${item.pid} 进程: ${item.processName}`);
  }
  console.error("[preclean] 请手动释放端口或联系维护者确认后重试。");
  process.exit(1);
}

console.log(`[preclean] 完成：冻结端口 ${frozenPortList().join(", ")} 全部可用。`);
