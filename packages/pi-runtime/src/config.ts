import { BAILIAN_DEFAULT_BASE_URL } from "@chat/contracts";

/**
 * 百炼Provider配置（任务书§14.1）。
 *
 * 安全规则：
 * - 凭据只检查存在性并在内存中使用；不打印、不持久化、不进入Trace或浏览器。
 * - Base URL必须是HTTPS且符合允许的百炼域名合同。
 * - 当前本地验收允许用户已经配置并授权的Coding Plan兼容Endpoint；Token Plan及
 *   非精确阿里云域名仍拒绝。Key类型由部署者保证，代码不尝试探测或打印。
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

const SHARED_BAILIAN_HOSTS: ReadonlySet<string> = new Set([
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "dashscope-us.aliyuncs.com",
  "coding.dashscope.aliyuncs.com",
]);

const WORKSPACE_BAILIAN_HOST =
  /^[a-z0-9][a-z0-9-]{0,62}\.(?:cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1)\.maas\.aliyuncs\.com$/u;

export function assertAllowedBailianHost(hostname: string): void {
  // 使用精确共享域名和锚定的业务空间正则，避免contains/宽泛后缀放过同形恶意Host。
  // Coding Endpoint是用户当前已配置并明确要求使用的真实Provider入口；Token Plan
  // 仍不在允许集合中，也不能通过Workspace正则混入。
  const allowed =
    !hostname.startsWith("token-plan.") &&
    (SHARED_BAILIAN_HOSTS.has(hostname) || WORKSPACE_BAILIAN_HOST.test(hostname));
  if (!allowed) {
    throw new BailianConfigError(`DASHSCOPE_BASE_URL域名不符合百炼合同:${hostname}`);
  }
}

export function loadBailianConfig(env: BailianEnv): BailianConfig {
  // CI、LaunchAgent与跨平台部署经常显式传空字符串表达“未配置”。它与缺少键
  // 语义相同；只有非空值才进入HTTPS/Host合同校验。
  const baseUrl = env.DASHSCOPE_BASE_URL?.trim() || BAILIAN_DEFAULT_BASE_URL;
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
