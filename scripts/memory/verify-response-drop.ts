import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMemoryWrite,
  createProductSession,
  submitUserMessage,
  updateOutboxStatus,
} from "../../packages/application/src/index.ts";
import { productSnapshotSchema } from "../../packages/contracts/src/index.ts";
import { assertSnapshotIntegrity } from "../../packages/product-store-json/src/index.ts";
import { createTraceSink } from "../../packages/realtime/src/trace-sink.ts";
import { createPiAgentRuntimeProfileReader } from "../../packages/pi-runtime/src/coding-agent-runtime-profile.ts";
import { createApplicationDeps, DEBUG_PRINCIPAL_ID } from "../../apps/api/src/composition.ts";
import {
  FIXED_MEMMY_PORT,
  assertChatDataPath,
  chatRepoRoot,
  ensureFixedMemmy,
} from "./fixed-memmy.mjs";
import { findListenerPid } from "../debug/lib.mjs";

const repoRoot = chatRepoRoot();
const runRoot = assertChatDataPath(
  resolve(repoRoot, ".data/tests/memmy-response-drop"),
  repoRoot,
  "response drop run root",
);
const storePath = resolve(runRoot, "product-store.v3.json");
const traceDir = resolve(runRoot, "traces");
const workflowDataDir = resolve(runRoot, "workflow");
const bindingsPath = resolve(runRoot, "runtime-bindings.v2.json");
const memmyRoot = resolve(runRoot, "memmy");
const dbPath = resolve(memmyRoot, "memory.sqlite");
// 真实门使用独立测试端口，不能与普通 pnpm dev 的43111/43112争用或要求停机。
const apiPort = 45_111;
const workflowPort = 45_112;
const runtimeKey = "rtk_memmyresponsedrop20260808";
const canary = "M2-RESPONSE-DROP-7319";

rmSync(runRoot, { recursive: true, force: true });
mkdirSync(runRoot, { recursive: true });
await ensureFixedMemmy(repoRoot);
for (const port of [FIXED_MEMMY_PORT, FIXED_MEMMY_PORT + 1, apiPort, workflowPort]) {
  if (findListenerPid(port) !== null) throw new Error(`端口${String(port)}被未知进程占用`);
}

function directTsxCommand(packageRoot: string, entry: string): readonly [string, string[]] {
  const tsxRoot = resolve(repoRoot, packageRoot, "node_modules/tsx/dist");
  return [
    process.execPath,
    [
      "--require",
      resolve(tsxRoot, "preflight.cjs"),
      "--import",
      pathToFileURL(resolve(tsxRoot, "loader.mjs")).href,
      resolve(repoRoot, entry),
    ],
  ];
}

function spawnTsx(packageRoot: string, entry: string, env: NodeJS.ProcessEnv): ChildProcess {
  const [command, args] = directTsxCommand(packageRoot, entry);
  return spawn(command, args, { cwd: repoRoot, env, stdio: "inherit" });
}

async function waitReady(url: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`服务就绪前退出: ${url}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`服务45秒内未就绪: ${url}`);
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => process.once("exit", () => resolveExit())),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 7_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

function traceText(): string {
  return readdirSync(traceDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => readFileSync(resolve(traceDir, name), "utf8"))
    .join("\n");
}

async function waitForMaterialized(
  resultId: string,
): Promise<ReturnType<typeof productSnapshotSchema.parse>> {
  const deadline = Date.now() + 90_000;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    try {
      const snapshot = productSnapshotSchema.parse(JSON.parse(readFileSync(storePath, "utf8")));
      assertSnapshotIntegrity(snapshot);
      const result = snapshot.entities.memoryWriteResults[resultId as never];
      lastStatus = result?.status ?? "missing";
      if (result?.status === "materialized") return snapshot;
      if (result?.status === "failed") {
        throw new Error(`真实Chat写入进入failed: ${result.errorCode}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("真实Chat写入进入failed")) throw error;
      // API正在atomic rename；下轮重新读取完整快照。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`真实Chat写入响应丢失闭环90秒未materialized，最后状态=${lastStatus}`);
}

process.env.CHAT_MEMMY_BASE_URL = `http://127.0.0.1:${String(FIXED_MEMMY_PORT)}`;
process.env.CHAT_MEMMY_CONFIG_REVISION = "response-drop-v1";
process.env.CHAT_MEMORY_MODE = "memmy";
const seedTrace = createTraceSink({ dir: traceDir });
const seedBaseDeps = await createApplicationDeps(storePath, (event) => seedTrace.emit(event));
const seedDeps = {
  ...seedBaseDeps,
  // 本门只需确定性编译Message/Run；本地读取固定Pi基线，既不依赖已启动API，
  // 也不连接生产43115或发起任何模型请求。
  agentRuntimeProfiles: createPiAgentRuntimeProfileReader({ previewCwd: repoRoot }),
};
const { session } = await createProductSession(seedDeps, {
  principalId: DEBUG_PRINCIPAL_ID,
  commandId: "cmd_responsedropsession1" as never,
  payload: {},
});
const { message } = await submitUserMessage(seedDeps, {
  principalId: DEBUG_PRINCIPAL_ID,
  sessionId: session.sessionId,
  commandId: "cmd_responsedropmessage1" as never,
  payload: { text: `${canary}：真实写入响应丢失后必须由Chat工作流原生幂等对账。` },
});
if (message.sha256 === undefined) throw new Error("响应丢失测试Message缺少Hash");
const seededSnapshot = (await seedDeps.store.read({ kind: "committedSnapshot" })).snapshot;
const planningOutbox = Object.values(seededSnapshot.outbox).find(
  (entry) => entry.kind === "workflow_start",
);
if (planningOutbox === undefined) throw new Error("响应丢失测试缺少规划Outbox");
await updateOutboxStatus(seedDeps, {
  commandId: "cmd_responsedropdisableplanning1" as never,
  outboxId: planningOutbox.outboxId,
  status: "failed_terminal",
});
const currentSession = seededSnapshot.entities.sessions[session.sessionId];
if (currentSession === undefined) throw new Error("响应丢失测试Session不存在");
const { memoryWrite } = await createMemoryWrite(seedDeps, {
  principalId: DEBUG_PRINCIPAL_ID,
  commandId: "cmd_responsedropwrite1" as never,
  payload: {
    productSessionId: session.sessionId,
    providerId: "mbk_memmy" as never,
    sourceSelection: {
      kind: "full_message",
      sourceMessageId: message.messageId,
      sourceMessageSha256: message.sha256,
    },
    expectedSessionRevision: currentSession.revision,
  },
});

