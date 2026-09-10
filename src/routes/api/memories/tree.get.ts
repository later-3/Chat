import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createError, defineEventHandler } from "nitro/h3";
import { ensureChatHome, getChatHomePaths } from "../../../chat-home.js";
import { readLongAgentRegistry } from "../../../long-agents/storage.js";
import { MemoryRepository } from "../../../memory/repository.js";
import { listProjects, resolveProjectContext } from "../../../projects/registry.js";
import { isSystemLongAgentProjectId } from "../../../projects/system-projects.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function activeTotal(repository: MemoryRepository): Promise<number> {
  const page = await repository.list({ status: "active", limit: 1 });
  return page.total;
}

async function readLongAgentSnapshot(chatHome: string, longAgentId: string): Promise<{
  readonly memoryFiles: number;
  readonly coreIndexRevision: string | null;
} | null> {
  const path = resolve(getChatHomePaths(chatHome).longAgentsRuntimeDir, longAgentId, "agent-group-snapshot.json");
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    const snapshot = isRecord(raw) ? raw.snapshot : raw;
    if (!isRecord(snapshot)) return null;
    const workspace = isRecord(snapshot.workspace) ? snapshot.workspace : {};
    const coreMemory = isRecord(snapshot.coreMemory) ? snapshot.coreMemory : {};
    const index = isRecord(coreMemory.index) ? coreMemory.index : {};
    return {
      memoryFiles: typeof workspace.memoryFileCount === "number" ? workspace.memoryFileCount : 0,
      coreIndexRevision: typeof index.revision === "string" ? index.revision : null,
    };
  } catch {
    return null;
  }
}

/** Memory 归属树总览：Chat 系统（个人）/ 各 Project / 各 Long Agent（OKF 快照）。 */
export default defineEventHandler(async () => {
  try {
    const home = await ensureChatHome();
    const personalRepository = new MemoryRepository(resolve(home.personalMemoryDir, "catalog.db"));
    const personal = { total: await activeTotal(personalRepository) };

    // 记忆只有三类：Chat（个人）/ Project（真实项目）/ Long Agent（OKF）。
    // Long Agent 的日常项目与共享空间不是用户项目，不能以“项目记忆”的形式重复出现。
    const registry = await readLongAgentRegistry(home.root);
    const longAgentIds = new Set(registry.agents.map((agent) => agent.id));
    const userProjects = (await listProjects(home.root)).filter(
      (project) => !isSystemLongAgentProjectId(project.projectId, longAgentIds),
    );

    const projects = await Promise.all(userProjects.map(async (project) => {
      const base = { projectId: project.projectId, name: project.cachedName, path: project.path, available: project.available };
      if (!project.available) return { ...base, total: 0 };
      try {
        const context = await resolveProjectContext(project.projectId, home.root);
        const repository = new MemoryRepository(resolve(context.memoryDir, "catalog.db"));
        return { ...base, total: await activeTotal(repository) };
      } catch {
        return { ...base, total: 0 };
      }
    }));

    const longAgents = await Promise.all(registry.agents.map(async (agent) => {
      const snapshot = await readLongAgentSnapshot(home.root, agent.id);
      return {
        longAgentId: agent.id,
        name: agent.name,
        memoryFiles: snapshot?.memoryFiles ?? 0,
        coreIndexRevision: snapshot?.coreIndexRevision ?? null,
      };
    }));

    return { schemaVersion: 1, personal, projects, longAgents };
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
