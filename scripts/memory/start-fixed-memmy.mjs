import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  FIXED_MEMMY_COMMIT,
  FIXED_MEMMY_PORT,
  assertChatDataPath,
  chatRepoRoot,
  createSafeChildProcessEnvironment,
  fixedMemmyCacheRoot,
  fixedMemmyServerEntry,
  validateFixedMemmyCache,
} from "./fixed-memmy.mjs";
import { findListenerPid, safeProcessName } from "../debug/lib.mjs";

const repoRoot = chatRepoRoot();
const runRoot = assertChatDataPath(
  process.env.CHAT_MEMMY_RUN_ROOT ?? resolve(repoRoot, ".data/e2e/memory-planning-real/memmy"),
  repoRoot,
  "memmy run root",
);
const dbPath = assertChatDataPath(
  process.env.CHAT_MEMMY_DB_PATH ?? resolve(runRoot, "memory.sqlite"),
  repoRoot,
  "memmy sqlite",
);
const dbRelative = relative(runRoot, dbPath);
if (
  dbRelative === "" ||
  dbRelative === ".." ||
  dbRelative.startsWith(`..${sep}`) ||
  isAbsolute(dbRelative)
) {
  throw new Error("memmy sqlite 必须位于本轮物理隔离目录内");
}

const port = Number.parseInt(process.env.CHAT_MEMMY_PORT ?? String(FIXED_MEMMY_PORT), 10);
if (port !== FIXED_MEMMY_PORT) throw new Error(`M1 固定 memmy 端口必须是 ${FIXED_MEMMY_PORT}`);
const occupiedPid = findListenerPid(port);
if (occupiedPid !== null) {
  console.error(
    `[memmy-start] 端口 ${port} 已被未知进程占用：pid=${occupiedPid} 进程=${safeProcessName(occupiedPid)}；已拒绝启动且未终止该进程`,
  );
  process.exit(1);
}
if (!validateFixedMemmyCache(repoRoot)) {
  throw new Error("固定 memmy 缓存未准备或证据损坏；请先运行 pnpm memory:prepare:fixed");
}

mkdirSync(dirname(dbPath), { recursive: true });
const childEnvironmentRoot = resolve(runRoot, "child-environment");
const configPath = resolve(runRoot, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      memmyMemory: {
        version: 1,
        activeProfile: "byok",
        storage: {
          mode: "local",
          backend: "sqlite",
          sqlitePath: dbPath,
          endpoint: `http://127.0.0.1:${port}`,
        },
        algorithm: {
          capture: { embedAfterCapture: false },
          retrieval: { llmFilterEnabled: false, smartSeed: false },
        },
      },
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const child = spawn(
  process.execPath,
  [
    fixedMemmyServerEntry(repoRoot),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--db",
    dbPath,
    "--config",
    configPath,
  ],
  {
    cwd: fixedMemmyCacheRoot(repoRoot),
    stdio: "inherit",
    env: createSafeChildProcessEnvironment(childEnvironmentRoot, {
      MEMMY_CONFIG: configPath,
      MEMMY_MEMORY_DB: dbPath,
      MEMMY_MEMORY_HOST: "127.0.0.1",
      MEMMY_MEMORY_PORT: String(port),
      MEMMY_CLI_ANALYTICS_SKIP: "1",
      MEMMY_APP_ENV: "test",
      MEMMY_HOME: resolve(runRoot, "home"),
      HF_HOME: resolve(runRoot, "huggingface"),
    }),
  },
);
if (child.pid === undefined) throw new Error("固定 memmy 子进程没有可登记 PID");
const processEvidencePath = resolve(runRoot, "service-process.json");
writeFileSync(
  processEvidencePath,
  `${JSON.stringify(
    {
      schemaVersion: "chat-fixed-memmy-process.v1",
      wrapperPid: process.pid,
      childPid: child.pid,
      port,
      sourceCommit: FIXED_MEMMY_COMMIT,
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
  console.error(`[memmy-start] 子进程启动失败：${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  writeFileSync(
    processEvidencePath,
    `${JSON.stringify(
      {
        schemaVersion: "chat-fixed-memmy-process.v1",
        wrapperPid: process.pid,
        childPid: child.pid,
        port,
        sourceCommit: FIXED_MEMMY_COMMIT,
        stoppedAt: new Date().toISOString(),
        exitCode: code,
        signal,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  if (!stopping && code !== 0) {
    console.error(`[memmy-start] 固定 memmy 异常退出：${code === null ? signal : String(code)}`);
  }
  process.exit(code ?? (stopping ? 0 : 1));
});
