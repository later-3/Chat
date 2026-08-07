import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const distAssets = resolve(process.cwd(), "dist/assets");
const forbidden = [
  "chat-internal-runtime.v1",
  "workflowRunId",
  "hookToken",
  "piSessionId",
  "providerRequestId",
  "hookResumeState",
  "runtime-build-evidence",
];

for (const file of readdirSync(distAssets)) {
  if (!file.endsWith(".js")) continue;
  const source = readFileSync(resolve(distAssets, file), "utf8");
  for (const marker of forbidden) {
    if (source.includes(marker)) {
      throw new Error(`Web生产bundle包含私有Runtime合同标记:${marker}:${file}`);
    }
  }
}

console.log("web public bundle boundary: ok");
