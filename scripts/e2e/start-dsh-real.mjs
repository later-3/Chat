import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installDshWebEnvironment, resolveDshBin } from "../dsh/profile-runtime.mjs";
import {
  DSH_INTERNAL_WEB_HOST,
  DSH_INTERNAL_WEB_PORT,
  startWebGateway,
} from "../dsh/web-gateway.mjs";
import { probeCodeServerSocketReady } from "../workbench/fixed-code-server.mjs";
import {
  dshRealWebEnvironment,
  resolveDshRealSharedCacheRoot,
  resolveDshRealWorkbenchFixtureRoot,
  resolveDshRealWorkbenchRunRoot,
  resolveDshRealWorkbenchTempParent,
} from "./dsh-real-environment.mjs";

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

const workbenchFixtureRoot = resolveDshRealWorkbenchFixtureRoot(repoRoot);
const workbenchEnvironment = {
  CHAT_CODE_WORKBENCH_RUN_ROOT: resolveDshRealWorkbenchRunRoot(repoRoot),
  CHAT_CODE_WORKBENCH_TEMP_PARENT: resolveDshRealWorkbenchTempParent(process.env),
  CHAT_FIXED_SOURCE_CACHE_ROOT: resolveDshRealSharedCacheRoot(repoRoot),
};
let workbenchEvidence;
let lastWorkbenchError;
const workbenchDeadline = Date.now() + 60_000;
while (Date.now() < workbenchDeadline) {
  try {
    workbenchEvidence = await probeCodeServerSocketReady(workbenchFixtureRoot, {
      environment: workbenchEnvironment,
      timeoutMs: 1_500,
    });
    break;
  } catch (error) {
    lastWorkbenchError = error;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}
if (workbenchEvidence === undefined) {
  throw new Error(
    `真实DSH E2E等待受管code-server Unix socket失败：${lastWorkbenchError instanceof Error ? lastWorkbenchError.message : String(lastWorkbenchError)}`,
  );
}

const executable = resolveDshBin(repoRoot);
installDshWebEnvironment(process.env, dshRealWebEnvironment(repoRoot, process.env));
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
    workbench: { socketPath: workbenchEvidence.socketPath },
  },
  logger(error) {
    console.error(`[dsh-e2e-gateway] ${error instanceof Error ? error.message : String(error)}`);
  },
});
const closeGateway = () => {
  void gateway.close();
};
process.once("SIGINT", closeGateway);
process.once("SIGTERM", closeGateway);

try {
  // 与正式启动器相同：同一受监督PID拥有43110 Gateway与43114 DSH Host。
  await import(pathToFileURL(executable).href);
} catch (error) {
  await gateway.close();
  throw error;
}
