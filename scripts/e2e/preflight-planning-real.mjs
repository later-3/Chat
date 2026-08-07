import "../load-env.mjs";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 真实规划E2E前置门：必须显式配置付费百炼Key，且每次只清理固定的
 * 测试专用目录。绝不读取/打印Key，也不触碰正式.data/product。
 */
if (!process.env.DASHSCOPE_API_KEY?.trim()) {
  throw new Error(
    "缺少DASHSCOPE_API_KEY：请在仓库根.env配置百炼按量付费或业务空间Key后重跑 pnpm test:e2e:planning-execution:real（本门不Skip）",
  );
}

const repoRoot = process.env.CHAT_REPO_ROOT ?? process.cwd();
const testRoot = resolve(repoRoot, ".data/e2e/planning-execution-real");
const expected = resolve(repoRoot, ".data/e2e/planning-execution-real");
if (testRoot !== expected || !testRoot.endsWith("/.data/e2e/planning-execution-real")) {
  throw new Error("拒绝清理未通过精确校验的E2E目录");
}
rmSync(testRoot, { recursive: true, force: true });
console.log("[e2e-preflight] 真实百炼凭据已配置；测试专用数据目录已重置");
