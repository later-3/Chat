import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { addressPromptResourceRevision, getPromptResourceStore } from "../../../prompt-resources/store.js";
import {
  promptResourceHttpError,
  promptResourceTargetsFromQuery,
  requirePromptResourceProjectId,
} from "../../../prompt-resources/http.js";

export default defineEventHandler(async (event) => {
  const resourceId = getRouterParam(event, "resourceId");
  if (!resourceId) throw createError({ statusCode: 400, statusMessage: "缺少resourceId" });
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const query = getQuery(event);
    const currentProjectId = await requirePromptResourceProjectId(query);
    const [target] = promptResourceTargetsFromQuery(query, currentProjectId, true);
    if (target === undefined) throw new Error("缺少Prompt资源Target");
    const resource = await (await getPromptResourceStore(target)).get(resourceId);
    if (resource === undefined) throw new Error(`找不到Prompt资源: ${resourceId}`);
    return { resource: addressPromptResourceRevision(target, resource) };
  } catch (error) {
    throw createError(promptResourceHttpError(error));
  }
});
