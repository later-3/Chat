import { resolve } from "node:path";

import {
  AppSupervisor,
  assertRuntimeFiles,
  createServiceDefinitions,
  devUsage,
  parseDevArgs,
  prepareLocalRuntime,
} from "./app-runtime.mjs";

const root = resolve(import.meta.dirname, "../..");
let exitCode = 0;
let supervisor;
const abortController = new AbortController();
let resolveSignal;
const receivedSignal = new Promise((resolveReceived) => {
  resolveSignal = resolveReceived;
});

function handleSignal(signal) {
  if (!abortController.signal.aborted) {
    abortController.abort(new Error(`收到${signal}`));
    resolveSignal(signal);
  }
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));

try {
  const options = parseDevArgs(process.argv.slice(2));
  if (options.help) {
    console.log(devUsage());
  } else {
    assertRuntimeFiles(root);
    console.log(
      `[chat] 启动Chat开发环境（web=dsh, memory=${options.memory}, workbench=${options.workbench}, debug=${String(options.debug)}）`,
    );
    await prepareLocalRuntime({
      root,
      memory: options.memory,
      workbench: options.workbench,
      signal: abortController.signal,
    });
    const definitions = createServiceDefinitions({
      root,
      debug: options.debug,
      memory: options.memory,
      workbench: options.workbench,
    });
    supervisor = new AppSupervisor(definitions, { signal: abortController.signal });
    await supervisor.start();
    const url = "http://127.0.0.1:43110/";
    console.log(`[chat] ready: ${url}`);
    const outcome = await Promise.race([
      receivedSignal.then((signal) => ({ type: "signal", signal })),
      supervisor.failure.then((error) => ({ type: "failure", error })),
    ]);
    if (outcome.type === "failure") throw outcome.error;
  }
} catch (error) {
  const interrupted =
    abortController.signal.aborted &&
    /^收到SIG(?:INT|TERM)$/u.test(String(abortController.signal.reason?.message));
  if (!interrupted) {
    console.error(`[chat] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
} finally {
  await supervisor?.stop();
  process.exitCode = exitCode;
}
