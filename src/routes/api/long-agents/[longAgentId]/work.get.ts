import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { listFriendWork } from "../../../../long-agents/work.js";
import { readTaskState } from "../../../../long-agents/tasks/storage.js";
export default defineEventHandler(async event => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const id = getRouterParam(event, "longAgentId");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少Friend ID" });
  const home = resolveChatHome();
  const result = await listFriendWork(home, id);
  const tasks = await readTaskState(home, id);
  return { ...result, works: result.works.map(item => {
    const occurrence = tasks.occurrences.find(occurrence => occurrence.id === item.work.requestId);
    const definition = occurrence?.definition;
    const displayTitle = definition?.legacyId && definition.name === definition.legacyId
      ? definition.prompt.trim().replace(/\s+/g, " ").slice(0, 100)
      : item.work.title;
    return { ...item, displayTitle };
  }) };
});
