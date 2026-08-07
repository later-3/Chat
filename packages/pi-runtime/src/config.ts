import { BAILIAN_DEFAULT_BASE_URL } from "@chat/contracts";

/**
 * 百炼Provider配置（任务书§14.1）。
 *
 * 安全规则：
 * - 凭据只检查存在性并在内存中使用；不打印、不持久化、不进入Trace或浏览器。
 * - Base URL必须是HTTPS且符合允许的百炼域名合同。
 * - Token Plan/Coding Plan Key和Endpoint禁止用于后端服务（域名合同拒绝
 *   已知Token Plan域名；Key类型由部署者保证，代码不尝试探测）。
 * - 缺少Key时明确报告not ready，绝不切换为假Provider。
 */

export class BailianConfigError extends Error {
  readonly code = "bailian_config_invalid";
  constructor(message: string) {
    super(message);
    this.name = "BailianConfigError";
  }
}

export interface BailianConfig {
  /** 只在内存中使用；永远不要输出。 */
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly endpointHost: string;
}

export interface BailianEnv {
  readonly DASHSCOPE_API_KEY?: string | undefined;
  readonly DASHSCOPE_BASE_URL?: string | undefined;
}

function assertAllowedBailianHost(hostname: string): void {
  const allowed =
    hostname === "dashscope.aliyuncs.com" ||
    (hostname.endsWith(".aliyuncs.com") && hostname.includes("dashscope"));
  if (!allowed) {
    throw new BailianConfigError(`DASHSCOPE_BASE_URL域名不符合百炼合同:${hostname}`);
  }
}

export function loadBailianConfig(env: BailianEnv): BailianConfig {
  const baseUrl = env.DASHSCOPE_BASE_URL ?? BAILIAN_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BailianConfigError("DASHSCOPE_BASE_URL不是合法URL");
  }
  if (url.protocol !== "https:") {
    throw new BailianConfigError("DASHSCOPE_BASE_URL必须使用HTTPS");
  }
  assertAllowedBailianHost(url.hostname);
  const apiKey =
    env.DASHSCOPE_API_KEY !== undefined && env.DASHSCOPE_API_KEY.trim() !== ""
      ? env.DASHSCOPE_API_KEY
      : undefined;
  return { apiKey, baseUrl, endpointHost: url.hostname };
}

export function isBailianReady(config: BailianConfig): boolean {
  return config.apiKey !== undefined;
}
