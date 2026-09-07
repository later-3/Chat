import { NanoClawGatewayError } from "./nanoclaw-client.js";
import { LongAgentResourceInvalidError, LongAgentResourceNotFoundError } from "./agent-group-service.js";

export interface LongAgentHttpErrorProjection {
  readonly statusCode: number;
  readonly statusMessage: string;
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
