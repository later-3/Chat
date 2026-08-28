import { defineEventHandler, getRequestURL } from "nitro/h3";

/** 当前只运行一个Chat后端；多设备能力仍留在前端，但尚未接入。 */
export default defineEventHandler((event) => {
  const requestOrigin = getRequestURL(event, {
    xForwardedHost: true,
    xForwardedProto: true,
  }).origin;
  const publicUrl = process.env.CHAT_PUBLIC_URL?.trim() || requestOrigin;
  return {
    version: 1,
    currentDeviceId: "local",
    devices: [{ id: "local", name: "Chat", url: publicUrl }],
    diagnostics: [],
    selectionMode: "direct",
    gatewayUrl: null,
  };
});
