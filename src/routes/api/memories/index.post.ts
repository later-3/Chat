import { defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { memoryHttpError, parseCreateMemoryBody, parseMemoryTargetsBody } from "../../../memory/http.js";
import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<unknown>(event);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("request body must be an object");
    const targets = parseMemoryTargetsBody(body as Record<string, unknown>);
    const { scope: _scope, projectId: _projectId, ...input } = parseCreateMemoryBody(body);
    const manager = getMemoryStoreManager();
    setResponseStatus(event, 201);
    const onlyTarget = targets.length === 1 ? targets[0] : undefined;
    if (onlyTarget !== undefined) return { memory: await manager.createOne(onlyTarget, input) };
    return { results: await manager.createMany(targets, input) };
  } catch (error) {
    return memoryHttpError(error);
  }
});