const memmy = spawn(process.execPath, [resolve(repoRoot, "scripts/memory/start-fixed-memmy.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    CHAT_REPO_ROOT: repoRoot,
    CHAT_MEMMY_RUN_ROOT: memmyRoot,
    CHAT_MEMMY_DB_PATH: dbPath,
    CHAT_MEMMY_PORT: String(FIXED_MEMMY_PORT + 1),
    CHAT_MEMMY_TEST_ALLOW_ALTERNATE_PORT: "1",
  },
});
const proxy = spawn(
  process.execPath,
  [resolve(repoRoot, "scripts/memory/response-drop-proxy.mjs")],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "C.UTF-8" },
  },
);
const serviceEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CHAT_REPO_ROOT: repoRoot,
  CHAT_PRODUCT_STORE_PATH: storePath,
  CHAT_TRACE_DIR: traceDir,
  CHAT_WORKFLOW_DATA_DIR: workflowDataDir,
  CHAT_RUNTIME_BINDINGS_PATH: bindingsPath,
  CHAT_WORKFLOW_BUNDLE_DIR: resolve(repoRoot, "packages/workflows/.workflow-bundle"),
  CHAT_MEMMY_BASE_URL: `http://127.0.0.1:${String(FIXED_MEMMY_PORT)}`,
  CHAT_MEMMY_CONFIG_REVISION: "response-drop-v1",
  CHAT_RUNTIME_KEY: runtimeKey,
  CHAT_WORKFLOW_BASE_URL: `http://127.0.0.1:${String(workflowPort)}`,
  CHAT_API_INTERNAL_BASE_URL: `http://127.0.0.1:${String(apiPort)}`,
  PORT: String(apiPort),
  CHAT_WORKFLOW_PORT: String(workflowPort),
};
delete serviceEnv.DASHSCOPE_API_KEY;
const workflow = spawnTsx(
  "packages/workflows",
  "packages/workflows/src/runtime-main.ts",
  serviceEnv,
);
const api = spawnTsx("apps/api", "apps/api/src/index.ts", serviceEnv);

try {
  await waitReady(`http://127.0.0.1:${String(FIXED_MEMMY_PORT + 1)}/api/v1/health`, memmy);
  await waitReady(`http://127.0.0.1:${String(FIXED_MEMMY_PORT)}/api/v1/health`, proxy);
  await waitReady(`http://127.0.0.1:${String(workflowPort)}/healthz`, workflow);
  await waitReady(`http://127.0.0.1:${String(apiPort)}/api/readyz`, api);
  const finalSnapshot = await waitForMaterialized(memoryWrite.memoryWriteResultId);
  const finalResult = finalSnapshot.entities.memoryWriteResults[memoryWrite.memoryWriteResultId];
  if (finalResult?.status !== "materialized" || finalResult.reconcileAttempts < 1) {
    throw new Error("真实Chat闭环没有以对账方式提交materialized");
  }
  const writeOutbox = Object.values(finalSnapshot.outbox).find(
    (entry) =>
      entry.kind === "memory_write_start" &&
      entry.memoryWriteIntentId === memoryWrite.memoryWriteIntentId,
  );
  if (writeOutbox?.status !== "acknowledged") {
    throw new Error("真实Chat Write Outbox没有acknowledged");
  }
  const count = execFileSync("/usr/bin/sqlite3", [dbPath, "SELECT COUNT(*) FROM memories;"], {
    encoding: "utf8",
  }).trim();
  if (count !== "1") throw new Error(`响应丢失后真实memmy对象数不是1: ${count}`);

  const trace = traceText();
  if (trace.includes(canary) || trace.includes("真实写入响应丢失后必须")) {
    throw new Error("真实Chat Trace错误复制了Message正文");
  }
  console.log(
    "[memmy-response-drop] Chat Store→Write Outbox→Workflow→真实memmy断响应→outcome_unknown→同身份只读对账→materialized；唯一对象与Trace无正文门通过",
  );
} finally {
  await stop(api);
  await stop(workflow);
  await stop(proxy);
  await stop(memmy);
  for (const port of [FIXED_MEMMY_PORT, FIXED_MEMMY_PORT + 1, apiPort, workflowPort]) {
    if (findListenerPid(port) !== null) throw new Error(`测试结束后端口${String(port)}未释放`);
  }
}
