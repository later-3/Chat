import { resolve } from "node:path";
import { productRunIdSchema } from "../../packages/contracts/src/index.ts";
import { assertSnapshotIntegrity } from "../../packages/product-store-json/src/snapshot-integrity.ts";
import { assembleRunReplay } from "../../packages/realtime/src/replay.ts";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`缺少 ${name}`);
  return value;
}

const productRunId = productRunIdSchema.parse(argument("--run"));
const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());
const dataRoot = resolve(repoRoot, ".data/e2e/memory-planning-real");
const view = assembleRunReplay(
  {
    productRunId,
    storePath: resolve(dataRoot, "product-store.v2.json"),
    traceDir: resolve(dataRoot, "traces"),
    versionEvidencePath: resolve(dataRoot, "workflow/version-evidence", `${productRunId}.json`),
  },
  { snapshotIntegrityCheck: assertSnapshotIntegrity },
);

if (view.run.status !== "succeeded" || view.run.phase !== "completed") {
  throw new Error("Memory Run 尚未进入 succeeded/completed 正式终态");
}
if (view.failures.length !== 0) {
  throw new Error(`Memory Run Replay 存在 ${String(view.failures.length)} 项完整性失败`);
}
if (view.content.included !== false) {
  throw new Error("Memory Run Replay 默认错误地包含了正文");
}
if (view.versionEvidence.status !== "ok") {
  throw new Error(`Memory Run 版本证据不是 clean/ok：${view.versionEvidence.status}`);
}
if (view.timeline.length === 0) throw new Error("Memory Run Replay 缺少 Trace 时间线");

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: "chat-memory-run-replay-verification.v1",
    productRunId,
    runStatus: view.run.status,
    runPhase: view.run.phase,
    timelineEventCount: view.timeline.length,
    failures: 0,
    contentIncluded: false,
    versionEvidenceStatus: view.versionEvidence.status,
  })}\n`,
);
