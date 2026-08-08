import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export default function setup() {
  const repoRoot = resolve(process.cwd(), "../..");
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts/memory/seed-memory-planning-real.mjs")],
    {
      cwd: repoRoot,
      env: { ...process.env, CHAT_REPO_ROOT: repoRoot },
      stdio: "inherit",
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`真实 memmy 种子与检索门失败（exit=${String(result.status)}）`);
  }
}
