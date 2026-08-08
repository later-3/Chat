import { ensureFixedMemoryCore } from "./fixed-memorycore.mjs";

try {
  ensureFixedMemoryCore();
} catch (error) {
  console.error(`[memorycore-source] ${error instanceof Error ? error.message : "准备失败"}`);
  process.exitCode = 1;
}
