import "../debug/load-provider-env.mjs";

import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  assertDshWebCutoverConfig,
  dshBridgeInstallArgs,
  resolveDshBin,
  resolveDshWebRuntime,
  runCommand,
  runCommandOutput,
} from "../dsh/profile-runtime.mjs";
import { dshRealWebEnvironment } from "./dsh-real-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-real");
const expectedRoot = resolve(repoRoot, ".data/e2e/dsh-real");

if (dataRoot !== expectedRoot || !dataRoot.endsWith("/.data/e2e/dsh-real")) {
  throw new Error("拒绝清理未通过精确校验的DSH真实E2E目录");
}
if (!process.env.DASHSCOPE_API_KEY?.trim()) {
  throw new Error("真实DSH E2E缺少百炼凭据（本门失败关闭，不会Skip或切换替身）");
}

rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });

const runtime = resolveDshWebRuntime(repoRoot);
const safeDshEnvironment = dshRealWebEnvironment(repoRoot, process.env);
const toolHome = process.env.HOME?.trim();
if (toolHome === undefined || toolHome === "") {
  throw new Error("DSH E2E Profile准备缺少本地工具链HOME");
}
const environment = {
  ...safeDshEnvironment,
  // 只在Profile准备子进程复用已安装的Corepack包与pnpm内容寻址Store；最终DSH
  // Host仍只接收safeDshEnvironment，不获得用户HOME、Provider或账号环境。
  COREPACK_HOME: process.env.COREPACK_HOME?.trim() || join(toolHome, ".cache/node/corepack"),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_store_dir:
    process.env.npm_config_store_dir?.trim() ||
    (process.platform === "darwin"
      ? join(toolHome, "Library/pnpm/store/v10")
      : join(toolHome, ".local/share/pnpm/store/v10")),
};

// E2E profile和Workflow bundle都是测试专用可再生产物。先准备再交给
// Playwright监督真实服务，避免旧dist/profile让完成门假通过。
await runCommand(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@chat/dsh-lifeos-bridge", "build"],
  { cwd: repoRoot, env: environment, label: "DSH E2E Bridge构建" },
);
await runCommand(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@chat/workflows", "build:bundles"],
  { cwd: repoRoot, env: environment, label: "DSH E2E Workflow Bundle构建" },
);

const dshBin = resolveDshBin(repoRoot);
await runCommand(process.execPath, [dshBin, ...dshBridgeInstallArgs(runtime)], {
  cwd: repoRoot,
  env: environment,
  label: "DSH E2E Profile Bridge安装",
});
const dump = await runCommandOutput(process.execPath, [dshBin, "web", "--dump-config"], {
  cwd: repoRoot,
  env: environment,
  label: "DSH E2E Profile校验",
});
assertDshWebCutoverConfig(dump);

console.log("[e2e-preflight] rc.6 DSH profile、真实Provider与隔离数据目录已就绪");
