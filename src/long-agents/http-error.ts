import { NanoClawGatewayError, NanoClawGatewayUnavailableError } from "./nanoclaw-client.js";
import { LongAgentResourceInvalidError, LongAgentResourceNotFoundError } from "./agent-group-service.js";

export interface LongAgentHttpErrorProjection {
  readonly statusCode: number;
  readonly statusMessage: string;
}

export function projectFriendCreationError(error: unknown): LongAgentHttpErrorProjection {
  const retry = "创建输入已保留，修复后可重试。";
  if (error instanceof NanoClawGatewayUnavailableError) return { statusCode: 503,
    statusMessage: `无法连接Friend服务。请确认NanoClaw已启动、网关地址正确。${retry}` };
  if (error instanceof NanoClawGatewayError) {
    const reason = error.statusCode === 401 || error.statusCode === 403
      ? "Friend服务认证失败。请核对Backend与NanoClaw使用的服务凭据是否一致。"
      : error.statusCode === 404 ? "NanoClaw未提供Friend创建接口。请核对网关地址与Host版本。"
      : error.statusCode === 409 ? "Friend身份或NanoClaw实例配置冲突。请核对服务日志与实例配置。"
      : error.statusCode !== undefined && error.statusCode >= 500 ? "NanoClaw创建失败。请检查Host日志后重试。"
      : "NanoClaw响应与创建合同不兼容。请核对Backend与Host版本。";
    return { statusCode: 502, statusMessage: `${reason}${retry}` };
  }
  return { statusCode: 500, statusMessage: `创建Friend失败，请检查Backend日志。${retry}` };
}

export function projectLongAgentResourceError(error: unknown, action: string): LongAgentHttpErrorProjection {
  if (error instanceof LongAgentResourceInvalidError) return { statusCode: 400, statusMessage: error.message };
  if (error instanceof LongAgentResourceNotFoundError) return { statusCode: 404, statusMessage: "找不到Long Agent" };
  if (error instanceof NanoClawGatewayError) {
    if (error.statusCode === 400) return { statusCode: 400, statusMessage: `${action}请求无效` };
    if (error.statusCode === 404) return { statusCode: 404, statusMessage: `${action}对象不存在` };
    if (error.statusCode === 409) return { statusCode: 409, statusMessage: `${action}版本冲突，请重新加载` };
    return {
      statusCode: error.message.includes("超时") ? 504 : 502,
      statusMessage: `${action}时NanoClaw暂时不可用`,
    };
  }
  return { statusCode: 500, statusMessage: `${action}失败` };
}
