import "../load-env.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  productSnapshotSchema,
  workflowReconcileResponseSchema,
} from "../../packages/contracts/src/index.js";
import {
  scanRuntimeIntegrity,
  type SafeRuntimeRunEvidence,
} from "../../packages/application/src/index.js";

const root = resolve(process.env.CHAT_REPO_ROOT ?? resolve(import.meta.dirname, "../.."));
const productStorePath = resolve(
  process.env.CHAT_PRODUCT_STORE_PATH ?? `${root}/.data/product/chat-product-store.v1.json`,
);
const credentialPath = resolve(
  process.env.CHAT_RUNTIME_CREDENTIAL_PATH ?? `${root}/.data/runtime/runtime-key`,
);
const runtimeBaseUrl = process.env.CHAT_WORKFLOW_BASE_URL ?? "http://127.0.0.1:43112";

const snapshot = productSnapshotSchema.parse(JSON.parse(await readFile(productStorePath, "utf8")));
const credential = await readFile(credentialPath, "utf8")
  .then((value) => value.trim())
  .catch(() => undefined);

const readRuntimeRun = async (productRunId: string): Promise<SafeRuntimeRunEvidence> => {
  if (credential === undefined || credential === "") return { state: "unknown" };
  try {
    const url = new URL("/internal/workflow/v1/reconcile", runtimeBaseUrl);
    url.searchParams.set("productRunId", productRunId);
    const response = await fetch(url, {
      headers: { "x-chat-runtime-key": credential },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { state: "unknown" };
    const parsed = workflowReconcileResponseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.startBinding === "exists"
      ? (parsed.data.runtimeRun ?? { state: "unknown" })
      : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
};

const scannedAt = new Date().toISOString();
const findings = await scanRuntimeIntegrity(snapshot, readRuntimeRun, { observedAt: scannedAt });
console.log(
  JSON.stringify(
    {
      schemaVersion: "chat-runtime-integrity-diagnostic.v1",
      scannedAt,
      productStoreSchemaVersion: snapshot.schemaVersion,
      findingCount: findings.length,
      actionableCount: findings.filter((finding) => finding.recommendation !== "none").length,
      findings,
    },
    undefined,
    2,
  ),
);
