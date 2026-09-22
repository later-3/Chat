import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { repositoryRoot, assertPortFree } from "./debug-environment.mjs";
import { macServices, controlNormal } from "./chat-services.mjs";
import { checkChatWeb } from "./chat-web-health.mjs";
import { checkGateway, gatewayConfiguration } from "../deploy/nanoclaw-config.mjs";

export function parseStartOptions(args) {
  const options = { only: "all", check: false, help: false, envFile: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--check") options.check = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--only" || arg === "--env-file") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg}需要参数`);
      if (arg === "--only") options.only = value;
      else options.envFile = resolve(value);
    } else throw new Error(`未知参数 ${arg}；使用 --help 查看用法`);
  }
  if (!["all", "backend", "nanoclaw"].includes(options.only)) throw new Error("--only只能是 backend 或 nanoclaw");
  return options;
}

export async function checkBackend(service, { attempts = 30, delayMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Ownership errors are not transient and must not be converted into readiness.
    let healthy = false;
    if (service.read().pid) {
      try {
        const response = await fetch(`http://127.0.0.1:${service.port}/api/health`, {
          signal: AbortSignal.timeout(2000), redirect: "error",
        });
        const body = await response.json();
        healthy = response.ok && body?.ok === true && body.service === "chat";
      } catch { /* Process may still be binding its listener. */ }
    }
    if (healthy) {
      try { await checkChatWeb(`http://127.0.0.1:${service.port}`); }
      catch (error) { throw new Error(`${error.message}；Backend存活但Web未就绪，请停止后构建并重新启动`); }
      return;
    }
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  throw new Error(`Backend ${service.label} 未就绪；检查服务日志与端口 ${service.port}`);
}

function selectServices(services, only) {
  const backends = services.filter(service => service.kind === "Backend");
  const nanos = only === "backend" ? [] : services.filter(service => service.kind === "NanoClaw");
  if (backends.length !== 1 || nanos.length > 1) throw new Error("需要唯一的当前 checkout Backend 与至多一个 NanoClaw；请检查已安装服务");
  if (only === "nanoclaw" && !nanos.length) throw new Error("尚未安装当前 checkout 的 NanoClaw 服务");
  return { backend: backends[0], nano: nanos[0], selected: only === "nanoclaw" ? nanos : [...backends, ...nanos] };
}

function validatePair(backend, nano) {
  const environment = { ...backend.environment, PORT: String(backend.port) };
  const { values } = gatewayConfiguration(environment);
  const nanoEnvironment = { ...nano.environment, WEBHOOK_PORT: String(nano.port) };
  for (const [key, expected] of Object.entries(values)) {
    if (String(nanoEnvironment[key] ?? "") !== expected) throw new Error(`NanoClaw ${key} 与 Backend 不一致；请核对私有配置后重试`);
  }
  if (nano.port !== Number(values.WEBHOOK_PORT)) throw new Error("NanoClaw监听端口与Backend配置不一致");
  return environment;
}

/** Start installed services only. Never install/build, replace data, or restart a running service. */
export async function startMacServices(services, {
  only = "all", check = false, log = console.log, portFree = assertPortFree,
  checkFile = access, backendReady = checkBackend, gatewayReady = checkGateway,
} = {}) {
  const { backend, nano, selected } = selectServices(services, only);
  const inspected = [...new Set([backend, ...selected])];
  // Finish ownership/configuration preflight for every component before mutating launchd.
  for (const service of inspected) {
    const state = service.read();
    try { await checkFile(service.program); }
    catch { throw new Error(`${service.kind} 构建产物缺失：${service.program}；请先单独构建/安装`); }
    if (!state.pid && selected.includes(service)) await portFree(service.port);
    log(`[检查] ${service.kind} ${service.label}: ${state.state}, PID=${state.pid ?? "-"}, 端口=${service.port}`);
  }
  const environment = nano ? validatePair(backend, nano) : null;
  if (check) { log("[检查] 配置与服务归属通过，未启动服务；不代表模型或渠道已可用"); return; }
  const started = [];
  try {
    if (only === "nanoclaw") await backendReady(backend);
    for (const service of selected) {
      if (!service.read().pid) {
        await portFree(service.port);
        started.push(service);
        service.start();
        log(`[启动] ${service.kind} ${service.label}`);
      } else log(`[保留] ${service.kind} 已运行，不重启`);
      if (service.kind === "Backend") await backendReady(service);
      else {
        await gatewayReady(environment);
        if (!service.read().pid) throw new Error("NanoClaw服务未运行，拒绝用其他监听者的健康结果冒充就绪");
      }
    }
    log(`[完成] ${only === "nanoclaw" ? "NanoClaw" : nano ? "Backend（含 Chat Web） + NanoClaw" : "Backend（含 Chat Web；未安装/未选择NanoClaw）"} 已就绪`);
    log(`[网页] http://127.0.0.1:${backend.port}；模型认证和真实渠道收发需另行验证`);
  } catch (error) {
    const failures = [];
    for (const service of started.reverse()) {
      try { service.stop(); if (service.read().active) throw new Error("仍被加载"); }
      catch { failures.push(service.label); }
    }
    throw new Error(`${error.message}；已回收本次新启动服务，保留原先运行服务${failures.length ? `；回收失败：${failures.join(", ")}` : ""}`);
  }
}

export function linuxStartInvocation(root, options, environment = process.env) {
  return { file: "bash", args: [join(root, "deploy/chatctl"), options.check ? "status" : "start",
    ...(options.only === "all" ? [] : ["--only", options.only]),
    ...(options.envFile ? ["--env-file", options.envFile] : [])], env: { ...environment, CHAT_ROOT: root } };
}

async function main() {
  const options = parseStartOptions(process.argv.slice(2));
  if (options.help) {
    console.log("用法: pnpm chat:start [-- --only backend|nanoclaw] [--check]\n启动当前checkout已安装的正式服务：macOS launchd，Linux/WSL chatctl。\n不安装、不构建、不启动调试服务；重复执行不重启已有服务。\n--check: macOS只做启动预检，Linux调用chatctl status。\nLinux可传 --env-file PATH，沿用chatctl的CHAT_*安装参数；需要root权限。");
    return;
  }
  if (process.platform === "darwin") {
    if (options.envFile) throw new Error("macOS环境文件由已安装plist指定，不支持 --env-file 覆盖");
    if (process.getuid() === 0) throw new Error("macOS请以安装LaunchAgent的登录用户运行，不要sudo");
    const action = async () => startMacServices(await macServices(repositoryRoot), options);
    await (options.check ? action() : controlNormal(repositoryRoot, action));
  } else if (process.platform === "linux") {
    const invocation = linuxStartInvocation(repositoryRoot, options);
    const child = spawn(invocation.file, invocation.args, { env: invocation.env, stdio: "inherit" });
    process.exitCode = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", code => accept(code ?? 1));
    });
  } else throw new Error("正式服务启动支持macOS与Linux/WSL；Windows请在WSL中执行");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(`[失败] ${error.message}`); process.exitCode = 1;
});
