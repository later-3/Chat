import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { listPromptResourceDrafts } from "../../../prompt-resources/store.js";
import {
  promptResourceHttpError,
  promptResourceTargetsFromQuery,
  requirePromptResourceProjectId,
} from "../../../prompt-resources/http.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const query = getQuery(event);
    const currentProjectId = await requirePromptResourceProjectId(query);
    return { drafts: await listPromptResourceDrafts(promptResourceTargetsFromQuery(query, currentProjectId)) };
  } catch (error) {
    throw createError(promptResourceHttpError(error));
  }
});
