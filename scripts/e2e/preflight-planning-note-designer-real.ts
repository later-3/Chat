import "../load-env.mjs";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBailianReady, loadBailianConfig } from "../../packages/pi-runtime/src/config.js";

/**
 * Planning + Note + Designer真实浏览器组合门。Provider配置先经过pi-runtime同一安全
 * allowlist；Coding/Token Plan在清理目录、启动服务或产生付费调用前即失败关闭。
 */
const config = loadBailianConfig(process.env);
if (!isBailianReady(config)) {
  throw new Error("缺少DASHSCOPE_API_KEY：组合E2E不使用fake Provider，也不会Skip");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testRoot = resolve(repoRoot, ".data/e2e/planning-note-designer-real");
const expected = resolve(repoRoot, ".data/e2e/planning-note-designer-real");
if (testRoot !== expected || !testRoot.endsWith("/.data/e2e/planning-note-designer-real")) {
  throw new Error("拒绝清理未通过精确校验的组合E2E目录");
}
rmSync(testRoot, { recursive: true, force: true });
console.log(`[e2e-preflight] 正式百炼endpoint已通过安全门:${config.endpointHost}`);
