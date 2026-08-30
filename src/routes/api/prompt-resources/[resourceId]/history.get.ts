import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { addressPromptResourceRevision, getPromptResourceStore } from "../../../../prompt-resources/store.js";
import {
  promptResourceHttpError,
  promptResourceTargetsFromQuery,
  requirePromptResourceProjectId,
} from "../../../../prompt-resources/http.js";

export default defineEventHandler(async (event) => {
  const resourceId = getRouterParam(event, "resourceId");
  if (!resourceId) throw createError({ statusCode: 400, statusMessage: "缺少resourceId" });
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const query = getQuery(event);
    const currentProjectId = await requirePromptResourceProjectId(query);
    const [target] = promptResourceTargetsFromQuery(query, currentProjectId, true);
    if (target === undefined) throw new Error("缺少Prompt资源Target");
    return {
      revisions: (await (await getPromptResourceStore(target)).history(resourceId))
        .map((revision) => addressPromptResourceRevision(target, revision)),
    };
  } catch (error) {
    throw createError(promptResourceHttpError(error));
  }
});
