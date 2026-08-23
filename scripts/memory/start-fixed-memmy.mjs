import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
import { RUNTIME_INSTANCE_NAMES, runtimePorts } from "../dev/runtime-instance.mjs";
import {
  captureSpawnedMemoryChildIdentity,
  createMemorySidecarContract,
  secureMemoryDataTree,
  signalProcessGroup,
  writeMemoryRunningEvidence,
  writeMemoryStartingEvidence,
  writeMemoryStoppedEvidence,
} from "./process-lifecycle.mjs";

const repoRoot = chatRepoRoot();
const runtimeInstance = process.env.CHAT_RUNTIME_INSTANCE?.trim() || "production";
if (!RUNTIME_INSTANCE_NAMES.includes(runtimeInstance)) {
  throw new Error(`CHAT_RUNTIME_INSTANCE只支持 ${RUNTIME_INSTANCE_NAMES.join("、")}`);
}
const expectedPort = runtimePorts(runtimeInstance).memory;
const runRoot = assertChatDataPath(
  process.env.CHAT_MEMMY_RUN_ROOT ?? resolve(repoRoot, ".data/debug/memmy"),
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

const rawPort = process.env.CHAT_MEMMY_PORT?.trim() || String(expectedPort);
if (!/^\d{1,5}$/u.test(rawPort)) throw new Error("CHAT_MEMMY_PORT必须是合法TCP端口");
const port = Number.parseInt(rawPort, 10);
const responseDropBackend =
  runtimeInstance === "production" &&
  process.env.CHAT_MEMMY_TEST_ALLOW_ALTERNATE_PORT === "1" &&
  port === FIXED_MEMMY_PORT + 1;
if (port !== expectedPort && !responseDropBackend) {
  throw new Error(
    `${runtimeInstance}实例固定memmy端口必须是 ${String(expectedPort)}；仅响应丢失测试可用专用后端端口`,
  );
}
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

process.umask(0o077);
secureMemoryDataTree(runRoot);
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

const serverEntry = fixedMemmyServerEntry(repoRoot);
const contract = createMemorySidecarContract({
  root: repoRoot,
  provider: "memmy",
  runtimeInstance,
  sourceCommit: FIXED_MEMMY_COMMIT,
  port,
  runRoot,
  childCwd: fixedMemmyCacheRoot(repoRoot),
  commandFragments: [serverEntry, "--port", String(port), "--db", dbPath, "--config", configPath],
});
const instanceId = randomUUID();
writeMemoryStartingEvidence(contract, { instanceId, wrapperPid: process.pid });

const child = spawn(
  process.execPath,
  [
    serverEntry,
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
    // Sidecar拥有独立进程组；wrapper被SIGKILL后，下一轮只能在v2证据严格匹配时
    // 对这一组发信号，不会沿用Supervisor/终端的宽进程组。
    detached: true,
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
let childIdentity;
try {
  childIdentity = captureSpawnedMemoryChildIdentity(contract, child.pid);
  writeMemoryRunningEvidence(contract, {
    instanceId,
    wrapperPid: process.pid,
    ...childIdentity,
  });
} catch (error) {
  try {
    signalProcessGroup(child.pid, "SIGKILL");
  } catch {
    // 后续端口门仍会失败关闭；不得改向其他PID发送信号。
  }
  writeMemoryStoppedEvidence(contract, instanceId, {
    failedAt: new Date().toISOString(),
    failure: "child_identity_unavailable",
  });
  throw error;
}

let stopping = false;
function forward(signal) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      signalProcessGroup(childIdentity.childProcessGroupId, signal);
    } catch {
      // exit路径与下一轮v2 reconciler会继续确认是否已经退出。
    }
  }
  const hardStop = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        signalProcessGroup(childIdentity.childProcessGroupId, "SIGKILL");
      } catch {
        // 进程已经退出时无需处理。
      }
    }
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
  try {
    writeMemoryStoppedEvidence(contract, instanceId, { exitCode: code, signal });
  } catch (error) {
    console.error(
      `[memmy-start] 停止证据发布失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
  if (!stopping && code !== 0) {
    console.error(`[memmy-start] 固定 memmy 异常退出：${code === null ? signal : String(code)}`);
  }
  process.exit(process.exitCode ?? code ?? (stopping ? 0 : 1));
});
