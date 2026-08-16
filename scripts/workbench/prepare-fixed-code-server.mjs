import { pathToFileURL } from "node:url";

import { resolveLocalWorkbenchRuntimeContract } from "../dev/app-runtime.mjs";
import { chatRepoRoot, ensureFixedCodeServer } from "./fixed-code-server.mjs";

export async function main() {
  const root = chatRepoRoot();
  const environment = resolveLocalWorkbenchRuntimeContract(root);
  await ensureFixedCodeServer(root, { environment });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(`[code-server] ${error instanceof Error ? error.message : "准备失败"}`);
    process.exitCode = 1;
  }
}
