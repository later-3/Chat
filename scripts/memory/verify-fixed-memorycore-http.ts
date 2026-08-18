import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  memoryWriteIntentIdSchema,
  memoryImportIntentIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  workflowMemoryQueryIdSchema,
} from "../../packages/contracts/src/index.ts";
import { computeMemoryImportRequestSha256 } from "../../packages/domain/src/index.ts";
import {
  TENCENT_MEMORYCORE_BACKEND_ID,
  TencentMemoryCoreAdapter,
} from "../../packages/memory-runtime/src/index.ts";
import {
  FIXED_MEMORYCORE_COMMIT,
  FIXED_MEMORYCORE_PORT,
  ensureFixedMemoryCore,
  fixedMemoryCoreRoot,
  fixedMemoryCoreRunRoot,
} from "./fixed-memorycore.mjs";
import { chatRepoRoot } from "./fixed-memmy.mjs";
import { findListenerPid } from "../debug/lib.mjs";

const TOKEN = "chat-memorycore-local-test";
const SERVICE_ID = "chat-memorycore-service";
const TEAM_ID = "chat-memorycore-team";
const USER_ID = "chat-memorycore-user";
const AGENT_ID = "chat-memorycore-agent";
const IMPORT_CONTENT = "M3-MEMORYCORE-REAL-7319：服务器只接收在本地编译完成的产物。";
const QUERY_CONTENT = "M3-MEMORYCORE-BM25-4821：发布前必须完成真实模型与浏览器端到端测试。";
const WORKFLOW_WRITE_CONTENT =
  "WORKFLOW-MEMORY-REAL-9184：Memory Provider保持独立服务，Chat只冻结产品事实。";

const repoRoot = chatRepoRoot();
const runRoot = fixedMemoryCoreRunRoot(repoRoot);
rmSync(runRoot, { recursive: true, force: true });
mkdirSync(runRoot, { recursive: true });
ensureFixedMemoryCore(repoRoot);
if (findListenerPid(FIXED_MEMORYCORE_PORT) !== null) {
  throw new Error(`端口 ${FIXED_MEMORYCORE_PORT} 已被未知进程占用；真实门拒绝复用或终止`);
}

const service = spawn(
  process.execPath,
  [resolve(repoRoot, "scripts/memory/start-fixed-memorycore.mjs")],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CHAT_REPO_ROOT: repoRoot,
      CHAT_TENCENT_MEMORYCORE_RUN_ROOT: runRoot,
      CHAT_TENCENT_MEMORYCORE_TOKEN: TOKEN,
    },
  },
);

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) throw new Error("固定MemoryCore在健康检查前退出");
    try {
      const evidence = JSON.parse(
        readFileSync(resolve(runRoot, "service-process.json"), "utf8"),
      ) as { childPid?: unknown; sourceCommit?: unknown };
      if (
        typeof evidence.childPid !== "number" ||
        evidence.sourceCommit !== FIXED_MEMORYCORE_COMMIT ||
        findListenerPid(FIXED_MEMORYCORE_PORT) !== evidence.childPid
      ) {
        throw new Error("18970监听者不是本轮固定MemoryCore子进程");
      }
      const response = await fetch(`http://127.0.0.1:${FIXED_MEMORYCORE_PORT}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // 服务仍在初始化。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("固定MemoryCore 45秒内未就绪");
}

async function stopService(): Promise<void> {
  if (service.exitCode === null) {
    service.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveExit) => service.once("exit", () => resolveExit())),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("固定MemoryCore未响应SIGTERM")), 8_000),
      ),
    ]);
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && findListenerPid(FIXED_MEMORYCORE_PORT) !== null) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (findListenerPid(FIXED_MEMORYCORE_PORT) !== null) {
    throw new Error("固定MemoryCore退出后未释放18970");
  }
}

function adapter(overrides: { token?: string; teamId?: string } = {}) {
  return new TencentMemoryCoreAdapter({
    baseUrl: `http://127.0.0.1:${FIXED_MEMORYCORE_PORT}`,
    token: overrides.token ?? TOKEN,
    serviceId: SERVICE_ID,
    teamId: overrides.teamId ?? TEAM_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    configurationRevision: "fixed-3a9748d",
    credentialRevision: "memorycore-local-key-v1",
  });
}

