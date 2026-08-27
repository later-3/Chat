// Chat安全环境加载：默认读取仓库外~/.config/chat/runtime.env，旧安装才回退仓库.env。
// 规则：只读当前用户拥有且group/world不可访问的普通文件；不覆盖既有环境、不打印值；
// 配置缺失时静默（Provider not ready由各组件明确报告，绝不切换假Provider）。
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot =
  process.env.CHAT_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

const runtimeRole = process.env.CHAT_RUNTIME_ROLE ?? "unscoped";
const configuredEnvFile = process.env.CHAT_ENV_FILE?.trim();
function canonicalPrivatePath(value, key) {
  if (!isAbsolute(value)) throw new Error(`${key}必须是绝对路径`);
  const normalized = resolve(value);
  if (normalized !== value) throw new Error(`${key}必须是不含.或..的规范绝对路径`);
  let existing = normalized;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (existsSync(existing) && realpathSync(existing) !== existing) {
    throw new Error(`${key}的现有父链不能包含symlink`);
  }
  return normalized;
}
const canonicalConfiguredEnvFile =
  configuredEnvFile === undefined || configuredEnvFile === ""
    ? undefined
    : canonicalPrivatePath(configuredEnvFile, "CHAT_ENV_FILE");
const candidates =
  canonicalConfiguredEnvFile === undefined
    ? [resolve(homedir(), ".config/chat/runtime.env"), resolve(repoRoot, ".env")]
    : [canonicalConfiguredEnvFile];

for (const candidate of candidates) {
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    if (runtimeRole !== "api" && (error?.code === "EACCES" || error?.code === "EPERM")) {
      // 统一启动器已把非秘密配置放入过滤环境；进程沙箱拒绝原文件正是成功证据。
      continue;
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Chat运行配置必须是非symlink普通文件:${candidate}`);
  }
  if (realpathSync(dirname(candidate)) !== dirname(candidate)) {
    throw new Error(`Chat运行配置父链不能包含symlink:${candidate}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Chat运行配置必须由当前用户拥有:${candidate}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Chat运行配置权限必须禁止group/world访问:${candidate}`);
  }

  const content = readFileSync(candidate, "utf8");
  const entries = content.split("\n").flatMap((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null || match[1] === undefined) return [];
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return [{ key: match[1], value }];
  });
  for (const { key, value: parsedValue } of entries) {
    if (process.env[key] !== undefined) continue;
    let value = parsedValue;
    if (
      value !== "" &&
      new Set([
        "CHAT_RUNTIME_CREDENTIAL_PATH",
        "CHAT_PRODUCT_STORE_PATH",
        "CHAT_WORKFLOW_DATA_DIR",
        "CHAT_RUNTIME_BINDINGS_PATH",
        "CHAT_TRACE_DIR",
        "CHAT_RUN_ACTIVITY_DIR",
        "CHAT_DSH_STATE_PATH",
        "CHAT_DSH_HOME",
        "CHAT_CODE_WORKBENCH_RUN_ROOT",
        "CHAT_DEBUG_DIR",
        "CHAT_PI_EXECUTOR_DATA_DIR",
        "CHAT_WORKFLOW_BUNDLE_DIR",
        "CHAT_WEB_AUTH_CREDENTIALS_FILE",
        "CHAT_WEB_AUTH_SESSION_SECRET_FILE",
      ]).has(key)
    ) {
      value = canonicalPrivatePath(value, key);
    }
    process.env[key] = value;
  }
  break;
}
