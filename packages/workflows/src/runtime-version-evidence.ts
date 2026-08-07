import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  runtimeBuildEvidenceSchema,
  runtimeVersionEvidenceSchema,
  type ProductRunId,
  type RuntimeBuildEvidence,
  type RuntimeVersionEvidence,
} from "@chat/contracts";

export async function loadRuntimeBuildEvidence(bundleDir: string): Promise<RuntimeBuildEvidence> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(bundleDir, "runtime-build-evidence.json"), "utf8"));
  } catch {
    throw new Error("Workflow bundle缺少可读取的运行版本证据，拒绝启动Runtime");
  }
  const result = runtimeBuildEvidenceSchema.safeParse(parsed);
  if (!result.success) throw new Error("Workflow bundle运行版本证据非法，拒绝启动Runtime");
  return result.data;
}

export function runVersionEvidencePath(workflowDataDir: string, productRunId: string): string {
  return join(workflowDataDir, "version-evidence", `${productRunId}.json`);
}

/** Start副作用前保存每个Run的不可变历史版本证据；同Run内容冲突失败关闭。 */
export async function captureRunVersionEvidence(input: {
  workflowDataDir: string;
  productRunId: ProductRunId;
  buildEvidence: RuntimeBuildEvidence;
  now: string;
}): Promise<RuntimeVersionEvidence> {
  const evidence = runtimeVersionEvidenceSchema.parse({
    schemaVersion: "chat-runtime-version-evidence.v1",
    productRunId: input.productRunId,
    capturedAt: input.now,
    gitSha: input.buildEvidence.gitSha,
    sourceState: input.buildEvidence.sourceState,
    sourceManifestSha256: input.buildEvidence.sourceManifestSha256,
    bundleManifestSha256: input.buildEvidence.bundleManifestSha256,
    workflowDefinitionVersions: input.buildEvidence.workflowDefinitionVersions,
    promptTemplateVersions: input.buildEvidence.promptTemplateVersions,
    modelConfigVersions: input.buildEvidence.modelConfigVersions,
  });
  const filePath = runVersionEvidencePath(input.workflowDataDir, input.productRunId);
  const existing = await readExistingEvidence(filePath);
  if (existing !== undefined) return assertSameBuild(existing, evidence);

  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${input.productRunId}.tmp-${randomUUID()}`);
  await writeFile(tempPath, JSON.stringify(evidence, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const temp = await open(tempPath, "r");
  try {
    await temp.sync();
  } finally {
    await temp.close();
  }
  try {
    // hard-link是同一文件系统内的原子“仅不存在时发布”；并发Start不能覆盖先写证据。
    await link(tempPath, filePath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await unlink(tempPath).catch(() => undefined);
    const concurrentlyPublished = await readExistingEvidence(filePath);
    if (concurrentlyPublished === undefined) {
      throw new Error("运行版本证据并发发布状态不确定，拒绝继续");
    }
    return assertSameBuild(concurrentlyPublished, evidence);
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  await unlink(tempPath).catch(() => undefined);
  return evidence;
}

/** Runtime恢复活动Run前复核：没有旧bundle时只能恢复与当前构建逐字段一致的Run。 */
export async function assertRunVersionMatchesBuild(input: {
  workflowDataDir: string;
  productRunId: ProductRunId;
  buildEvidence: RuntimeBuildEvidence;
}): Promise<void> {
  const existing = await readExistingEvidence(
    runVersionEvidencePath(input.workflowDataDir, input.productRunId),
  );
  if (existing === undefined) throw new Error("活动Workflow Run缺少历史版本证据，拒绝恢复");
  const expected = runtimeVersionEvidenceSchema.parse({
    schemaVersion: "chat-runtime-version-evidence.v1",
    productRunId: input.productRunId,
    capturedAt: existing.capturedAt,
    gitSha: input.buildEvidence.gitSha,
    sourceState: input.buildEvidence.sourceState,
    sourceManifestSha256: input.buildEvidence.sourceManifestSha256,
    bundleManifestSha256: input.buildEvidence.bundleManifestSha256,
    workflowDefinitionVersions: input.buildEvidence.workflowDefinitionVersions,
    promptTemplateVersions: input.buildEvidence.promptTemplateVersions,
    modelConfigVersions: input.buildEvidence.modelConfigVersions,
  });
  assertSameBuild(existing, expected);
}

async function readExistingEvidence(filePath: string): Promise<RuntimeVersionEvidence | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return runtimeVersionEvidenceSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("运行版本证据损坏，拒绝覆盖");
  }
}

function assertSameBuild(
  existing: RuntimeVersionEvidence,
  expected: RuntimeVersionEvidence,
): RuntimeVersionEvidence {
  const sameBuild =
    existing.productRunId === expected.productRunId &&
    existing.gitSha === expected.gitSha &&
    existing.sourceState === expected.sourceState &&
    existing.sourceManifestSha256 === expected.sourceManifestSha256 &&
    existing.bundleManifestSha256 === expected.bundleManifestSha256 &&
    JSON.stringify(existing.workflowDefinitionVersions) ===
      JSON.stringify(expected.workflowDefinitionVersions) &&
    JSON.stringify(existing.promptTemplateVersions) ===
      JSON.stringify(expected.promptTemplateVersions) &&
    JSON.stringify(existing.modelConfigVersions) === JSON.stringify(expected.modelConfigVersions);
  if (!sameBuild) throw new Error("同一Product Run的运行版本证据冲突");
  return existing;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}
