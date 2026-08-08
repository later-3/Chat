/**
 * VS Code 本地 Compound 专用的 MemoryCore 配置。
 *
 * 这些值只授权绑定在 127.0.0.1:18970 的本轮固定源码进程，不是生产凭据。
 * 调试器强制覆盖同名环境变量，避免开发者的 `.env` 意外把断点调试指向远端服务，
 * 也保证 MemoryCore、Workflow 与 API 三个进程冻结到完全相同的隔离身份。
 * 本模块不打印配置；第三方 MemoryCore 子进程只获得 0600 配置文件路径，不继承父进程秘密。
 */

const repoRoot = resolve(
  process.env.CHAT_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
// Token按工作区确定性派生，使三个进程无需落盘即可得到同一个值；它只保护loopback服务，
// 不复用任何用户/生产凭据，也不会作为argv、日志或Trace输出。
const loopbackToken = `chat-debug-${createHash("sha256")
  .update("chat-memorycore-loopback-debug.v1\0")
  .update(repoRoot)
  .digest("hex")
  .slice(0, 32)}`;

const LOCAL_MEMORYCORE_DEBUG_ENV = Object.freeze({
  CHAT_TENCENT_MEMORYCORE_BASE_URL: "http://127.0.0.1:18970",
  CHAT_TENCENT_MEMORYCORE_TOKEN: loopbackToken,
  CHAT_TENCENT_MEMORYCORE_SERVICE_ID: "chat-local-debug-service",
  CHAT_TENCENT_MEMORYCORE_TEAM_ID: "chat-local-debug-team",
  CHAT_TENCENT_MEMORYCORE_USER_ID: "chat-local-debug-user",
  CHAT_TENCENT_MEMORYCORE_AGENT_ID: "chat-local-debug-agent",
  CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION: "fixed-3a9748d-local-debug",
  CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION: "loopback-debug-v1",
});

for (const [name, value] of Object.entries(LOCAL_MEMORYCORE_DEBUG_ENV)) {
  process.env[name] = value;
}
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
