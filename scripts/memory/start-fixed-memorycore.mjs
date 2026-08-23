import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertChatDataPath,
  chatRepoRoot,
  createSafeChildProcessEnvironment,
} from "./fixed-memmy.mjs";
import {
  FIXED_MEMORYCORE_COMMIT,
  fixedMemoryCoreRoot,
  validateFixedMemoryCoreCache,
} from "./fixed-memorycore.mjs";
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
const expectedPort = runtimePorts(runtimeInstance).memoryCore;
const rawPort = process.env.CHAT_TENCENT_MEMORYCORE_PORT?.trim() || String(expectedPort);
if (!/^\d{1,5}$/u.test(rawPort)) {
  throw new Error("CHAT_TENCENT_MEMORYCORE_PORT必须是合法TCP端口");
}
const port = Number.parseInt(rawPort, 10);
if (port !== expectedPort) {
  throw new Error(`${runtimeInstance}实例固定MemoryCore端口必须是 ${String(expectedPort)}`);
}
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
const occupiedPid = findListenerPid(port);
if (occupiedPid !== null) {
  console.error(
    `[memorycore-start] 端口 ${String(port)} 被未知进程占用：pid=${occupiedPid} 进程=${safeProcessName(occupiedPid)}；拒绝启动且不终止`,
  );
  process.exit(1);
}

process.umask(0o077);
secureMemoryDataTree(runRoot);
// 固定上游会把debug日志（可能包含Memory正文）写到LOG_PATH，未设置时甚至尝试
// `/data/log`。这里用一个0600普通文件占住该路径，使其FileLogger初始化失败并关闭；
// Chat只依赖健康/退出证据，原始第三方stdout/stderr也由统一launcher丢弃。
const disabledProviderLogPath = resolve(runRoot, "provider-file-logging-disabled");
writeFileSync(disabledProviderLogPath, "disabled\n", { encoding: "utf8", mode: 0o600 });
const configPath = resolve(runRoot, "tdai-gateway.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      deployMode: "standalone",
      stateBackend: "local",
      server: { host: "127.0.0.1", port, apiKey: token },
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
const contract = createMemorySidecarContract({
  root: repoRoot,
  provider: "memorycore",
  runtimeInstance,
  sourceCommit: FIXED_MEMORYCORE_COMMIT,
  port,
  runRoot,
  childCwd: fixedMemoryCoreRoot(repoRoot),
  commandFragments: ["--import", "tsx", "src/gateway/server.ts"],
});
const instanceId = randomUUID();
writeMemoryStartingEvidence(contract, { instanceId, wrapperPid: process.pid });
const child = spawn(process.execPath, ["--import", "tsx", "src/gateway/server.ts"], {
  cwd: fixedMemoryCoreRoot(repoRoot),
  detached: true,
  stdio: "inherit",
  env: createSafeChildProcessEnvironment(childEnvironmentRoot, {
    TDAI_GATEWAY_CONFIG: configPath,
    TDAI_GATEWAY_HOST: "127.0.0.1",
    TDAI_GATEWAY_PORT: String(port),
    TDAI_DATA_DIR: dataRoot,
    LOG_PATH: disabledProviderLogPath,
    V3_STRICT_ISOLATION: "true",
    NODE_NO_WARNINGS: "1",
  }),
});
if (child.pid === undefined) throw new Error("固定MemoryCore子进程没有PID");
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
  console.error(`[memorycore-start] 子进程失败：${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  try {
    writeMemoryStoppedEvidence(contract, instanceId, { exitCode: code, signal });
  } catch (error) {
    console.error(
      `[memorycore-start] 停止证据发布失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? code ?? (stopping ? 0 : 1));
});
