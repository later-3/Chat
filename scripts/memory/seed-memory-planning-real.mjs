import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FIXED_MEMMY_COMMIT,
  FIXED_MEMMY_PORT,
  FIXED_MEMMY_TREE,
  assertChatDataPath,
  chatRepoRoot,
} from "./fixed-memmy.mjs";

export const MEMORY_REAL_FACT = "Heliotrope-7319";
export const MEMORY_REAL_DISTRACTOR = "Cobalt-2048";
export const MEMORY_REAL_TAG = "deployment-code";

const memories = [
  {
    requestId: "chat_m1_seed_deployment_code_v1",
    title: "Atlas 部署代号",
    tags: ["m1-e2e", MEMORY_REAL_TAG],
    content: `项目 Atlas 的生产部署代号是 ${MEMORY_REAL_FACT}。规划涉及部署标识时必须逐字使用该代号。`,
  },
  {
    requestId: "chat_m1_seed_design_token_v1",
    title: "Atlas 界面强调色",
    tags: ["m1-e2e", "design-token"],
    content: `项目 Atlas 的界面强调色是 ${MEMORY_REAL_DISTRACTOR}，这不是部署代号。`,
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`memmy ${path} 返回 HTTP ${response.status}`);
  return json;
}

export async function seedMemoryPlanningReal(options = {}) {
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${FIXED_MEMMY_PORT}`;
  const healthResponse = await fetch(`${baseUrl}/api/v1/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  const health = await healthResponse.json();
  if (
    !healthResponse.ok ||
    health?.ok !== true ||
    health?.version !== "1.0.4" ||
    !health?.capabilities?.tools?.includes("memory.search")
  ) {
    throw new Error("固定 memmy 健康合同或版本不符合 M1 证据");
  }

  const namespace = { source: "chat", profileId: "chat-debug" };
  const addedIds = [];
  for (const memory of memories) {
    const added = await postJson(baseUrl, "/api/v1/memory/add", {
      requestId: memory.requestId,
      adapterId: "chat",
      namespace,
      layer: "L2",
      title: memory.title,
      tags: memory.tags,
      content: memory.content,
      source: "chat-m1-real-e2e",
      deferProcessing: true,
    });
    if (typeof added?.id !== "string" || added?.memoryLayer !== "L2") {
      throw new Error("固定 memmy memory.add 响应不符合 L2 种子合同");
    }
    addedIds.push(added.id);
  }

  const searched = await postJson(baseUrl, "/api/v1/memory/search", {
    requestId: "chat_m1_seed_verification_v1",
    adapterId: "chat",
    namespace,
    query: `项目 Atlas 的生产部署代号是什么？请查找 ${MEMORY_REAL_TAG}。`,
    layers: ["L2"],
    tags: [MEMORY_REAL_TAG],
    limit: 2,
    contextBudget: 1_800,
    includeInjectedContext: true,
    verbose: true,
  });
  const sections = searched?.debug?.sections;
  const sourceIds = searched?.debug?.sourceMemoryIds;
  if (
    !Array.isArray(sections) ||
    sections.length !== 1 ||
    !Array.isArray(sourceIds) ||
    new Set(sourceIds).size !== 1 ||
    !sections[0]?.content?.includes(MEMORY_REAL_FACT) ||
    sections[0]?.content?.includes(MEMORY_REAL_DISTRACTOR)
  ) {
    throw new Error("固定 memmy 真实搜索没有唯一命中部署代号 L2 来源");
  }

  const repoRoot = chatRepoRoot();
  const evidencePath = assertChatDataPath(
    options.evidencePath ??
      process.env.CHAT_MEMMY_EVIDENCE_PATH ??
      resolve(repoRoot, ".data/e2e/memory-planning-real/memmy-seed-evidence.json"),
    repoRoot,
    "memmy evidence",
  );
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schemaVersion: "chat-memory-real-seed-evidence.v1",
        sourceCommit: FIXED_MEMMY_COMMIT,
        sourceTree: FIXED_MEMMY_TREE,
        serviceVersion: health.version,
        seededCount: addedIds.length,
        selectedSourceCount: new Set(sourceIds).size,
        selectedSectionSha256: sha256(sections[0].content),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log("[memmy-seed] 2 条可区分 L2 已写入；标签过滤真实命中 1 条");
  return { addedIds, sourceIds: [...new Set(sourceIds)], evidencePath };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  seedMemoryPlanningReal().catch((error) => {
    console.error(`[memmy-seed] ${error instanceof Error ? error.message : "种子验证失败"}`);
    process.exitCode = 1;
  });
}
