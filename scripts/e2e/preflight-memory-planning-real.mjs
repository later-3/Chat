import "../load-env.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  FIXED_MEMMY_COMMIT,
  FIXED_MEMMY_PORT,
  FIXED_MEMMY_SOURCE_REPO,
  FIXED_MEMMY_TREE,
  assertChatDataPath,
  chatRepoRoot,
} from "../memory/fixed-memmy.mjs";
import { findListenerPid, safeProcessName } from "../debug/lib.mjs";

if (!process.env.DASHSCOPE_API_KEY?.trim()) {
  throw new Error("缺少百炼凭据：真实 Memory 闭环不 Skip；请复用 pi 配置或仓库根 .env 后重跑");
}

const repoRoot = chatRepoRoot();
const testRoot = assertChatDataPath(
  resolve(repoRoot, ".data/e2e/memory-planning-real"),
  repoRoot,
  "memory planning E2E root",
);
if (!testRoot.endsWith("/.data/e2e/memory-planning-real")) {
  throw new Error("拒绝清理未通过精确后缀校验的 Memory E2E 目录");
}

const commit = execFileSync(
  "git",
  ["-C", FIXED_MEMMY_SOURCE_REPO, "rev-parse", `${FIXED_MEMMY_COMMIT}^{commit}`],
  { encoding: "utf8" },
).trim();
const tree = execFileSync(
  "git",
  ["-C", FIXED_MEMMY_SOURCE_REPO, "rev-parse", `${FIXED_MEMMY_COMMIT}^{tree}`],
  { encoding: "utf8" },
).trim();
if (commit !== FIXED_MEMMY_COMMIT || tree !== FIXED_MEMMY_TREE) {
  throw new Error("本地 memmy Git object 不符合任务书固定提交/Tree");
}

const occupiedPid = findListenerPid(FIXED_MEMMY_PORT);
if (occupiedPid !== null) {
  throw new Error(
    `端口 ${FIXED_MEMMY_PORT} 被未知进程占用（pid=${occupiedPid} 进程=${safeProcessName(occupiedPid)}）；拒绝终止，请手动确认`,
  );
}

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(testRoot, { recursive: true });
console.log(
  `[memory-e2e-preflight] 凭据存在；memmy ${FIXED_MEMMY_COMMIT.slice(0, 12)} 证据有效；测试 DB 目录已物理重置`,
);
