import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeBuildEvidence } from "@chat/contracts";
import {
  assertRunVersionMatchesBuild,
  captureRunVersionEvidence,
  loadRuntimeBuildEvidence,
  runVersionEvidencePath,
} from "./runtime-version-evidence.js";

const BUILD: RuntimeBuildEvidence = {
  schemaVersion: "chat-runtime-build-evidence.v1",
  builtAt: "2026-08-07T12:00:00.000Z",
  gitSha: "a".repeat(40),
  sourceState: "clean",
  sourceManifestSha256: "b".repeat(64),
  bundleManifestSha256: "c".repeat(64),
  workflowDefinitionVersions: ["planning-execution-workflow.v1"],
  promptTemplateVersions: ["planner-prompt.v1", "executor-prompt.v1"],
  modelConfigVersions: ["bailian.qwen3.7-plus.v1"],
};

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("runtime version evidence", () => {
  it("bundle证据缺失、损坏或带未知字段时失败关闭", async () => {
    const bundleDir = await tempDir("chat-bundle-evidence-");
    await expect(loadRuntimeBuildEvidence(bundleDir)).rejects.toThrow("缺少可读取");
    await writeFile(join(bundleDir, "runtime-build-evidence.json"), "{");
    await expect(loadRuntimeBuildEvidence(bundleDir)).rejects.toThrow("缺少可读取");
    await writeFile(
      join(bundleDir, "runtime-build-evidence.json"),
      JSON.stringify({ ...BUILD, unexpected: true }),
    );
    await expect(loadRuntimeBuildEvidence(bundleDir)).rejects.toThrow("证据非法");
  });

  it("Start前保存0600不可变证据，同一Build幂等且保留首次capturedAt", async () => {
    const workflowDataDir = await tempDir("chat-run-evidence-");
    const first = await captureRunVersionEvidence({
      workflowDataDir,
      productRunId: "run_evidence" as never,
      buildEvidence: BUILD,
      now: "2026-08-07T12:01:00.000Z",
    });
    const second = await captureRunVersionEvidence({
      workflowDataDir,
      productRunId: "run_evidence" as never,
      buildEvidence: BUILD,
      now: "2026-08-07T12:02:00.000Z",
    });
    expect(second).toEqual(first);
    const filePath = runVersionEvidencePath(workflowDataDir, "run_evidence");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("并发发布只保留一个首次证据，冲突Build和损坏文件均拒绝覆盖", async () => {
    const workflowDataDir = await tempDir("chat-run-evidence-race-");
    const [first, second] = await Promise.all([
      captureRunVersionEvidence({
        workflowDataDir,
        productRunId: "run_race" as never,
        buildEvidence: BUILD,
        now: "2026-08-07T12:01:00.000Z",
      }),
      captureRunVersionEvidence({
        workflowDataDir,
        productRunId: "run_race" as never,
        buildEvidence: BUILD,
        now: "2026-08-07T12:02:00.000Z",
      }),
    ]);
    expect(second).toEqual(first);
    await expect(
      captureRunVersionEvidence({
        workflowDataDir,
        productRunId: "run_race" as never,
        buildEvidence: { ...BUILD, gitSha: "b".repeat(40) },
        now: "2026-08-07T12:03:00.000Z",
      }),
    ).rejects.toThrow("证据冲突");

    const filePath = runVersionEvidencePath(workflowDataDir, "run_race");
    await writeFile(filePath, "{");
    const corrupted = await readFile(filePath, "utf8");
    await expect(
      captureRunVersionEvidence({
        workflowDataDir,
        productRunId: "run_race" as never,
        buildEvidence: BUILD,
        now: "2026-08-07T12:04:00.000Z",
      }),
    ).rejects.toThrow("证据损坏");
    expect(await readFile(filePath, "utf8")).toBe(corrupted);
  });

  it("恢复活动Run时只接受与当前Runtime逐字段一致的Build", async () => {
    const workflowDataDir = await tempDir("chat-run-evidence-resume-");
    const productRunId = "run_resume1" as never;
    await captureRunVersionEvidence({
      workflowDataDir,
      productRunId,
      buildEvidence: BUILD,
      now: "2026-08-07T12:01:00.000Z",
    });

    await expect(
      assertRunVersionMatchesBuild({ workflowDataDir, productRunId, buildEvidence: BUILD }),
    ).resolves.toBeUndefined();
    await expect(
      assertRunVersionMatchesBuild({
        workflowDataDir,
        productRunId,
        buildEvidence: { ...BUILD, bundleManifestSha256: "d".repeat(64) },
      }),
    ).rejects.toThrow("运行版本证据冲突");
  });
});
