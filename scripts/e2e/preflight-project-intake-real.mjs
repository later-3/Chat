import "../load-env.mjs";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

if (!process.env.DASHSCOPE_API_KEY?.trim()) {
  throw new Error("缺少真实Project Model Profile凭据，本完成门不Skip");
}
const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());
const testRoot = resolve(repoRoot, ".data/e2e/project-intake-real");
const expected = resolve(repoRoot, ".data/e2e/project-intake-real");
if (testRoot !== expected || !testRoot.endsWith("/.data/e2e/project-intake-real")) {
  throw new Error("拒绝清理未通过精确校验的Project E2E目录");
}
rmSync(testRoot, { recursive: true, force: true });
console.log("[e2e-preflight] Project真实模型、真实Git资源与测试目录已确认");
