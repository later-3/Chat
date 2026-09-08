import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { identity } from "./debug-processes.mjs";
import { repositoryRoot, assertPortFree } from "./debug-environment.mjs";

// All command output stays private; print only selected service identities/status.
export function command(file, args) {
  try { return { ok: true, text: execFileSync(file, args, { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { return { ok: false, text: error.stdout?.toString() ?? "", error: error.stderr?.toString() ?? error.message }; }
}
export async function portStatus(port) {
  try { await assertPortFree(port); return "空闲"; }
  catch { return "占用或无法检查"; }
}
async function files(path) {
  try { return await readdir(path); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function port(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error("服务端口配置无效");
  return number;
}
async function envFile(path) {
  try { return parseEnv(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw new Error(`无法读取服务环境文件 ${path}，请使用对应运行用户/管理员权限`); }
}
export function parseLaunchd(text) {
  return { state: text.match(/^\s*state = (.+)$/m)?.[1] ?? "unknown",
    pid: Number(text.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
    cwd: text.match(/^\s*working directory = (.+)$/m)?.[1],
    args: text.match(/\n\s*arguments = \{([\s\S]*?)\n\s*\}/)?.[1]?.split("\n").map(line => line.trim()).filter(Boolean) ?? [] };
}
function macRead(service, run) {
  const result = run("launchctl", ["print", service.target]);
  if (!result.ok) {
    if (/Could not find service|service not found/i.test(result.error)) return { active: false, state: "unloaded", pid: null };
    throw new Error(`无法查询 ${service.target}，请核对登录用户和launchd域`);
  }
  const state = parseLaunchd(result.text);
  if (state.cwd !== service.cwd || !state.args.includes(service.program)) throw new Error(`${service.label} 的已加载定义与当前checkout不符，拒绝关闭`);
  return { ...state, active: true };
}

export async function macServices(root, { home = homedir(), uid = process.getuid(), run = command } = {}) {
  const directory = join(home, "Library/LaunchAgents");
  const services = [];
  for (const name of await files(directory)) {
    if (!name.endsWith(".plist")) continue;
    const path = join(directory, name);
    const loaded = run("plutil", ["-convert", "json", "-o", "-", path]);
    if (!loaded.ok) continue;
    const plist = JSON.parse(loaded.text);
    const cwd = plist.WorkingDirectory;
    const kind = cwd === root ? "Backend" : cwd === join(root, "nanoclaw") ? "NanoClaw" : null;
    if (!kind) continue;
    const program = join(cwd, kind === "Backend" ? ".output/server/index.mjs" : "dist/index.js");
    if (!plist.ProgramArguments?.includes(program)) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(plist.Label)) throw new Error(`无效的服务Label: ${path}`);
    const arg = plist.ProgramArguments.find(value => /^--env-file(?:-if-exists)?=/.test(value));
    const settings = { ...await envFile(arg ? resolve(cwd, arg.slice(arg.indexOf("=") + 1)) : join(cwd, ".env")), ...plist.EnvironmentVariables };
    const service = { kind, label: plist.Label, cwd, program, path, target: `gui/${uid}/${plist.Label}`,
      port: port(settings[kind === "Backend" ? "PORT" : "WEBHOOK_PORT"], kind === "Backend" ? 43110 : 3000),
      manager: "launchd", autoStart: Boolean(plist.RunAtLoad || plist.KeepAlive) };
    service.read = () => macRead(service, run);
    service.stop = () => {
      if (!run("launchctl", ["bootout", service.target]).ok && service.read().active) throw new Error(`${service.label} bootout失败；未按PID绕过服务管理器`);
    };
    service.resume = `launchctl bootstrap gui/${uid} '${path.replaceAll("'", "'\\''")}'`;
    services.push(service);
  }
  return services;
}
function properties(text) {
  return Object.fromEntries(text.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
}
export async function linuxServices(root, { run = command, chatUnit = "chat.service", uid = process.getuid(), listFiles = files } = {}) {
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(chatUnit)) throw new Error("无效的Chat systemd unit名称");
  const system = args => run("systemctl", ["--no-ask-password", ...args]);
  const fields = ["LoadState", "ActiveState", "MainPID", "WorkingDirectory", "ExecStart", "User", "Environment", "EnvironmentFiles", "UnitFileState"];
  function show(invoke, unit) {
    const result = invoke(["show", unit, ...fields.map(field => `--property=${field}`)]);
    if (!result.ok) throw new Error(`无法查询systemd ${unit}；请检查服务管理器权限`);
    return properties(result.text);
  }
  const chat = show(system, chatUnit);
  const user = chat.User || process.env.USER;
  const account = run("getent", ["passwd", user]);
  if (!account.ok) throw new Error("无法解析Chat运行用户");
  const parts = account.text.trim().split(":");
  const targetUid = Number(parts[2]), home = parts[5];
  const userManager = args => {
    const systemctlArgs = ["--user", "--no-ask-password", ...args];
    if (uid === targetUid) return run("systemctl", systemctlArgs);
    if (uid !== 0) throw new Error(`Nano运行用户为${user}；请以该用户或sudo执行`);
    return run("runuser", ["-u", user, "--", "env", `XDG_RUNTIME_DIR=/run/user/${targetUid}`,
      `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${targetUid}/bus`, "systemctl", ...systemctlArgs]);
  };
  const candidates = [{ unit: chatUnit, invoke: system, kind: "Backend", cwd: root }];
  for (const [directory, invoke, resume] of [["/etc/systemd/system", system, "sudo systemctl"], [join(home, ".config/systemd/user"), userManager,
    uid === targetUid ? "systemctl --user" : `sudo -u ${user} XDG_RUNTIME_DIR=/run/user/${targetUid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${targetUid}/bus systemctl --user`]]) {
    for (const unit of await listFiles(directory)) if (/^nanoclaw.*\.service$/.test(unit)) candidates.push({ unit, invoke, resume, kind: "NanoClaw", cwd: join(root, "nanoclaw") });
  }
  const services = [];
  for (const candidate of candidates) {
    const state = show(candidate.invoke, candidate.unit);
    if (state.LoadState === "not-found") continue;
    if (state.WorkingDirectory !== candidate.cwd) {
      if (candidate.kind === "Backend") throw new Error("Chat unit不属于当前checkout，拒绝关闭");
      continue;
    }
    const program = candidate.kind === "NanoClaw" ? join(candidate.cwd, "dist/index.js") : "/server/index.mjs";
    if (!state.ExecStart.includes(program)) throw new Error(`${candidate.unit} 执行入口不符合Chat部署合同`);
    const environmentPaths = [...(state.EnvironmentFiles ?? "").matchAll(/(?:^|\s)(.*?)\s+\(ignore_errors=(?:yes|no)\)/g)].map(match => match[1]);
    const settings = {};
    for (const name of ["PORT", "WEBHOOK_PORT"]) {
      const match = state.Environment?.match(new RegExp(`(?:^|\\s)"?${name}=(\\d+)"?(?:\\s|$)`));
      if (match) settings[name] = match[1];
    }
    // systemd EnvironmentFile overrides Environment; Nano's Node env-file does not.
    if (environmentPaths.length) for (const path of environmentPaths) Object.assign(settings, await envFile(path));
    else if (candidate.kind === "NanoClaw") {
      const nodeEnv = await envFile(join(candidate.cwd, ".env"));
      for (const [key, value] of Object.entries(nodeEnv)) if (!(key in settings)) settings[key] = value;
    }
    const service = { ...candidate, label: candidate.unit, manager: "systemd",
      port: port(settings[candidate.kind === "Backend" ? "PORT" : "WEBHOOK_PORT"], candidate.kind === "Backend" ? 43110 : 3000),
      autoStart: state.UnitFileState,
      read() {
        const current = show(candidate.invoke, candidate.unit);
        if (current.LoadState === "not-found") return { active: false, pid: null, state: "not-found" };
        if (current.WorkingDirectory !== candidate.cwd || !current.ExecStart.includes(program)) throw new Error(`${candidate.unit} 定义已改变`);
        return { active: !["inactive", "failed"].includes(current.ActiveState), pid: Number(current.MainPID) || null, state: current.ActiveState };
      },
      stop() { if (!candidate.invoke(["stop", candidate.unit]).ok) throw new Error(`${candidate.unit} stop失败；Linux系统级服务可能需要sudo`); },
      resume: `${candidate.resume ?? "sudo systemctl"} start ${candidate.unit}` };
    services.push(service);
  }
  return services;
}

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
    if (!await stopNormal(services, { check })) process.exitCode = 1;
  }
  if (modes[0] === "--normal") for (const [name, value] of [["普通dev Backend", 43112], ["普通dev Vite", 30145]]) {
    if (await portStatus(value) !== "空闲") console.log(`[其他入口] ${name} ${value} 仍占用；关闭开发/调试请另选 --debug`);
  }
  if (!check) console.log(`[完成] ${process.exitCode ? "未全部关闭，查看失败项" : "所选范围已停止"}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`[失败] ${error.message}`); process.exitCode = 1; });
