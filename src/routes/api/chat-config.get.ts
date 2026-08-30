import { defineEventHandler } from "nitro/h3";
import { readChatRootConfig } from "../../chat-config.js";

/** Returns the single runtime config stored at .chat/config.json. */
export default defineEventHandler(() => readChatRootConfig());
