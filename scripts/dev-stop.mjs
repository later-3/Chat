import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { identity } from "./debug-processes.mjs";

/** Recognize only the documented foreground wrapper, never a port's occupant. */
export function devInvocation(command, root) {
  const prefix = ["bash", "/bin/bash", "/usr/bin/bash"].flatMap(shell =>
    ["scripts/dev-start.sh", join(root, "scripts/dev-start.sh")].map(script => `${shell} ${script}`))
    .find(value => command === value || command.startsWith(`${value} `));
  if (!prefix) return null;
  const args = command.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  const ports = { backend: 43112, frontend: 30145 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--kill") continue;
    const role = { "--backend-port": "backend", "--frontend-port": "frontend" }[args[i]];
    if (!role || !/^\d+$/.test(args[i + 1] ?? "")) return null;
    const port = Number(args[++i]);
    if (port < 1 || port > 65535) return null;
    ports[role] = port;
  }
  return ports;
}

export async function stopDevelopment(root, { run, status, check = false, log = console.log } = {}) {
  const processes = run("ps", ["-axo", "pid=,uid=,command="]);
  if (!processes.ok) throw new Error("无法检查普通dev进程归属");
  const selected = [];
  for (const row of processes.text.trim().split("\n")) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== process.getuid()) continue;
    const ports = devInvocation(match[3], root);
    if (!ports) continue;
    const pid = Number(match[1]);
    let cwd;
    if (process.platform === "linux") {
      try { cwd = await readlink(`/proc/${pid}/cwd`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    } else {
      const result = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      if (!result.ok && identity(pid)) throw new Error(`无法核对普通dev PID=${pid}的工作目录`);
      cwd = result.text.match(/^n(.+)$/m)?.[1];
    }
    if (cwd !== root) continue;
    const owner = identity(pid);
    if (owner) selected.push({ owner, ports });
  }
  let ok = true;
  const alive = owner => { const current = identity(owner.pid); return current?.started === owner.started && current?.uid === owner.uid; };
  for (const { owner, ports } of selected) {
    log(`[检查] 普通dev:all PID=${owner.pid}, Backend=${ports.backend}, Vite=${ports.frontend}`);
    if (check) continue;
    // The wrapper is not necessarily a group leader. Its TERM trap reaps the
    // child groups it created; signalling its own group could kill the IDE shell.
    if (alive(owner)) {
      log(`[关闭] 普通dev:all PID=${owner.pid}: SIGTERM，等待脚本清理自有子进程`);
      try { process.kill(owner.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") { ok = false; log(`[失败] 普通dev PID=${owner.pid}: ${error.code}`); } }
    }
  }
  if (!check) for (let i = 0; i < 120 && selected.some(({ owner }) => alive(owner)); i++) await delay(100);
  if (!check) for (const { owner, ports } of selected) {
    const states = await Promise.all(Object.values(ports).map(status));
    if (alive(owner) || states.some(value => value !== "空闲")) {
      ok = false;
      log(`[失败] 普通dev:all PID=${owner.pid}: 进程=${alive(owner) ? "存在" : "已退出"}, 端口=${Object.values(ports).map((port, i) => `${port}(${states[i]})`).join(", ")}`);
    } else log(`[结果] 普通dev:all 已停止，端口 ${ports.backend}/${ports.frontend} 空闲`);
  }
  for (const port of [43112, 30145]) {
    const state = await status(port);
    log(`[检查] 普通dev默认端口 ${port}: ${state}`);
    if (!check && state !== "空闲") { ok = false; log(`[失败] 端口 ${port} 仍占用；请核对手动启动的dev/其他checkout，不按端口强杀`); }
  }
  return ok;
}
