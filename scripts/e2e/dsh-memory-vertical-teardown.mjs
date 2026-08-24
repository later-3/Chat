import { resolve } from "node:path";

import {
  FIXED_MEMMY_COMMIT,
  FIXED_MEMMY_PORT,
  fixedMemmyCacheRoot,
  fixedMemmyServerEntry,
} from "../memory/fixed-memmy.mjs";
import {
  createMemorySidecarContract,
  reconcileManagedMemorySidecar,
} from "../memory/process-lifecycle.mjs";

/** Playwright结束前按v2进程证据回收真实memmy；身份不匹配时失败关闭且不发信号。 */
export default function teardownMemoryVertical() {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const runRoot = resolve(repoRoot, ".data/e2e/dsh-memory-vertical-real/memmy");
  const dbPath = resolve(runRoot, "memory.sqlite");
  const configPath = resolve(runRoot, "config.json");
  const serverEntry = fixedMemmyServerEntry(repoRoot);
  const contract = createMemorySidecarContract({
    root: repoRoot,
    provider: "memmy",
    runtimeInstance: "production",
    sourceCommit: FIXED_MEMMY_COMMIT,
    port: FIXED_MEMMY_PORT,
    runRoot,
    childCwd: fixedMemmyCacheRoot(repoRoot),
    commandFragments: [
      serverEntry,
      "--port",
      String(FIXED_MEMMY_PORT),
      "--db",
      dbPath,
      "--config",
      configPath,
    ],
  });
  const result = reconcileManagedMemorySidecar(contract);
  console.log(`[memory-vertical-teardown] memmy=${result.action}`);
}
