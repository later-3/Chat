import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installDshWebEnvironment, resolveDshBin } from "../dsh/profile-runtime.mjs";
import { dshRealWebEnvironment } from "./dsh-real-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-real");
const dshHome = resolve(process.env.DSH_HOME ?? "");
const statePath = resolve(process.env.CHAT_DSH_STATE_PATH ?? "");

if (dshHome !== resolve(dataRoot, "dsh-home")) {
  throw new Error("真实DSH E2E必须使用隔离的DSH_HOME");
}
if (statePath !== resolve(dataRoot, "bridge/state.json")) {
  throw new Error("真实DSH E2E必须使用隔离的Bridge状态文件");
}

const executable = resolveDshBin(repoRoot);
installDshWebEnvironment(process.env, dshRealWebEnvironment(repoRoot, process.env));
process.chdir(repoRoot);
process.argv = [process.execPath, executable, "web", "--host", "127.0.0.1", "--port", "43110"];

// 与正式启动器相同，在当前Node进程执行rc.6声明的bin；Playwright停止的PID
// 就是Host端口Owner，不留下脱管孙进程。
await import(pathToFileURL(executable).href);
