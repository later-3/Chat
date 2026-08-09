import "../load-env.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());

/** 复用用户已批准的pi百炼配置；密钥只进入子进程环境，不写文件、不输出。 */
function resolveBailianKey() {
  const configured = process.env.DASHSCOPE_API_KEY?.trim();
  if (configured) return configured;
  const reader = "/Users/xulater/.pi/agent/read-chat-provider-key.mjs";
  const providerConfig = "/Users/xulater/Code/Chat/backend/config.json";
  if (!existsSync(reader) || !existsSync(providerConfig)) {
    throw new Error("百炼凭据不存在，且无法找到已批准的pi Key reader/config");
  }
  const value = execFileSync(process.execPath, [reader, providerConfig, "dashscope"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!value) throw new Error("pi Key reader未返回百炼凭据");
  return value;
}

function resolveBailianBaseUrl() {
  const configured = process.env.DASHSCOPE_BASE_URL?.trim();
  if (configured) return configured;
  const providerConfig = "/Users/xulater/Code/Chat/backend/config.json";
  const parsed = JSON.parse(readFileSync(providerConfig, "utf8"));
  const provider = Array.isArray(parsed?.providers)
    ? parsed.providers.find((entry) => entry?.id === "dashscope")
    : undefined;
  const value = typeof provider?.base_url === "string" ? provider.base_url.trim() : "";
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith("dashscope.aliyuncs.com")) {
    throw new Error("既有pi百炼Provider base URL不在允许的HTTPS域名");
  }
  return url.toString().replace(/\/+$/u, "");
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const providerEnv = {
  ...process.env,
  CHAT_REPO_ROOT: repoRoot,
  DASHSCOPE_API_KEY: resolveBailianKey(),
  DASHSCOPE_BASE_URL: resolveBailianBaseUrl(),
};
run("pnpm", ["debug:preclean"], providerEnv);
run(process.execPath, ["scripts/e2e/preflight-project-intake-real.mjs"], providerEnv);
run("pnpm", ["--filter", "@chat/workflows", "build:bundles"], providerEnv);
run(process.execPath, ["scripts/e2e/assert-clean-runtime-evidence.mjs"], providerEnv);
run(
  "pnpm",
  [
    "--filter",
    "@chat/web",
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.project-intake-real.config.ts",
  ],
  providerEnv,
);
