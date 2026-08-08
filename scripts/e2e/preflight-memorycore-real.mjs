import "../load-env.mjs";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  FIXED_MEMORYCORE_COMMIT,
  FIXED_MEMORYCORE_PORT,
  ensureFixedMemoryCore,
} from "../memory/fixed-memorycore.mjs";
import { assertChatDataPath, chatRepoRoot } from "../memory/fixed-memmy.mjs";
import { findListenerPid, safeProcessName } from "../debug/lib.mjs";

if (!process.env.DASHSCOPE_API_KEY?.trim()) {
  throw new Error("缺少百炼凭据：真实MemoryCore闭环不Skip");
}
const repoRoot = chatRepoRoot();
ensureFixedMemoryCore(repoRoot);
const testRoot = assertChatDataPath(
  resolve(repoRoot, ".data/e2e/memorycore-real"),
  repoRoot,
  "MemoryCore真实E2E目录",
);
if (!testRoot.endsWith("/.data/e2e/memorycore-real")) {
  throw new Error("拒绝清理未通过精确后缀校验的MemoryCore E2E目录");
}
const occupiedPid = findListenerPid(FIXED_MEMORYCORE_PORT);
if (occupiedPid !== null) {
  throw new Error(
    `端口 ${FIXED_MEMORYCORE_PORT} 被未知进程占用（pid=${occupiedPid} 进程=${safeProcessName(occupiedPid)}）`,
  );
}
rmSync(testRoot, { recursive: true, force: true });
mkdirSync(testRoot, { recursive: true });
console.log(
  `[memorycore-e2e-preflight] 百炼凭据存在；MemoryCore ${FIXED_MEMORYCORE_COMMIT.slice(0, 12)}；测试目录已重置`,
);