async function countImportSession(sessionId: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${FIXED_MEMORYCORE_PORT}/v3/conversation/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "x-tdai-service-id": SERVICE_ID,
      "x-tdai-team-id": TEAM_ID,
      "x-tdai-user-id": USER_ID,
      "x-tdai-agent-id": AGENT_ID,
      "x-tdai-session-id": sessionId,
    },
    body: JSON.stringify({
      team_id: TEAM_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      session_id: sessionId,
      limit: 100,
      offset: 0,
    }),
  });
  const envelope = (await response.json()) as { code?: unknown; data?: { total?: unknown } };
  if (!response.ok || envelope.code !== 0 || typeof envelope.data?.total !== "number") {
    throw new Error("真实MemoryCore L0计数响应无效");
  }
  return envelope.data.total;
}

async function seedL1(sessionId: string): Promise<void> {
  const moduleUrl = pathToFileURL(
    resolve(fixedMemoryCoreRoot(repoRoot), "src/core/store/sqlite.ts"),
  ).href;
  const { VectorStore } = (await import(moduleUrl)) as {
    VectorStore: new (
      dbPath: string,
      dimensions: number,
    ) => {
      init(): Promise<unknown> | unknown;
      upsertL1(record: Record<string, unknown>): Promise<boolean> | boolean;
      close(): void;
    };
  };
  // v3数据面按x-tdai-service-id使用实例级Store，即使Gateway运行在standalone模式。
  const store = new VectorStore(resolve(runRoot, `data/instances/${SERVICE_ID}/vectors.db`), 0);
  try {
    await store.init();
    const now = "2026-08-08T12:00:00.000Z";
    const inserted = await store.upsertL1({
      id: "l1-m3-memorycore-real-4821",
      content: QUERY_CONTENT,
      type: "instruction",
      priority: 90,
      scene_name: "M3真实发布门",
      source_message_ids: ["msg-m3-memorycore-real"],
      metadata: {},
      timestamps: [now],
      createdAt: now,
      updatedAt: now,
      version: 1,
      sessionKey: sessionId,
      sessionId,
      teamId: TEAM_ID,
      userId: USER_ID,
      agentId: AGENT_ID,
    });
    if (!inserted) throw new Error("固定MemoryCore VectorStore拒绝L1 fixture");
  } finally {
    store.close();
  }
}

