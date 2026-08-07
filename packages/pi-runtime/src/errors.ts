import type { ProblemCode } from "@chat/contracts";

/**
 * Provider错误归一化（任务书§12.5、§20.2）。
 *
 * pi/Provider原始异常与errorMessage不得穿透到产品层或浏览器；
 * 在Adapter边界映射为稳定错误族。匹配基于pi编码后的errorMessage特征，
 * 只用于分类，原始文本不进入Trace或响应。
 */

export type StableProviderErrorCode =
  | "provider.auth_failed"
  | "provider.rate_limited"
  | "provider.timeout"
  | "provider.stream_interrupted"
  | "provider.request_failed";

export function classifyProviderError(errorMessage: string): StableProviderErrorCode {
  const text = errorMessage.toLowerCase();
  if (/\b401\b|unauthorized|invalid api[- ]?key|authentication|forbidden|\b403\b/.test(text)) {
    return "provider.auth_failed";
  }
  if (/\b429\b|rate.?limit|throttl|too many requests|quota/.test(text)) {
    return "provider.rate_limited";
  }
  if (/timeout|timed out|deadline|etimedout/.test(text)) {
    return "provider.timeout";
  }
  if (/abort|interrupt|truncat|stream|econn|socket|network|fetch failed|terminated/.test(text)) {
    return "provider.stream_interrupted";
  }
  return "provider.request_failed";
}

export function providerProblemCode(code: StableProviderErrorCode): ProblemCode {
  switch (code) {
    case "provider.auth_failed":
      return "provider_auth_failed";
    case "provider.rate_limited":
      return "provider_rate_limited";
    case "provider.timeout":
      return "provider_timeout";
    case "provider.stream_interrupted":
      return "provider_stream_interrupted";
    case "provider.request_failed":
      return "internal_error";
  }
}
