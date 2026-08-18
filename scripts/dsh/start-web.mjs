import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertDshCliRuntimeClosure,
  assertManagedWebProfileReady,
  dshWebArgs,
  dshWebEnvironment,
  installDshWebEnvironment,
  resolveDshBin,
  resolveDshWebRuntime,
} from "./profile-runtime.mjs";
import { startWebGateway } from "./web-gateway.mjs";

const root = resolve(import.meta.dirname, "../..");
const runtime = resolveDshWebRuntime(root);
assertDshCliRuntimeClosure(root);
const executable = resolveDshBin(root);
assertManagedWebProfileReady(runtime);

installDshWebEnvironment(process.env, dshWebEnvironment(root));
process.chdir(root);
process.argv = [process.execPath, executable, ...dshWebArgs(runtime)];

// Gateway、DSH Host同属一个受监督PID；浏览器只接触当前实例公开端口，内部端口不会进入页面配置。
const gateway = await startWebGateway({
  logger(error) {
    console.error(`[dsh-gateway] ${error instanceof Error ? error.message : String(error)}`);
  },
});
const closeGateway = () => {
  void gateway.close();
};
process.once("SIGINT", closeGateway);
process.once("SIGTERM", closeGateway);

try {
  // 在当前Node Host内执行发布包声明的bin，使监督器登记的PID同时拥有Gateway与DSH。
  await import(pathToFileURL(executable).href);
} catch (error) {
  await gateway.close();
  throw error;
}