try {
  await waitForReady();
  const memory = adapter();
  const health = await memory.health();
  if (health.status !== "ready") throw new Error(`MemoryCore Adapter健康失败：${health.status}`);
  if (memory.describe().backendId !== TENCENT_MEMORYCORE_BACKEND_ID) {
    throw new Error("MemoryCore backendId漂移");
  }

  const shape = {
    kind: "tencent_conversation_capture" as const,
    content: IMPORT_CONTENT,
    layer: "L0" as const,
    turnId: "msg_m3memorycorereal",
  };
  const input = {
    operationId: memoryImportIntentIdSchema.parse("mii_m3memorycorereal"),
    requestSha256: computeMemoryImportRequestSha256(shape),
    content: shape.content,
    layer: shape.layer,
    title: "M3真实MemoryCore部署约束",
    tags: [],
    source: "chat.explicit_import" as const,
    sessionId: productSessionIdSchema.parse("psn_m3memorycorereal"),
    turnId: shape.turnId,
  };
  const accepted = await memory.import(input);
  if (
    accepted.externalObjectId !== `chat-import:${input.operationId}` ||
    accepted.externalStatus !== "l0_accepted"
  ) {
    throw new Error("真实MemoryCore未返回稳定L0 accepted身份");
  }
  const firstReconcile = await memory.reconcile({
    ...input,
    externalObjectId: accepted.externalObjectId,
  });
  if (firstReconcile.status !== "accepted") {
    throw new Error(`未产生L1时必须保持accepted，实际=${firstReconcile.status}`);
  }
  if ((await countImportSession(accepted.externalObjectId)) !== 1) {
    throw new Error("真实MemoryCore导入后L0对象数不是1");
  }

  await seedL1(accepted.externalObjectId);
  const query = await memory.query({
    operationId: "mqy_m3memorycorereal",
    productRunId: productRunIdSchema.parse("run_m3memorycorereal"),
    productSessionId: productSessionIdSchema.parse("psn_m3memorycorequery"),
    query: "真实模型 浏览器 端到端测试",
    tags: [],
    layers: ["L1"],
    limit: 5,
    contextBudget: 1_800,
  });
  if (
    query.hitCount < 1 ||
    query.sections.length !== 1 ||
    !query.sections[0]?.content.includes("M3-MEMORYCORE-BM25-4821")
  ) {
    throw new Error("真实MemoryCore BM25 atomic/search未命中固定L1");
  }
  const workflowQuery = await memory.queryMemory({
    operationId: workflowMemoryQueryIdSchema.parse("wmq_m3memorycoreworkflow"),
    productRunId: productRunIdSchema.parse("run_m3memorycoreworkflow"),
    productSessionId: productSessionIdSchema.parse("psn_m3memorycoreworkflow"),
    principalId: "usr_m3memorycoreworkflow" as never,
    query: "真实模型 浏览器 端到端测试",
    maxResults: 5,
    maxContextCharacters: 8_000,
  });
  if (
    workflowQuery.hitCount < 1 ||
    workflowQuery.sections.length !== 1 ||
    workflowQuery.sections[0]?.category !== "procedure" ||
    !workflowQuery.sections[0]?.content.includes("M3-MEMORYCORE-BM25-4821")
  ) {
    throw new Error("Workflow Memory通用Query Port未归一化真实MemoryCore L1");
  }
  const materialized = await memory.reconcile({
    ...input,
    externalObjectId: accepted.externalObjectId,
  });
  if (
    materialized.status !== "materialized" ||
    materialized.verificationKind !== "l0_and_session_l1"
  ) {
    throw new Error("真实MemoryCore同session L1未升级materialized");
  }
  if ((await countImportSession(accepted.externalObjectId)) !== 1) {
    throw new Error("重复对账产生了第二条L0");
  }

  const workflowWriteInput = {
    operationId: memoryWriteIntentIdSchema.parse("mwi_m3memorycoreworkflow"),
    requestSha256: "d".repeat(64),
    content: WORKFLOW_WRITE_CONTENT,
    contentType: "conversation_turn" as const,
    productSessionId: productSessionIdSchema.parse("psn_m3memorycoreworkflowwrite"),
    principalId: "usr_m3memorycoreworkflow" as never,
    sourceMessageId: "msg_m3memorycoreworkflow",
  };
  const workflowAccepted = await memory.writeMemory(workflowWriteInput);
  if (
    workflowAccepted.externalObjectId !== `chat-import:${workflowWriteInput.operationId}` ||
    workflowAccepted.externalStatus !== "l0_accepted"
  ) {
    throw new Error("Workflow Memory通用Write Port未返回稳定L0身份");
  }
  const workflowReconciled = await memory.reconcileMemoryWrite({
    ...workflowWriteInput,
    externalObjectId: workflowAccepted.externalObjectId,
  });
  if (workflowReconciled.status !== "accepted") {
    throw new Error(`Workflow Memory只读对账未保持accepted，实际=${workflowReconciled.status}`);
  }
  if ((await countImportSession(workflowAccepted.externalObjectId)) !== 1) {
    throw new Error("Workflow Memory Write或对账重复产生L0");
  }

  await adapter({ token: "wrong-memorycore-token" })
    .query({
      operationId: "mqy_wrongtoken",
      productRunId: productRunIdSchema.parse("run_wrongtoken"),
      productSessionId: productSessionIdSchema.parse("psn_wrongtoken"),
      query: "真实测试",
      tags: [],
      layers: ["L1"],
      limit: 1,
      contextBudget: 512,
    })
    .then(
      () => {
        throw new Error("错误Token被MemoryCore接受");
      },
      (error: unknown) => {
        if (!(error instanceof Error) || !String(error).includes("HTTP 401")) throw error;
      },
    );

  const isolated = await adapter({ teamId: "other-team" }).query({
    operationId: "mqy_wrongteam",
    productRunId: productRunIdSchema.parse("run_wrongteam"),
    productSessionId: productSessionIdSchema.parse("psn_wrongteam"),
    query: "真实模型 浏览器 端到端测试",
    tags: [],
    layers: ["L1"],
    limit: 5,
    contextBudget: 1_800,
  });
  if (isolated.hitCount !== 0 || isolated.sections.length !== 0) {
    throw new Error("错误team隔离仍召回L1");
  }

  console.log(
    "[memorycore-real-http] 固定源码、Workflow Query/Write Port、真实L0 accepted、只读对账、BM25 L1查询、materialized与隔离门通过",
  );
} finally {
  await stopService();
}
