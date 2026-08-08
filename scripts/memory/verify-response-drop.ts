import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  memoryImportIntentIdSchema,
  productSessionIdSchema,
} from "../../packages/contracts/src/index.ts";
import { computeMemoryImportRequestSha256 } from "../../packages/domain/src/index.ts";
import { MemoryImportBackendError } from "../../packages/application/src/index.ts";
import { MemmyMemoryAdapter } from "../../packages/memory-runtime/src/index.ts";
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
rmSync(runRoot, { recursive: true, force: true });
mkdirSync(runRoot, { recursive: true });
ensureFixedMemmy(repoRoot);
for (const port of [FIXED_MEMMY_PORT, FIXED_MEMMY_PORT + 1]) {
  if (findListenerPid(port) !== null) throw new Error(`端口${String(port)}被未知进程占用`);
}

const memmyRoot = resolve(runRoot, "memmy");
const dbPath = resolve(memmyRoot, "memory.sqlite");
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

async function waitReady(url: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
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
  throw new Error(`服务30秒内未就绪: ${url}`);
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

try {
  await waitReady(`http://127.0.0.1:${String(FIXED_MEMMY_PORT + 1)}/api/v1/health`, memmy);
  await waitReady(`http://127.0.0.1:${String(FIXED_MEMMY_PORT)}/api/v1/health`, proxy);
  const adapter = new MemmyMemoryAdapter({
    baseUrl: `http://127.0.0.1:${String(FIXED_MEMMY_PORT)}`,
  });
  const shape = {
    content: "M2-RESPONSE-DROP-7319：真实写入响应丢失后必须原生幂等对账。",
    layer: "L2" as const,
    title: "M2 响应丢失验证",
    tags: ["m2-response-drop"],
    turnId: "msg_responsedrop1",
  };
  const input = {
    operationId: memoryImportIntentIdSchema.parse("mii_responsedrop1"),
    requestSha256: computeMemoryImportRequestSha256(shape),
    ...shape,
    source: "chat.explicit_import" as const,
    sessionId: productSessionIdSchema.parse("psn_responsedrop1"),
  };
  let uncertain: MemoryImportBackendError | undefined;
  try {
    await adapter.import(input);
  } catch (error) {
    if (error instanceof MemoryImportBackendError) uncertain = error;
    else throw error;
  }
  if (uncertain?.phase !== "write_outcome_unknown") {
    throw new Error("真实响应丢失未被分类为write_outcome_unknown");
  }
  const reconciled = await adapter.reconcile(input);
  if (reconciled.status !== "materialized") {
    throw new Error(`真实原生幂等对账未materialized: ${reconciled.status}`);
  }
  const count = execFileSync("/usr/bin/sqlite3", [dbPath, "SELECT COUNT(*) FROM memories;"], {
    encoding: "utf8",
  }).trim();
  if (count !== "1") throw new Error(`响应丢失后真实memmy对象数不是1: ${count}`);
  console.log("[memmy-response-drop] 真实写入、断响应、同身份对账、materialized、唯一对象门通过");
} finally {
  await stop(proxy);
  await stop(memmy);
  for (const port of [FIXED_MEMMY_PORT, FIXED_MEMMY_PORT + 1]) {
    if (findListenerPid(port) !== null) throw new Error(`测试结束后端口${String(port)}未释放`);
  }
}
