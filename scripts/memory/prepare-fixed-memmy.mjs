import { pathToFileURL } from "node:url";
import { ensureFixedMemmy } from "./fixed-memmy.mjs";

export async function main() {
  await ensureFixedMemmy();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(`[memmy-source] ${error instanceof Error ? error.message : "准备失败"}`);
    process.exitCode = 1;
  }
}
