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
    process.on("exit", () => {
      try {
        removePidEntry(role, process.pid);
      } catch {
        // 退出阶段尽力清理
      }
    });
  } catch (error) {
    console.error(
      `[debug] 进程登记失败（调试清理可能失效）: ${error instanceof Error ? error.message : error}`,
    );
  }
}
