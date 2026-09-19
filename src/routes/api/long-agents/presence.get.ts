import { defineEventHandler, setResponseHeader } from "nitro/h3";
import { readLongAgentPresence } from "../../../long-agents/presence.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  return readLongAgentPresence();
});
