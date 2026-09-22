import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { identity } from "./debug-processes.mjs";
import { repositoryRoot } from "./debug-environment.mjs";
import { command, portStatus, macServices, linuxServices, controlNormal } from "./chat-services.mjs";
export { command, portStatus, macServices, linuxServices, parseLaunchd } from "./chat-services.mjs";

/** Service stop is an explicit process-level interruption, not a business-drain claim. */
export async function stopNormal(services, { check = false, status = portStatus, log = console.log, wait = delay, getIdentity = identity } = {}) {
  const ordered = [...services].sort((a, b) => (a.kind === "NanoClaw" ? 0 : 1) - (b.kind === "NanoClaw" ? 0 : 1));
  log(`[正常] 检查 ${ordered.length} 个当前checkout服务；${check ? "只检查，不关闭" : "将中断正在运行的工作"}`);
  // Complete ownership preflight before making any service-manager mutation.
  const before = ordered.map(service => { const state = service.read(); return { service, state, owner: state.pid ? getIdentity(state.pid) : null }; });
  for (const { service, state } of before) log(`[检查] ${service.kind} ${service.label}: ${state.state}, PID=${state.pid ?? "-"}, 端口=${service.port}(${await status(service.port)}), 自启动=${service.autoStart}`);
  if (check) return true;
  let ok = true;
  for (const { service, owner } of before) {
    try {
      const state = service.read();
      if (state.active) { log(`[关闭] ${service.manager} ${service.label}`); service.stop(); }
      else log(`[关闭] ${service.label} 已停止，跳过`);
      const originalAlive = () => { const current = owner && getIdentity(owner.pid); return Boolean(current && current.started === owner.started && current.uid === owner.uid); };
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!service.read().active && !originalAlive() && await status(service.port) === "空闲") break;
        await wait(100);
      }
      const after = service.read();
      const portState = await status(service.port);
      if (after.active || after.pid || originalAlive() || portState !== "空闲") throw new Error(`关闭后 state=${after.state}, PID=${after.pid ?? "-"}, 端口=${service.port}(${portState})`);
      log(`[结果] ${service.kind} 已停止，端口 ${service.port} 空闲`);
      log(`[再次启动] ${service.resume}`);
    } catch (error) { ok = false; log(`[失败] ${service.label}: ${error.message}`); }
  }
  log(`[正常] ${ok ? "所选服务已停止" : "未全部关闭，请按失败项处理"}；保留配置/Memory/Session及下次登录或开机自启动配置`);
  return ok;
}
async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  if (args.includes("--help") || !args.length) {
    console.log("用法: pnpm chat:stop -- --normal|--debug [--check]\n--normal: 当前checkout的生产Backend + NanoClaw服务\n--debug: 当前checkout的专用F5/CLI调试进程及普通dev:all\n--check: 只打印检查结果\nLinux自定义Chat Unit: --chat-service NAME.service");
    return;
  }
  const modes = args.filter(arg => arg === "--normal" || arg === "--debug");
  if (modes.length !== 1) throw new Error("必须且只能选择 --normal 或 --debug");
  const unitIndex = args.indexOf("--chat-service");
  if (unitIndex >= 0 && (modes[0] !== "--normal" || process.platform !== "linux")) throw new Error("--chat-service只用于Linux正常服务");
  if (unitIndex >= 0 && (!args[unitIndex + 1] || args[unitIndex + 1].startsWith("--"))) throw new Error("--chat-service需要Unit名称");
  const allowed = new Set([modes[0], "--check", "--chat-service", ...(unitIndex < 0 ? [] : [args[unitIndex + 1]])]);
  if (args.some(arg => !allowed.has(arg))) throw new Error("未知参数；使用 --help 查看选项");
  const check = args.includes("--check");
  console.log(`[范围] ${modes[0]} checkout=${repositoryRoot}`);
  if (modes[0] === "--debug") {
    const { stopDebug } = await import("./debug-stop.mjs");
    if (!await stopDebug({ check })) process.exitCode = 1;
    const { stopDevelopment } = await import("./dev-stop.mjs");
    if (!await stopDevelopment(repositoryRoot, { run: command, status: portStatus, check })) process.exitCode = 1;
  } else {
    const services = process.platform === "darwin" ? await macServices(repositoryRoot)
      : process.platform === "linux" ? await linuxServices(repositoryRoot, { chatUnit: unitIndex < 0 ? "chat.service" : args[unitIndex + 1] })
      : (() => { throw new Error("正常服务关闭目前支持macOS/launchd和Linux/systemd"); })();
    if (!services.length) throw new Error("未找到当前checkout的受管正常服务；不按端口猜测或kill进程");
    const stop = () => stopNormal(services, { check });
    if (!await (process.platform === "darwin" && !check ? controlNormal(repositoryRoot, stop) : stop())) process.exitCode = 1;
  }
  if (modes[0] === "--normal") for (const [name, value] of [["普通dev Backend", 43112], ["普通dev Vite", 30145]]) {
    if (await portStatus(value) !== "空闲") console.log(`[其他入口] ${name} ${value} 仍占用；关闭开发/调试请另选 --debug`);
  }
  if (!check) console.log(`[完成] ${process.exitCode ? "未全部关闭，查看失败项" : "所选范围已停止"}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`[失败] ${error.message}`); process.exitCode = 1; });
