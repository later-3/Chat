import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertChatDataPath,
  chatRepoRoot,
  createSafeChildProcessEnvironment,
} from "./fixed-memmy.mjs";
import {
  FIXED_MEMORYCORE_COMMIT,
  FIXED_MEMORYCORE_PORT,
  fixedMemoryCoreRoot,
  validateFixedMemoryCoreCache,
} from "./fixed-memorycore.mjs";
import { findListenerPid, safeProcessName } from "../debug/lib.mjs";

const repoRoot = chatRepoRoot();
const runRoot = assertChatDataPath(
  process.env.CHAT_TENCENT_MEMORYCORE_RUN_ROOT ??
    resolve(repoRoot, ".data/tests/fixed-memorycore-http"),
  repoRoot,
  "MemoryCore run root",
);
const dataRoot = assertChatDataPath(resolve(runRoot, "data"), repoRoot, "MemoryCore data root");
const token = process.env.CHAT_TENCENT_MEMORYCORE_TOKEN?.trim();
if (token === undefined || token.length < 8) throw new Error("缺少本地MemoryCore测试Token");
if (!validateFixedMemoryCoreCache(repoRoot)) {
  throw new Error("固定MemoryCore缓存未准备或源码证据损坏");
}
const occupiedPid = findListenerPid(FIXED_MEMORYCORE_PORT);
if (occupiedPid !== null) {
  console.error(
    `[memorycore-start] 端口 ${FIXED_MEMORYCORE_PORT} 被未知进程占用：pid=${occupiedPid} 进程=${safeProcessName(occupiedPid)}；拒绝启动且不终止`,
  );
  process.exit(1);
}

mkdirSync(dataRoot, { recursive: true });
const configPath = resolve(runRoot, "tdai-gateway.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      deployMode: "standalone",
      stateBackend: "local",
      server: { host: "127.0.0.1", port: FIXED_MEMORYCORE_PORT, apiKey: token },
      data: { baseDir: dataRoot },
      llm: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "",
        model: "disabled-in-m3-real-gate",
        timeoutMs: 100,
      },
      memory: {
        capture: { enabled: true },
        extraction: { enabled: false, enableDedup: false },
        pipeline: { everyNConversations: 1000, enableWarmup: false },
        recall: { enabled: true, strategy: "hybrid" },
        storeBackend: "sqlite",
        embedding: { provider: "none" },
        bm25: { enabled: true, language: "zh" },
      },
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const childEnvironmentRoot = resolve(runRoot, "child-environment");
const child = spawn(process.execPath, ["--import", "tsx", "src/gateway/server.ts"], {
  cwd: fixedMemoryCoreRoot(repoRoot),
  stdio: "inherit",
  env: createSafeChildProcessEnvironment(childEnvironmentRoot, {
    TDAI_GATEWAY_CONFIG: configPath,
    TDAI_GATEWAY_HOST: "127.0.0.1",
    TDAI_GATEWAY_PORT: String(FIXED_MEMORYCORE_PORT),
    TDAI_DATA_DIR: dataRoot,
    V3_STRICT_ISOLATION: "true",
    NODE_NO_WARNINGS: "1",
  }),
});
if (child.pid === undefined) throw new Error("固定MemoryCore子进程没有PID");
const evidencePath = resolve(runRoot, "service-process.json");
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      schemaVersion: "chat-fixed-memorycore-process.v1",
      wrapperPid: process.pid,
      childPid: child.pid,
      port: FIXED_MEMORYCORE_PORT,
      sourceCommit: FIXED_MEMORYCORE_COMMIT,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);

let stopping = false;
function forward(signal) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  const hardStop = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000);
  hardStop.unref();
}
process.once("SIGTERM", () => forward("SIGTERM"));
process.once("SIGINT", () => forward("SIGINT"));
child.once("error", (error) => {
  console.error(`[memorycore-start] 子进程失败：${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schemaVersion: "chat-fixed-memorycore-process.v1",
        wrapperPid: process.pid,
        childPid: child.pid,
        port: FIXED_MEMORYCORE_PORT,
        sourceCommit: FIXED_MEMORYCORE_COMMIT,
        stoppedAt: new Date().toISOString(),
        exitCode: code,
        signal,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.exit(code ?? (stopping ? 0 : 1));
});
