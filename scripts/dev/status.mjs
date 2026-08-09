import { checkPorts, isEffectivelyAlive, loadPidEntries } from "../debug/lib.mjs";

const entries = loadPidEntries();
const occupied = checkPorts();

if (entries.length === 0 && occupied.length === 0) {
  console.log("[chat] 本地开发环境未运行，固定端口全部空闲。");
  process.exit(0);
}

for (const entry of entries) {
  const state = isEffectivelyAlive(entry.pid) ? "运行中" : "已退出待清理";
  console.log(`[chat] ${state} ${entry.role} pid=${entry.pid} port=${entry.port}`);
}
for (const item of occupied) {
  console.log(`[chat] 监听 ${item.port} pid=${item.pid} process=${item.processName}`);
}
