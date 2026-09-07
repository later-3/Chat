import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import {
  LongAgentResourceInvalidError,
  listLongAgentMemory,
  readLongAgentMemory,
  searchLongAgentMemory,
} from "../../../../long-agents/agent-group-service.js";
import { projectLongAgentResourceError } from "../../../../long-agents/http-error.js";

function rejectUnknownQuery(query: Record<string, unknown>, allowed: readonly string[]): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(query).filter((field) => !fields.has(field));
  if (unknown.length > 0) throw new LongAgentResourceInvalidError(`Agent Memory查询包含未知字段: ${unknown.join(", ")}`);
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  const query = getQuery(event);
  try {
    const operation = query.operation ?? "list";
    if (operation === "list") {
      rejectUnknownQuery(query, ["operation"]);
      return await listLongAgentMemory(longAgentId);
    }
    if (operation === "read") {
      rejectUnknownQuery(query, ["operation", "path"]);
      return await readLongAgentMemory(longAgentId, query.path);
    }
    if (operation === "search") {
      rejectUnknownQuery(query, ["operation", "query", "limit"]);
      return await searchLongAgentMemory(longAgentId, query.query, query.limit);
    }
    throw new LongAgentResourceInvalidError("operation必须是list、read或search");
  } catch (error) {
    throw createError(projectLongAgentResourceError(error, "读取Agent Memory"));
  }
});
