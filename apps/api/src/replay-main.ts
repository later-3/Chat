import "../../../scripts/load-api-env.mjs";
import { assertSnapshotIntegrity } from "@chat/product-store-json";
import { runReplayCli } from "@chat/realtime/replay-cli";
import { readSafeMemoryImportRuntimeEvidence } from "@chat/workflows";

const allowContent = process.env.CHAT_REPLAY_ALLOW_CONTENT === "1";

process.exitCode = runReplayCli(process.argv.slice(2), {
  snapshotIntegrityCheck: assertSnapshotIntegrity,
  authorizeContentAccess: () => allowContent,
  readMemoryImportRuntimeEvidence: readSafeMemoryImportRuntimeEvidence,
});
