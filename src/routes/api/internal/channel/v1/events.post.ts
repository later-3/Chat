import {
  createError,
  defineEventHandler,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import {
  acceptLongAgentEvents,
  LongAgentEventConflictError,
} from "../../../../../long-agents/bridge.js";
import { parseNanoClawIntegrationEvent } from "../../../../../long-agents/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (!isRecord(body)
    || body.schemaVersion !== 1
    || typeof body.instanceId !== "string"
    || body.instanceId.trim() === ""
    || !Array.isArray(body.events)
    || body.events.length === 0
    || body.events.length > 200) {
    throw createError({ statusCode: 400, statusMessage: "Channel事件请求无效" });
  }
  try {
    const result = await acceptLongAgentEvents({
      instanceId: body.instanceId,
      events: body.events.map(parseNanoClawIntegrationEvent),
    });
    setResponseStatus(event, 202);
    return result;
  } catch (error) {
    throw createError({
      statusCode: error instanceof LongAgentEventConflictError ? 409 : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
