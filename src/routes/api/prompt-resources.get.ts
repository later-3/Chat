import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import type { PromptResourceKind, PromptResourceStatus } from "../../prompt-resources/types.js";
import { listPromptResources } from "../../prompt-resources/store.js";
import {
  promptResourceHttpError,
  promptResourceTargetsFromQuery,
  queryString,
  requirePromptResourceProjectId,
} from "../../prompt-resources/http.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const query = getQuery(event);
    const currentProjectId = await requirePromptResourceProjectId(query);
    const text = queryString(query.q);
    const kind = queryString(query.kind);
    const status = queryString(query.status);
    if (kind !== undefined && kind !== "rule" && kind !== "experience") {
      throw new Error("kind必须是rule或experience");
    }
    if (status !== undefined && status !== "active" && status !== "archived" && status !== "all") {
      throw new Error("status必须是active、archived或all");
    }
    const tags = queryString(query.tags)?.split(",").map((tag) => tag.trim()).filter(Boolean);
    return {
      resources: await listPromptResources(
        promptResourceTargetsFromQuery(query, currentProjectId),
        {
          ...(text === undefined ? {} : { query: text }),
          ...(kind === undefined ? {} : { kind: kind as PromptResourceKind }),
          ...(status === undefined ? {} : { status: status as PromptResourceStatus | "all" }),
          ...(tags === undefined ? {} : { tags }),
        },
      ),
    };
  } catch (error) {
    throw createError(promptResourceHttpError(error));
  }
});
