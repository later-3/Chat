import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { appendChatAuditEvent } from "../../../../audit-log.js";
import {
  requestNanoClawTasks,
  type NanoClawTaskOperation,
} from "../../../../long-agents/nanoclaw-client.js";
import { readLongAgentRegistry } from "../../../../long-agents/storage.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Task management for one Long Agent (create/update/pause/resume/delete/run).
 * Bound to that Agent's own NanoClaw Agent Group; every write is audited.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const registry = await readLongAgentRegistry();
    const agent = registry.agents.find((candidate) => candidate.id === longAgentId);
    if (agent === undefined) throw createError({ statusCode: 404, statusMessage: "找不到Long Agent" });
    const instance = registry.instances.find((candidate) => candidate.id === agent.instanceId);
    if (instance === undefined) throw createError({ statusCode: 400, statusMessage: `找不到NanoClaw实例: ${agent.instanceId}` });

    const body = await readBody<unknown>(event);
    if (!isRecord(body)) throw createError({ statusCode: 400, statusMessage: "请求体必须是对象" });
    const operation = body.operation;
    if (typeof operation !== "string") throw createError({ statusCode: 400, statusMessage: "必须提供operation" });
    const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
    const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
    const recurrence = body.recurrence === null ? null : typeof body.recurrence === "string" ? body.recurrence : undefined;
    const processAfter = typeof body.processAfter === "string" ? body.processAfter : undefined;
    const name = typeof body.name === "string" ? body.name : undefined;
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;

    const request: NanoClawTaskOperation = operation === "create"
      ? {
          operation: "create",
          prompt: prompt ?? "",
          ...(name === undefined || name === "" ? {} : { name }),
          ...(recurrence === undefined ? {} : { recurrence }),
          ...(processAfter === undefined ? {} : { processAfter }),
          ...(body.paused === true ? { paused: true } : {}),
        }
      : operation === "update"
        ? {
            operation: "update",
            taskId: taskId ?? "",
            ...(prompt === undefined ? {} : { prompt }),
            ...(recurrence === undefined ? {} : { recurrence }),
            ...(processAfter === undefined ? {} : { processAfter }),
          }
        : { operation: operation as "pause" | "resume" | "delete" | "run", taskId: taskId ?? "" };

    if (operation === "create" && (prompt === undefined || prompt.trim() === "")) {
      throw createError({ statusCode: 400, statusMessage: "创建任务必须提供prompt" });
    }
    if (operation !== "create" && (taskId === undefined || taskId === "")) {
      throw createError({ statusCode: 400, statusMessage: `${operation}必须提供taskId` });
    }

    const response = await requestNanoClawTasks({ instance, agentGroupId: agent.nanoclawAgentGroupId, operation: request });
    await appendChatAuditEvent({
      action: `long-agent.task.${operation}`,
      target: { type: "long-agent", longAgentId: agent.id },
      details: { taskId: taskId ?? null, createdTaskId: response.task?.id ?? null, recurrence: recurrence ?? null, source: "web", reason },
    });
    return { schemaVersion: 1, ...response, ...(operation === "list" ? { tasks: response.tasks ?? [] } : {}) };
  } catch (error) {
    if (error !== null && typeof error === "object" && "statusCode" in error) throw error;
    throw createError({ statusCode: 502, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
