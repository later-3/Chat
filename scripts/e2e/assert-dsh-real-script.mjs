import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const manifestPath = resolve(repoRoot, "apps/dsh-web/package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const script = manifest?.scripts?.["test:e2e:real"];

// pnpm --filter在目标包没有脚本时会返回0；根完成门必须先显式拒绝这种假绿，
// 而且要在preclean之前拒绝，避免配置错误时无意义地停止现有开发服务。
if (typeof script !== "string" || script.trim() === "") {
  throw new Error("@chat/dsh-web缺少test:e2e:real脚本，拒绝把真实浏览器完成门报告为通过");
}

console.log("[e2e-preflight] @chat/dsh-web test:e2e:real入口存在");
