import "../load-env.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());
const variant = process.argv[2] ?? "planning";
const variants = {
  planning: {
    preflight: "preflight-memory-planning-real.mjs",
    config: "playwright.memory-real.config.ts",
  },
  import: {
    preflight: "preflight-memory-planning-real.mjs",
    config: "playwright.memory-import-real.config.ts",
  },
};
const selected = variants[variant];
if (selected === undefined) throw new Error("真实Memory E2E仅支持planning/import");

/**
 * 已有环境/.env 优先；否则通过用户已有 pi Key reader 获取百炼 Key。
 * 值只存在于本进程与子进程环境，绝不输出、写文件或进入命令行参数。
 */
function resolveBailianKey() {
  const configured = process.env.DASHSCOPE_API_KEY?.trim();
  if (configured) return configured;
  const reader = "/Users/xulater/.pi/agent/read-chat-provider-key.mjs";
  const providerConfig = "/Users/xulater/Code/Chat/backend/config.json";
  if (!existsSync(reader) || !existsSync(providerConfig)) {
    throw new Error("百炼凭据不存在，且无法找到已批准的 pi Key reader/config");
  }
  const value = execFileSync(process.execPath, [reader, providerConfig, "dashscope"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!value) throw new Error("pi Key reader 未返回百炼凭据");
  return value;
}

function resolveBailianBaseUrl() {
  const configured = process.env.DASHSCOPE_BASE_URL?.trim();
  if (configured) return configured;
  const providerConfig = "/Users/xulater/Code/Chat/backend/config.json";
  if (!existsSync(providerConfig)) {
    throw new Error("DASHSCOPE_BASE_URL 未配置，且无法读取既有 pi Provider 配置");
  }
  const parsed = JSON.parse(readFileSync(providerConfig, "utf8"));
  const provider = Array.isArray(parsed?.providers)
    ? parsed.providers.find((entry) => entry?.id === "dashscope")
    : undefined;
  const value = typeof provider?.base_url === "string" ? provider.base_url.trim() : "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("既有 pi 百炼 Provider base URL 无效");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith("dashscope.aliyuncs.com")) {
    throw new Error("既有 pi 百炼 Provider base URL 不在允许的百炼 HTTPS 域名");
  }
  return url.toString().replace(/\/+$/u, "");
}

const secretEnvironmentName =
  /(?:TOKEN|API_?KEY|SECRET|PASSWORD|CREDENTIAL|PROVIDER|(?:^|_)KEY(?:_|$)|AUTH)/u;
const preparationEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !secretEnvironmentName.test(name.toUpperCase())),
);
preparationEnv.CHAT_REPO_ROOT = repoRoot;

function run(command, args, env) {
  if (env === undefined) throw new Error("E2E 子进程必须显式指定环境边界");
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["scripts/memory/prepare-fixed-memmy.mjs"], preparationEnv);
const providerEnv = {
  ...process.env,
  CHAT_REPO_ROOT: repoRoot,
  DASHSCOPE_API_KEY: resolveBailianKey(),
  DASHSCOPE_BASE_URL: resolveBailianBaseUrl(),
};
run("pnpm", ["debug:preclean"], providerEnv);
run(process.execPath, ["scripts/e2e/preflight-memory-planning-real.mjs", variant], providerEnv);
run("pnpm", ["--filter", "@chat/workflows", "build:bundles"], providerEnv);
run(process.execPath, ["scripts/e2e/assert-clean-runtime-evidence.mjs"], providerEnv);
run(
  "pnpm",
  ["--filter", "@chat/web", "exec", "playwright", "test", "--config", selected.config],
  providerEnv,
);
