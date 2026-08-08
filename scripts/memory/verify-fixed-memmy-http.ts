import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  productRunIdSchema,
  productSessionIdSchema,
  type MemoryLayer,
} from "../../packages/contracts/src/index.ts";
import { MEMMY_BACKEND_ID, MemmyMemoryAdapter } from "../../packages/memory-runtime/src/index.ts";
import {
  FIXED_MEMMY_PORT,
  assertChatDataPath,
  chatRepoRoot,
  ensureFixedMemmy,
} from "./fixed-memmy.mjs";
import {
  MEMORY_REAL_DISTRACTOR,
  MEMORY_REAL_FACT,
  MEMORY_REAL_TAG,
  seedMemoryPlanningReal,
} from "./seed-memory-planning-real.mjs";
import { findListenerPid } from "../debug/lib.mjs";

const repoRoot = chatRepoRoot();
const runRoot = assertChatDataPath(
  resolve(repoRoot, ".data/tests/fixed-memmy-http"),
  repoRoot,
  "fixed memmy HTTP test root",
);
rmSync(runRoot, { recursive: true, force: true });
mkdirSync(runRoot, { recursive: true });
ensureFixedMemmy(repoRoot);
if (findListenerPid(FIXED_MEMMY_PORT) !== null) {
  throw new Error(`端口 ${FIXED_MEMMY_PORT} 已被未知进程占用；真实 HTTP 门拒绝复用或终止`);
}

const service = spawn(
  process.execPath,
  [resolve(repoRoot, "scripts/memory/start-fixed-memmy.mjs")],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CHAT_REPO_ROOT: repoRoot,
      CHAT_MEMMY_RUN_ROOT: runRoot,
      CHAT_MEMMY_DB_PATH: resolve(runRoot, "memory.sqlite"),
    },
  },
);

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) throw new Error("固定 memmy 在健康检查前退出");
    try {
      const evidence = JSON.parse(
        readFileSync(resolve(runRoot, "service-process.json"), "utf8"),
      ) as { childPid?: unknown };
      if (
        typeof evidence.childPid !== "number" ||
        findListenerPid(FIXED_MEMMY_PORT) !== evidence.childPid
      ) {
        throw new Error("18960 监听者不是本轮登记的固定 memmy child");
      }
      const response = await fetch(`http://127.0.0.1:${FIXED_MEMMY_PORT}/api/v1/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // 服务仍在初始化。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("固定 memmy 30 秒内未就绪");
}

async function stopService(): Promise<void> {
  if (service.exitCode !== null) return;
  service.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => service.once("exit", () => resolveExit())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("固定 memmy 未响应 SIGTERM")), 7_000),
    ),
  ]);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && findListenerPid(FIXED_MEMMY_PORT) !== null) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (findListenerPid(FIXED_MEMMY_PORT) !== null) {
    throw new Error("固定 memmy wrapper 退出后未释放 18960");
  }
}

try {
  await waitForReady();
  await seedMemoryPlanningReal({
    evidencePath: resolve(runRoot, "seed-evidence.json"),
  });
  const adapter = new MemmyMemoryAdapter({ baseUrl: `http://127.0.0.1:${FIXED_MEMMY_PORT}` });
  const health = await adapter.health();
  if (health.status !== "ready") throw new Error("Chat memmy Adapter 健康门未就绪");
  const result = await adapter.query({
    operationId: "mqy_fixedrealhttp",
    productRunId: productRunIdSchema.parse("run_fixedrealhttp"),
    productSessionId: productSessionIdSchema.parse("psn_fixedrealhttp"),
    query: `项目 Atlas 的生产部署代号是什么？请使用 ${MEMORY_REAL_TAG} 记录。`,
    tags: [MEMORY_REAL_TAG],
    layers: ["L2"] satisfies MemoryLayer[],
    limit: 2,
    contextBudget: 1_800,
  });
  if (
    adapter.describe().backendId !== MEMMY_BACKEND_ID ||
    result.hitCount !== 1 ||
    result.sections.length !== 1 ||
    !result.sections[0]?.content.includes(MEMORY_REAL_FACT) ||
    result.sections[0]?.content.includes(MEMORY_REAL_DISTRACTOR)
  ) {
    throw new Error("Chat memmy Adapter 未从固定真服务取得唯一正确 L2 来源");
  }
  console.log("[memmy-real-http] 固定源码、真实 HTTP、Chat Adapter、标签/L2 门通过");
} finally {
  await stopService();
}
