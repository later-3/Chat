import { defineEventHandler, getQuery } from "nitro/h3";
import { readChatRootConfig, resolveChatConfig } from "../../chat-config.js";

/** Returns the single runtime config stored at .chat/config.json. */
export default defineEventHandler(async (event) => {
  const projectId = getQuery(event).projectId;
  if (typeof projectId !== "string" || projectId.trim() === "") return readChatRootConfig();
  const resolved = await resolveChatConfig(projectId);
  return {
    ...resolved.effective,
    layers: {
      personal: resolved.personal,
      project: resolved.project,
      projectTrusted: resolved.projectTrusted,
    },
  };
});
