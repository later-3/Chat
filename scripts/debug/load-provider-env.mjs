import "../load-env.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * VS Code Workflow调试专用的百炼Provider预加载。
 *
 * 已有环境或仓库.env始终优先；只有缺失时，才在当前本地Node进程中调用用户已有的
 * pi reader并读取其dashscope配置。凭据不打印、不落盘、不作为子命令参数传递。
 */

const PI_KEY_READER =
  process.env.CHAT_DEBUG_PI_KEY_READER ?? "/Users/xulater/.pi/agent/read-chat-provider-key.mjs";
const PI_PROVIDER_CONFIG =
  process.env.CHAT_DEBUG_PI_PROVIDER_CONFIG ?? "/Users/xulater/Code/Chat/backend/config.json";
const PI_PROVIDER_ID = "dashscope";

function configured(name) {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requirePiConfig() {
  if (!existsSync(PI_PROVIDER_CONFIG)) {
    throw new Error("百炼配置缺失，且找不到本地 pi Provider 配置");
  }
}

function readPiKey() {
  if (!existsSync(PI_KEY_READER)) {
    throw new Error("百炼凭据缺失，且找不到本地 pi Key reader");
  }
  requirePiConfig();
  const key = execFileSync(process.execPath, [PI_KEY_READER, PI_PROVIDER_CONFIG, PI_PROVIDER_ID], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (key === "") throw new Error("本地 pi Key reader 未返回百炼凭据");
  return key;
}

function isAllowedBailianHost(hostname) {
  return hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".dashscope.aliyuncs.com");
}

function validateBaseUrl(value, source) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${source}百炼 Base URL 无效`);
  }
  if (url.protocol !== "https:" || !isAllowedBailianHost(url.hostname)) {
    throw new Error(`${source}百炼 Base URL 必须是允许域名的 HTTPS 地址`);
  }
  return url.toString().replace(/\/+$/u, "");
}

function readPiBaseUrl() {
  requirePiConfig();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(PI_PROVIDER_CONFIG, "utf8"));
  } catch {
    throw new Error("本地 pi Provider 配置无效");
  }
  const provider = Array.isArray(parsed?.providers)
    ? parsed.providers.find((entry) => entry?.id === PI_PROVIDER_ID)
    : undefined;
  const baseUrl = typeof provider?.base_url === "string" ? provider.base_url.trim() : "";
  if (baseUrl === "") throw new Error("本地 pi Provider 未配置百炼 Base URL");
  return validateBaseUrl(baseUrl, "本地 pi Provider ");
}

const existingKey = configured("DASHSCOPE_API_KEY");
if (existingKey === undefined) process.env.DASHSCOPE_API_KEY = readPiKey();

const existingBaseUrl = configured("DASHSCOPE_BASE_URL");
process.env.DASHSCOPE_BASE_URL =
  existingBaseUrl === undefined
    ? readPiBaseUrl()
    : validateBaseUrl(existingBaseUrl, "DASHSCOPE_BASE_URL ");
