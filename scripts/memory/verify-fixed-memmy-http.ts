import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  productRunIdSchema,
  productSessionIdSchema,
  memoryImportIntentIdSchema,
  memoryWriteIntentIdSchema,
  principalIdSchema,
  workflowMemoryQueryIdSchema,
  type MemoryLayer,
} from "../../packages/contracts/src/index.ts";
import { MEMMY_BACKEND_ID, MemmyMemoryAdapter } from "../../packages/memory-runtime/src/index.ts";
import { computeMemoryImportRequestSha256 } from "../../packages/domain/src/index.ts";
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
await ensureFixedMemmy(repoRoot);
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

  const importShape = {
    content: "M2-REAL-IMPORT-7319：发布前必须完成真实浏览器与回放验收。",
    layer: "L2" as const,
    title: "M2 真实导入规则",
    tags: ["m2-real-import", "release-gate"],
    turnId: "msg_m2realimport1",
  };
  const importInput = {
    operationId: memoryImportIntentIdSchema.parse("mii_m2realimport1"),
    requestSha256: computeMemoryImportRequestSha256(importShape),
    ...importShape,
    source: "chat.explicit_import" as const,
    productSessionId: productSessionIdSchema.parse("psn_m2realimport1"),
  };
  const adapterInput = {
    ...importInput,
    sessionId: importInput.productSessionId,
  };
  const first = await adapter.import(adapterInput);
  const duplicate = await adapter.import(adapterInput);
  if (duplicate.externalObjectId !== first.externalObjectId) {
    throw new Error("固定 memmy 未按相同adapterId/requestId/正文返回同一外部对象");
  }
  const conflict = await fetch(`http://127.0.0.1:${FIXED_MEMMY_PORT}/api/v1/memory/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: adapterInput.operationId,
      adapterId: "chat",
      namespace: {
        source: "chat",
        profileId: "chat-debug",
        sessionKey: adapterInput.sessionId,
      },
      ...importShape,
      content: `${importShape.content} 冲突正文`,
      deferProcessing: false,
    }),
  });
  if (conflict.status !== 409) {
    throw new Error(`相同requestId不同正文未返回409，而是${String(conflict.status)}`);
  }
  const materialized = await adapter.reconcile({
    ...adapterInput,
    externalObjectId: first.externalObjectId,
  });
  if (materialized.status !== "materialized") {
    throw new Error(`真实GET+Search未证明materialized，而是${materialized.status}`);
  }
  const detailResponse = await fetch(
    `http://127.0.0.1:${FIXED_MEMMY_PORT}/api/v1/memory/${encodeURIComponent(first.externalObjectId)}`,
  );
  const detail = (await detailResponse.json()) as {
    body?: unknown;
    memoryLayer?: unknown;
    title?: unknown;
    tags?: unknown;
  };
  const detailTags = Array.isArray(detail.tags)
    ? detail.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  if (
    !detailResponse.ok ||
    detail.body !== importShape.content ||
    detail.memoryLayer !== "L2" ||
    detail.title !== importShape.title ||
    !["manual", ...importShape.tags].every((tag) => detailTags.includes(tag))
  ) {
    throw new Error("真实memmy GET未保留正文、L2、标题与固定manual+用户标签");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(first.externalObjectId)) {
    throw new Error("真实memmy external ID包含不安全字符，拒绝拼接SQLite只读断言");
  }
  const objectCount = execFileSync(
    "/usr/bin/sqlite3",
    [
      resolve(runRoot, "memory.sqlite"),
      `SELECT COUNT(*) FROM memories WHERE id='${first.externalObjectId}';`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (objectCount !== "1") throw new Error(`真实memmy幂等对象数不是1，而是${objectCount}`);

  const workflowContent =
    "WF-MEMMY-REAL-4927：Memory Workflow写入后只能通过只读GET对账，禁止二次POST。";
  const workflowWriteInput = {
    operationId: memoryWriteIntentIdSchema.parse("mwi_memmyworkflowreal"),
    requestSha256: "e".repeat(64),
    content: workflowContent,
    contentType: "conversation_turn" as const,
    principalId: principalIdSchema.parse("usr_debug"),
    sessionKey: productSessionIdSchema.parse("psn_memmyworkflowreal"),
    turnKey: "msg_memmyworkflowreal",
  };
  const workflowAccepted = await adapter.writeMemory(workflowWriteInput);
  const knownIdReconcile = await adapter.reconcileMemoryWrite({
    ...workflowWriteInput,
    externalObjectId: workflowAccepted.externalObjectId,
  });
  const lostIdReconcile = await adapter.reconcileMemoryWrite(workflowWriteInput);
  if (
    knownIdReconcile.status !== "materialized" ||
    lostIdReconcile.status !== "materialized" ||
    lostIdReconcile.accepted.externalObjectId !== workflowAccepted.externalObjectId ||
    knownIdReconcile.verificationKind !== "read_by_id" ||
    lostIdReconcile.verificationKind !== "read_by_id"
  ) {
    throw new Error("真实memmy Workflow写入未能通过已知ID与丢失ID两条只读对账路径");
  }
  const workflowQuery = await adapter.queryMemory({
    operationId: workflowMemoryQueryIdSchema.parse("wmq_memmyworkflowreal"),
    productRunId: productRunIdSchema.parse("run_memmyworkflowreal"),
    productSessionId: workflowWriteInput.sessionKey,
    principalId: workflowWriteInput.principalId,
    query: "WF-MEMMY-REAL-4927 只读GET对账",
    maxResults: 5,
    maxContextCharacters: 8_000,
  });
  if (
    workflowQuery.hitCount < 1 ||
    !workflowQuery.sections.some((section) => section.content.includes("WF-MEMMY-REAL-4927"))
  ) {
    throw new Error("真实memmy Workflow Query未召回刚写入的L2对象");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(workflowAccepted.externalObjectId)) {
    throw new Error("真实memmy Workflow external ID包含不安全字符");
  }
  const workflowObjectCount = execFileSync(
    "/usr/bin/sqlite3",
    [
      resolve(runRoot, "memory.sqlite"),
      `SELECT COUNT(*) FROM memories WHERE id='${workflowAccepted.externalObjectId}';`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (workflowObjectCount !== "1") {
    throw new Error(`只读对账后Workflow对象数不是1，而是${workflowObjectCount}`);
  }

  console.log(
    "[memmy-real-http] 固定源码、Legacy Import、Workflow Query/Write、已知/丢失ID只读对账与SQLite唯一对象门通过",
  );
} finally {
  await stopService();
}
