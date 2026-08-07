import { ROLE_COMMAND_FRAGMENTS, recordPidEntry, removePidEntry } from "./lib.mjs";

/**
 * 进程自我登记（任务书§8.2/§8.3）。
 *
 * 由VS Code launch配置通过 `node --import` 注入被调试进程：
 * 进程启动时按CHAT_DEBUG_ROLE/CHAT_DEBUG_PORT写入.data/debug/pids.json，
 * 退出时移除自己的记录。未设置CHAT_DEBUG_ROLE时完全无效（生产路径零开销）。
 */

const role = process.env.CHAT_DEBUG_ROLE;

if (role) {
  const port = Number.parseInt(process.env.CHAT_DEBUG_PORT ?? "0", 10);
  const entry = {
    role,
    pid: process.pid,
    port,
    killScope: "process",
    startedAt: new Date().toISOString(),
    commandFragments: ROLE_COMMAND_FRAGMENTS[role] ?? [role],
  };
  try {
    recordPidEntry(entry);
  } catch (error) {
    // 登记是调试清理的安全前置条件：失败关闭并终止启动，
    // 不允许出现无法被preclean/stop识别的未登记服务。
    console.error(
      `[debug] 进程登记失败，终止启动（防止产生无法清理的调试进程）: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
  process.on("exit", () => {
    try {
      removePidEntry(role, process.pid);
    } catch {
      // 退出阶段尽力清理
    }
  });
}
