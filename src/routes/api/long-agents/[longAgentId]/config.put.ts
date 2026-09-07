import { createError, defineEventHandler, getRouterParam, isError, readBody, setResponseHeader } from "nitro/h3";
import {
  LongAgentConfigurationConflictError,
  LongAgentConfigurationInvalidError,
  LongAgentConfigurationNotFoundError,
  updateLongAgentConfiguration,
} from "../../../../long-agents/configuration.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    return await updateLongAgentConfiguration(longAgentId, await readBody<unknown>(event));
  } catch (error) {
    const statusCode = error instanceof LongAgentConfigurationNotFoundError
      ? 404
      : error instanceof LongAgentConfigurationConflictError
        ? 409
        : error instanceof LongAgentConfigurationInvalidError || (isError(error) && error.statusCode === 400)
          ? 400
          : 500;
    throw createError({
      statusCode,
      statusMessage: statusCode === 400
        ? "Long Agent配置无效"
        : statusCode === 404
          ? "找不到Long Agent"
          : statusCode === 409
            ? "Long Agent配置已被其他操作更新，请重新加载后再保存"
            : "保存Long Agent配置失败",
    });
  }
});
