import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export default function setup() {
  const repoRoot = resolve(process.cwd(), "../..");
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@chat/api",
      "exec",
      "tsx",
      "../../scripts/memory/seed-memorycore-planning-real.ts",
    ],
    { cwd: repoRoot, env: { ...process.env, CHAT_REPO_ROOT: repoRoot }, stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`真实MemoryCore L1种子失败（exit=${String(result.status)}）`);
  }
}
