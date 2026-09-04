import { defineEventHandler, getRequestURL } from "nitro/h3";
import { ensureChatHome } from "../../chat-home.js";
import { loadDeviceDirectory } from "../../device-directory.js";

export default defineEventHandler(async (event) => {
  const requestOrigin = getRequestURL(event, {
    xForwardedHost: true,
    xForwardedProto: true,
  }).origin;
  const publicUrl = process.env.CHAT_PUBLIC_URL?.trim() || requestOrigin;
  const home = await ensureChatHome();
  return loadDeviceDirectory(home.devicesConfigPath, publicUrl, requestOrigin);
});
