import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertBridgeBundleContract,
  assertDshWebCutoverConfig,
  assertManagedWebProfileReady,
  dshBridgeInstallArgs,
  dshWebEnvironment,
  resolveDshBin,
  resolveDshWebRuntime,
  runCommand,
  runCommandOutput,
} from "./profile-runtime.mjs";

const root = resolve(import.meta.dirname, "../..");
const runtime = resolveDshWebRuntime(root);
const environment = dshWebEnvironment(root);

await runCommand(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@chat/dsh-lifeos-bridge", "build"],
  { cwd: root, env: environment, label: "DSH LifeOS Bridge构建" },
);
if (!existsSync(runtime.bridgeBundlePath)) {
  throw new Error(`DSH LifeOS Bridge构建未产生固定入口：${runtime.bridgeBundlePath}`);
}
assertBridgeBundleContract(runtime);

// 由rc.6自己的plugin入口初始化profile并维护本地link依赖；这样Host与Client两面都从
// profile baseUrl解析同一个workspace包，而不是把内部dist文件名复制进Loader配置。
await runCommand(process.execPath, [resolveDshBin(root), ...dshBridgeInstallArgs(runtime)], {
  cwd: root,
  env: environment,
  label: "DSH Web Profile Bridge安装",
});
assertManagedWebProfileReady(runtime);

// plugin会按Bridge的dsh.bundle声明原子更新profile bundle列表；config dump不启动端口，
// 但会让rc.6按真实bundle层与用户patch完成组合校验。
const dump = await runCommandOutput(
  process.execPath,
  [resolveDshBin(root), "web", "--dump-config"],
  {
    cwd: root,
    env: environment,
    label: "DSH Web Profile校验",
  },
);
assertDshWebCutoverConfig(dump);
console.log(`[dsh] web profile ready: ${runtime.profileDir}`);
