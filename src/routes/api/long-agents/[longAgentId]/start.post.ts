import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { ensureProjectLongAgent } from "../../../../long-agents/project-agent.js";
import { readLongAgentRegistry } from "../../../../long-agents/storage.js";
import {
  LEGACY_DAILY_PROJECT_ID,
  LONG_AGENT_SHARE_PROJECT_ID,
} from "../../../../projects/registry.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少longAgentId" });
  const body = await readBody<unknown>(event);
  if (!isRecord(body) || typeof body.projectId !== "string" || body.projectId.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "projectId必须是非空字符串" });
  }
  try {
    const registry = await readLongAgentRegistry();
    const agent = registry.agents.find((candidate) => candidate.enabled && candidate.id === longAgentId);
    if (agent === undefined) throw new Error(`找不到可用LongAgent: ${longAgentId}`);
    // Agent 的家是它自己的 Daily Project；从共享 daily 入口打开时归属到它的家，
    // 否则会落到迁移前的旧共享会话，看不到通道里的当前对话。
    const fromSystemContainer = body.projectId === LEGACY_DAILY_PROJECT_ID
      || body.projectId === LONG_AGENT_SHARE_PROJECT_ID;
    const projectId = fromSystemContainer && agent.defaultProjectId !== body.projectId
      ? agent.defaultProjectId
      : body.projectId;
    const result = await ensureProjectLongAgent({
      chatHome: resolveChatHome(),
      projectId,
      agent,
    });
    return {
      projectLongAgentId: result.projectAgent.id,
      projectId: result.projectAgent.projectId,
      longAgentId: result.projectAgent.longAgentId,
      primarySessionId: result.projectAgent.primarySessionId,
      status: result.projectAgent.status,
      isNewSession: result.isNewSession,
    };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
