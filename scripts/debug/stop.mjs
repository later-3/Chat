import { checkPorts, loadPidEntries, terminateRecorded } from "./lib.mjs";

/**
 * chat-debug:stop（postDebugTask）。
 *
 * 停止本轮记录的Chat调试进程并报告端口释放情况；
 * 端口被未记录进程占用只警告不清理。
 */

const entries = loadPidEntries();
const results = terminateRecorded(entries);
let failed = false;
for (const result of results) {
  console.log(`[stop] ${result.role} pid=${result.pid}: ${result.action}`);
  if (result.action === "kill-failed") failed = true;
}

const occupied = checkPorts();
for (const item of occupied) {
  console.warn(
    `[stop] 警告：端口 ${item.port} 仍被 pid=${item.pid} 占用（${item.command}），非本轮记录进程，未处理。`,
  );
}

process.exit(failed ? 1 : 0);
