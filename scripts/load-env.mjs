// Chat安全环境加载（任务书§五）：读取仓库根目录.env。
// 规则：不覆盖已有环境变量；不打印任何变量名对应的值；.env缺失时静默
// （Provider not ready由配置检查明确报告，绝不切换假Provider）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.env.CHAT_REPO_ROOT ?? resolve(process.cwd());

try {
  const content = readFileSync(resolve(repoRoot, ".env"), "utf8");
  for (const line of content.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    if (key === undefined || process.env[key] !== undefined) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
} catch {
  // .env不存在或不可读：静默跳过；缺少凭据的组件各自失败关闭
}
