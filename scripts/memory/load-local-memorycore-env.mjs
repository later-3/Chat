import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_INSTANCE_NAMES, runtimePorts } from "../dev/runtime-instance.mjs";

/**
 * Chat受管本地Runtime专用的MemoryCore配置。
 *
 * 这些值只授权绑定在runtime-instance固定loopback端口的本轮固定源码进程，
 * 不是远程Provider凭据。本模块强制覆盖同名环境变量，保证MemoryCore、Workflow与API
 * 冻结到同一个隔离身份。
 * 本模块不打印配置；第三方MemoryCore子进程只获得0600配置文件路径，不继承父进程秘密。
 */

const repoRoot = resolve(
  process.env.CHAT_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const runtimeInstance = process.env.CHAT_RUNTIME_INSTANCE?.trim() || "production";
if (!RUNTIME_INSTANCE_NAMES.includes(runtimeInstance)) {
  throw new Error(`CHAT_RUNTIME_INSTANCE只支持 ${RUNTIME_INSTANCE_NAMES.join("、")}`);
}
const memoryCorePort = runtimePorts(runtimeInstance).memoryCore;

// Token按工作区和runtime instance确定性派生，三个进程无需落盘即可得到同一个值；
// production/debug不复用身份，也不复用任何用户/远程Provider凭据。
const loopbackToken = `chat-local-${createHash("sha256")
  .update("chat-memorycore-loopback-runtime.v1\0")
  .update(repoRoot)
  .update("\0")
  .update(runtimeInstance)
  .digest("hex")
  .slice(0, 32)}`;

const LOCAL_MEMORYCORE_ENV = Object.freeze({
  CHAT_TENCENT_MEMORYCORE_BASE_URL: `http://127.0.0.1:${String(memoryCorePort)}`,
  CHAT_TENCENT_MEMORYCORE_TOKEN: loopbackToken,
  CHAT_TENCENT_MEMORYCORE_SERVICE_ID: `chat-local-${runtimeInstance}-service`,
  CHAT_TENCENT_MEMORYCORE_TEAM_ID: `chat-local-${runtimeInstance}-team`,
  CHAT_TENCENT_MEMORYCORE_USER_ID: `chat-local-${runtimeInstance}-user`,
  CHAT_TENCENT_MEMORYCORE_AGENT_ID: `chat-local-${runtimeInstance}-agent`,
  CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION: `fixed-3a9748d-local-${runtimeInstance}`,
  CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION: `loopback-${runtimeInstance}-v1`,
});

for (const [name, value] of Object.entries(LOCAL_MEMORYCORE_ENV)) {
  process.env[name] = value;
}
