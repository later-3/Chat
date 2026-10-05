import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { listChatSessions } from "../../session-read-model.js";
import { listRemovedChatSessions } from "../../session-removal.js";
import { searchChatSessions, type SessionSearchScope } from "../../session-search.js";
import { SessionOwnerResolutionError } from "../../session-owner.js";

const SCOPES: readonly SessionSearchScope[] = ["project", "agent", "all"];

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw createError({ statusCode: 400, statusMessage: `${field}必须是字符串` });
  return value;
}

/** 浏览器读取active Session；底层磁盘枚举由session-files.ts统一复用Pi。 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const raw = getQuery(event);
  const projectId = optionalString(raw.projectId, "projectId");

  // 搜索：范围（当前项目 / 某 Long Agent 的全部项目 / 全部会话）+ 创建日期 + 关键词（含全文）。
  // 未提供任何搜索参数时保持原有列表语义，避免改变既有调用方。
  const searching = raw.query !== undefined || raw.scope !== undefined
    || raw.createdFrom !== undefined || raw.createdTo !== undefined || raw.includeRemoved !== undefined;
  if (searching) {
    const scope = optionalString(raw.scope, "scope");
    if (scope !== undefined && !SCOPES.includes(scope as SessionSearchScope)) {
      throw createError({ statusCode: 400, statusMessage: `scope必须是${SCOPES.join("或")}` });
    }
    const owner = optionalString(raw.owner, "owner");
    const keyword = optionalString(raw.query, "query");
    const createdFrom = optionalString(raw.createdFrom, "createdFrom");
    const createdTo = optionalString(raw.createdTo, "createdTo");
    const includeRemoved = raw.includeRemoved === undefined
      ? undefined
      : raw.includeRemoved === "1" || raw.includeRemoved === "true";
    return {
      sessions: await searchChatSessions({
        ...(scope === undefined ? {} : { scope: scope as SessionSearchScope }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(owner === undefined ? {} : { ownerLongAgentId: owner }),
        ...(keyword === undefined ? {} : { query: keyword }),
        ...(createdFrom === undefined ? {} : { createdFrom }),
        ...(createdTo === undefined ? {} : { createdTo }),
        ...(includeRemoved === undefined ? {} : { includeRemoved }),
      }),
      runningSessionIds: [],
    };
  }

  if (typeof projectId === "string") {
    await listRemovedChatSessions(projectId).catch((error: unknown) => {
      console.error(`清理Project ${projectId}过期Session失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  try {
    return { sessions: await listChatSessions(projectId), runningSessionIds: [] };
  } catch (error) {
    if (error instanceof SessionOwnerResolutionError) {
      throw createError({ statusCode: 500, statusMessage: error.message });
    }
    throw error;
  }
});
