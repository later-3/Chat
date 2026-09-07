import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import {
  LongAgentConfigurationInvalidError,
  LongAgentConfigurationNotFoundError,
  readLongAgentConfiguration,
} from "../../../../long-agents/configuration.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    return await readLongAgentConfiguration(longAgentId);
  } catch (error) {
    const statusCode = error instanceof LongAgentConfigurationInvalidError
      ? 400
      : error instanceof LongAgentConfigurationNotFoundError
        ? 404
        : 500;
    throw createError({
      statusCode,
      statusMessage: statusCode === 400
        ? "Long Agent ID无效"
        : statusCode === 404
          ? "找不到Long Agent"
          : "读取Long Agent配置失败",
    });
  }
});
