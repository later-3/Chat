import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { productRunIdSchema, productSessionIdSchema } from "../../packages/contracts/src/index.ts";
import { TencentMemoryCoreAdapter } from "../../packages/memory-runtime/src/index.ts";
import { chatRepoRoot } from "./fixed-memmy.mjs";
import { fixedMemoryCoreRoot } from "./fixed-memorycore.mjs";

export const MEMORYCORE_REAL_CANARY = "MEMORYCORE-PLAN-CANARY-9482";
export const MEMORYCORE_REAL_CONTENT = `${MEMORYCORE_REAL_CANARY}：发布前必须完成真实模型、Workflow与浏览器端到端测试。`;
export const MEMORYCORE_E2E_TOKEN = "chat-memorycore-e2e-local";
export const MEMORYCORE_E2E_SERVICE_ID = "chat-memorycore-e2e-service";
export const MEMORYCORE_E2E_TEAM_ID = "chat-memorycore-e2e-team";
export const MEMORYCORE_E2E_USER_ID = "chat-memorycore-e2e-user";
export const MEMORYCORE_E2E_AGENT_ID = "chat-memorycore-e2e-agent";

const repoRoot = chatRepoRoot();
const dataRoot = resolve(repoRoot, ".data/e2e/memorycore-real/memorycore/data");
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
const store = new VectorStore(
  resolve(dataRoot, `instances/${MEMORYCORE_E2E_SERVICE_ID}/vectors.db`),
  0,
);
try {
  await store.init();
  const now = "2026-08-08T14:00:00.000Z";
  const ok = await store.upsertL1({
    id: "l1-memorycore-browser-real-9482",
    content: MEMORYCORE_REAL_CONTENT,
    type: "instruction",
    priority: 100,
    scene_name: "M3真实浏览器完成门",
    source_message_ids: ["msg-memorycore-browser-seed"],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 1,
    sessionKey: "seed:memorycore-browser-real",
    sessionId: "seed:memorycore-browser-real",
    teamId: MEMORYCORE_E2E_TEAM_ID,
    userId: MEMORYCORE_E2E_USER_ID,
    agentId: MEMORYCORE_E2E_AGENT_ID,
  });
  if (!ok) throw new Error("MemoryCore固定Store拒绝浏览器L1种子");
} finally {
  store.close();
}

const adapter = new TencentMemoryCoreAdapter({
  baseUrl: "http://127.0.0.1:18970",
  token: MEMORYCORE_E2E_TOKEN,
  serviceId: MEMORYCORE_E2E_SERVICE_ID,
  teamId: MEMORYCORE_E2E_TEAM_ID,
  userId: MEMORYCORE_E2E_USER_ID,
  agentId: MEMORYCORE_E2E_AGENT_ID,
  configurationRevision: "fixed-3a9748d",
  credentialRevision: "memorycore-e2e-key-v1",
});
const result = await adapter.query({
  operationId: "mqy_memorycoree2eseed",
  productRunId: productRunIdSchema.parse("run_memorycoree2eseed"),
  productSessionId: productSessionIdSchema.parse("psn_memorycoree2eseed"),
  query: "真实模型 Workflow 浏览器 端到端测试",
  tags: [],
  layers: ["L1"],
  limit: 2,
  contextBudget: 1_800,
});
if (result.sections.length !== 1 || !result.sections[0]?.content.includes(MEMORYCORE_REAL_CANARY)) {
  throw new Error("MemoryCore浏览器E2E种子未通过真实BM25查询");
}
console.log("[memorycore-e2e-seed] 固定Store L1与真实atomic/search门通过");
