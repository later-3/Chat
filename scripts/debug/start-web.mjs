import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  FROZEN_PORTS,
  ROLE_COMMAND_FRAGMENTS,
  checkPorts,
  debugDir,
  findListenerPid,
  recordPidEntry,
  repoRoot,
  terminateEntry,
} from "./lib.mjs";

/**
 * chat-debug:start-web（任务书§8.3）。
 *
 * 以固定端口43110启动Vite dev server（--strictPort，不自动换号），
 * 记录进程组并等待HTTP就绪。启动失败时清理本轮已启动进程，退出码1。
 *
 * 说明：并行期不修改apps/web/vite.config.ts（属于PR #3），端口通过CLI传入。
 */

const port = FROZEN_PORTS.web;
const root = repoRoot();
const webDir = join(root, "apps", "web");

const existing = findListenerPid(port);
if (existing !== null) {
  const occupied = checkPorts([port]);
  console.error(
    `[start-web] 失败：端口 ${port} 已被占用：`,
    occupied.map((item) => `pid=${item.pid} 进程=${item.processName}`).join("; ") ||
      `pid=${existing}`,
  );
  console.error("[start-web] 请先运行 chat-debug:preclean 或手动释放端口。");
  process.exit(1);
}

const logsDir = join(debugDir(), "logs");
mkdirSync(logsDir, { recursive: true });
const logFd = openSync(join(logsDir, "web.log"), "a");

const child = spawn(
  "pnpm",
  ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: webDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, CHAT_REPO_ROOT: root },
  },
);

const entry = {
  role: "web",
  pid: child.pid,
  port,
  killScope: "group",
  startedAt: new Date().toISOString(),
  commandFragments: ROLE_COMMAND_FRAGMENTS.web,
};

let childExited = false;
child.once("exit", (code) => {
  childExited = true;
  console.error(`[start-web] vite提前退出（code=${code}），日志见 .data/debug/logs/web.log`);
});
child.unref();

recordPidEntry(entry);
console.log(`[start-web] 已启动web进程组 pid=${child.pid}，等待 http://127.0.0.1:${port} 就绪…`);

const deadline = Date.now() + 30_000;
for (;;) {
  if (childExited) {
    terminateEntry(entry);
    process.exit(1);
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      console.log(`[start-web] web就绪: http://127.0.0.1:${port}`);
      process.exit(0);
    }
  } catch {
    // 尚未就绪
  }
  if (Date.now() >= deadline) {
    console.error("[start-web] 超时：web在30s内未就绪，已清理本轮进程。");
    terminateEntry(entry);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
