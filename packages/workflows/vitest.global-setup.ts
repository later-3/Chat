import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 集成测试前预构建workflow bundle（真实SWC转换与打包）。
 * manifest缺失或任何src源文件更新时才重建，避免拖慢确定性测试迭代。
 */
export default function setup(): void {
  const packageDir = dirname(fileURLToPath(import.meta.url));
  const bundleDir = process.env.CHAT_WORKFLOW_BUNDLE_DIR ?? join(packageDir, ".workflow-bundle");
  const manifestPath = join(bundleDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifestMtime = statSync(manifestPath).mtimeMs;
    const srcDir = join(packageDir, "src");
    const stale = readdirSync(srcDir)
      .filter((name) => name.endsWith(".ts"))
      .some((name) => statSync(join(srcDir, name)).mtimeMs > manifestMtime);
    if (!stale) return;
  }
  execFileSync("pnpm", ["--filter", "@chat/workflows", "build:bundles"], {
    cwd: join(packageDir, "..", ".."),
    stdio: "inherit",
  });
}
