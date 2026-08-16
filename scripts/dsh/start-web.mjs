import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertManagedWebProfileReady,
  dshWebArgs,
  dshWebEnvironment,
  installDshWebEnvironment,
  resolveDshBin,
  resolveDshWebRuntime,
} from "./profile-runtime.mjs";

const root = resolve(import.meta.dirname, "../..");
const runtime = resolveDshWebRuntime(root);
const executable = resolveDshBin(root);
assertManagedWebProfileReady(runtime);

installDshWebEnvironment(process.env, dshWebEnvironment(root));
process.chdir(root);
process.argv = [process.execPath, executable, ...dshWebArgs(runtime)];

// 在当前Node Host内执行发布包声明的bin，使监督器登记的PID就是实际端口Owner。
await import(pathToFileURL(executable).href);
