import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeBindingError, RuntimeBindingStore } from "./runtime-bindings.js";

const NOW = "2026-08-07T12:00:00.000Z";

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chat-bindings-"));
  return join(dir, "runtime-bindings.v1.json");
}

describe("RuntimeBindingStore", () => {
  it("缺失时初始化空映射并持久化0600", async () => {
    const filePath = await tempPath();
    await RuntimeBindingStore.open(filePath);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("同一productRunId重复认领幂等；不同workflowRunId冲突失败关闭", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    const first = await store.claimWorkflowBinding({
      productRunId: "run_1" as never,
      workflowRunId: "wrun_a",
      workflowDefinitionVersion: "planning-execution-workflow.v1",
      now: NOW,
    });
    expect(first.alreadyExisted).toBe(false);
    const second = await store.claimWorkflowBinding({
      productRunId: "run_1" as never,
      workflowRunId: "wrun_a",
      workflowDefinitionVersion: "planning-execution-workflow.v1",
      now: NOW,
    });
    expect(second.alreadyExisted).toBe(true);
    await expect(
      store.claimWorkflowBinding({
        productRunId: "run_1" as never,
        workflowRunId: "wrun_b",
        workflowDefinitionVersion: "planning-execution-workflow.v1",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
  });

  it("Hook映射缺失、冲突与Resume状态流转", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    await expect(store.markResumeDispatched("apr_1" as never, NOW)).rejects.toBeInstanceOf(
      RuntimeBindingError,
    );
    await store.claimHookBinding({
      approvalRequestId: "apr_1" as never,
      productRunId: "run_1" as never,
      planRevision: 1,
      hookToken: "pdh-run_1-1",
      now: NOW,
    });
    await expect(
      store.claimHookBinding({
        approvalRequestId: "apr_1" as never,
        productRunId: "run_1" as never,
        planRevision: 1,
        hookToken: "pdh-different-1",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
    await store.markResumeDispatched("apr_1" as never, NOW);
    expect(store.getHookBinding("apr_1" as never)?.resumeDispatchState).toBe("dispatched");
  });

  it("损坏JSON与未知版本启动失败关闭，原文件不变", async () => {
    const filePath = await tempPath();
    await RuntimeBindingStore.open(filePath);
    const original = await readFile(filePath, "utf8");
    await writeFile(filePath, original.slice(0, original.length - 10));
    const corrupted = await readFile(filePath, "utf8");
    await expect(RuntimeBindingStore.open(filePath)).rejects.toBeInstanceOf(RuntimeBindingError);
    expect(await readFile(filePath, "utf8")).toBe(corrupted);

    const filePath2 = await tempPath();
    await writeFile(
      filePath2,
      JSON.stringify({ schemaVersion: "runtime-bindings.v999", workflows: {}, hooks: {} }),
    );
    await expect(RuntimeBindingStore.open(filePath2)).rejects.toBeInstanceOf(RuntimeBindingError);
  });

  it("重启后可读取已提交映射", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    await store.claimWorkflowBinding({
      productRunId: "run_1" as never,
      workflowRunId: "wrun_a",
      workflowDefinitionVersion: "planning-execution-workflow.v1",
      now: NOW,
    });
    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getWorkflowBinding("run_1" as never)?.workflowRunId).toBe("wrun_a");
  });
});
