import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installDshWebEnvironment, resolveDshBin } from "../dsh/profile-runtime.mjs";
import {
  DSH_INTERNAL_WEB_HOST,
  DSH_INTERNAL_WEB_PORT,
  startWebGateway,
} from "../dsh/web-gateway.mjs";
import { dshRealWebEnvironment } from "./dsh-real-environment.mjs";

/**
 * PWA 真实浏览器 E2E 的 DSH 启动器：与正式启动器同构（同一受监督PID拥有
 * 43110 Gateway 与 43114 DSH Host），但不启动 code-server——PWA 验证不需要
 * Workbench，Gateway 以 workbench 未配置姿态运行（/workbench/* 明确 503）。
 */
const repoRoot = resolve(import.meta.dirname, "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-real");
const dshHome = resolve(process.env.DSH_HOME ?? "");
const statePath = resolve(process.env.CHAT_DSH_STATE_PATH ?? "");

if (dshHome !== resolve(dataRoot, "dsh-home")) {
  throw new Error("真实DSH PWA E2E必须使用隔离的DSH_HOME");
}
if (statePath !== resolve(dataRoot, "bridge/state.json")) {
  throw new Error("真实DSH PWA E2E必须使用隔离的Bridge状态文件");
}

const executable = resolveDshBin(repoRoot);
installDshWebEnvironment(process.env, {
  ...dshRealWebEnvironment(repoRoot, process.env),
  CHAT_CODE_WORKBENCH_ENABLED: "0",
});
process.chdir(repoRoot);
process.argv = [
  process.execPath,
  executable,
  "web",
  "--host",
  DSH_INTERNAL_WEB_HOST,
  "--port",
  String(DSH_INTERNAL_WEB_PORT),
];

const gateway = await startWebGateway({
  targets: {
    dsh: { host: DSH_INTERNAL_WEB_HOST, port: DSH_INTERNAL_WEB_PORT },
  },
  logger(error) {
    console.error(
      `[dsh-pwa-e2e-gateway] ${error instanceof Error ? error.message : String(error)}`,
    );
  },
});
const closeGateway = () => {
  void gateway.close();
};
process.once("SIGINT", closeGateway);
process.once("SIGTERM", closeGateway);

try {
  await import(pathToFileURL(executable).href);
} catch (error) {
  await gateway.close();
  throw error;
}
