import "../load-env.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * Chat本地Workflow运行专用的百炼Provider预加载。
 *
 * 已有环境或仓库.env始终优先。普通安装没有Provider凭据时仍可启动，由pi-runtime
 * 明确报告not ready；只有调用方同时显式给出pi reader与Provider配置路径时，才在
 * 当前本地Node进程中复用该配置。凭据不打印、不落盘、不作为子命令参数传递。
 */

const PI_PROVIDER_ID = "dashscope";

function configured(name) {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

const PI_KEY_READER = configured("CHAT_DEBUG_PI_KEY_READER");
const PI_PROVIDER_CONFIG = configured("CHAT_DEBUG_PI_PROVIDER_CONFIG");
const piFallbackConfigured = PI_KEY_READER !== undefined || PI_PROVIDER_CONFIG !== undefined;

if (piFallbackConfigured && (PI_KEY_READER === undefined || PI_PROVIDER_CONFIG === undefined)) {
  throw new Error(
    "本地pi Provider复用必须同时配置CHAT_DEBUG_PI_KEY_READER和CHAT_DEBUG_PI_PROVIDER_CONFIG",
  );
}

function requirePiConfig() {
  if (PI_PROVIDER_CONFIG === undefined || !existsSync(PI_PROVIDER_CONFIG)) {
    throw new Error("百炼配置缺失，且找不到本地 pi Provider 配置");
  }
}

function readPiKey() {
  if (PI_KEY_READER === undefined || !existsSync(PI_KEY_READER)) {
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
if (existingKey === undefined && piFallbackConfigured) {
  process.env.DASHSCOPE_API_KEY = readPiKey();
} else if (existingKey === undefined) {
  delete process.env.DASHSCOPE_API_KEY;
}

const existingBaseUrl = configured("DASHSCOPE_BASE_URL");
if (existingBaseUrl !== undefined) {
  process.env.DASHSCOPE_BASE_URL = validateBaseUrl(existingBaseUrl, "DASHSCOPE_BASE_URL ");
} else if (piFallbackConfigured) {
  process.env.DASHSCOPE_BASE_URL = readPiBaseUrl();
} else {
  delete process.env.DASHSCOPE_BASE_URL;
}
