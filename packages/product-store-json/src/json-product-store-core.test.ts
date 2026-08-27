import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  productSnapshotSchema,
  workflowViewDefinitionSchema,
  type CommandId,
  type ProductSession,
  type ProductSnapshot,
} from "@chat/contracts";
import { CommandIdReusedError, StoreCorruptedError, computePlanSha256 } from "@chat/application";
import {
  computeRunContextRequestSha256,
  createLegacyPlanningWorkflowView,
  hashCanonical,
} from "@chat/domain";
import { JsonProductStore, type StoreIo } from "./json-product-store.js";

const NOW = "2026-08-27T12:00:00.000Z";

async function tempStoreLocation(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "chat-store-core-"));
  return { directory, filePath: join(directory, "chat-product-store.json") };
}

async function tempStorePath(): Promise<string> {
  return (await tempStoreLocation()).filePath;
}

async function listTempFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes(".tmp-"));
}

function sessionEntity(sessionId: string): ProductSession {
  return {
    schemaVersion: "product-session.v1",
    sessionId: sessionId as ProductSession["sessionId"],
    ownerPrincipalId: "usr_storecore" as ProductSession["ownerPrincipalId"],
    status: "active",
    lastMessageSequence: 0,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function addSessionTransaction(commandId: string, sessionId: string) {
  return {
    commandId: commandId as CommandId,
    commandType: "CreateProductSession",
    requestSha256: "a".repeat(64),
    mutate: (draft: ProductSnapshot) => {
      draft.entities.sessions[sessionId] = sessionEntity(sessionId);
      return { resultRefs: { sessionId } };
    },
  };
}

describe("JsonProductStore 核心持久化合同", () => {
  it("文件不存在时创建v27创世快照并持久化，重启后读取同一事实", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    const first = await store.read({ kind: "committedSnapshot" });

    expect(first.snapshot.schemaVersion).toBe("chat-product-store.v27");
    expect(first.snapshot.storeRevision).toBe(0);

    const onDisk = productSnapshotSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    expect(onDisk).toEqual(first.snapshot);

    const reopened = await JsonProductStore.open({ filePath, now: () => NOW });
    expect((await reopened.read({ kind: "committedSnapshot" })).snapshot).toEqual(first.snapshot);
  });

  it("快照文件权限固定为0600", async () => {
    const filePath = await tempStorePath();
    await JsonProductStore.open({ filePath, now: () => NOW });

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("事务原子提交并可跨重启读取事实与Receipt", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    const result = await store.transact(addSessionTransaction("cmd_storecore1", "psn_storecore1"));

    expect(result).toMatchObject({ replayed: false, storeRevision: 1 });

    const reopened = await JsonProductStore.open({ filePath, now: () => NOW });
    const { snapshot } = await reopened.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.sessions["psn_storecore1"]?.sessionId).toBe("psn_storecore1");
    expect(snapshot.commandReceipts["cmd_storecore1" as CommandId]).toMatchObject({
      committedStoreRevision: 1,
      resultRefs: { sessionId: "psn_storecore1" },
    });
  });

  it("同一commandId与请求Hash幂等重放，不再次执行mutate", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    let mutateCalls = 0;
    const transaction = {
      ...addSessionTransaction("cmd_storecore2", "psn_storecore2"),
      mutate: (draft: ProductSnapshot) => {
        mutateCalls += 1;
        draft.entities.sessions["psn_storecore2"] = sessionEntity("psn_storecore2");
        return { resultRefs: { sessionId: "psn_storecore2" } };
      },
    };

    const first = await store.transact(transaction);
    const replay = await store.transact(transaction);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(mutateCalls).toBe(1);
    expect((await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision).toBe(1);
  });

  it("同一commandId承载不同请求Hash时拒绝冲突且不写入第二个事实", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    await store.transact(addSessionTransaction("cmd_storecore3", "psn_storecore3"));

    await expect(
      store.transact({
        ...addSessionTransaction("cmd_storecore3", "psn_storecore4"),
        requestSha256: "f".repeat(64),
      }),
    ).rejects.toBeInstanceOf(CommandIdReusedError);

    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(1);
    expect(snapshot.entities.sessions["psn_storecore4"]).toBeUndefined();
  });

  it("并发事务由单写队列串行提交，revision连续且事实无丢失", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });

    const results = await Promise.all([
      store.transact(addSessionTransaction("cmd_storecore5", "psn_storecore5")),
      store.transact(addSessionTransaction("cmd_storecore6", "psn_storecore6")),
      store.transact(addSessionTransaction("cmd_storecore7", "psn_storecore7")),
    ]);

    expect(results.map(({ storeRevision }) => storeRevision).sort((a, b) => a - b)).toEqual([
      1, 2, 3,
    ]);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(3);
    expect(Object.keys(snapshot.entities.sessions).sort()).toEqual([
      "psn_storecore5",
      "psn_storecore6",
      "psn_storecore7",
    ]);
  });

  it("read返回防御性副本，调用方不能绕过事务修改权威快照", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    const first = await store.read({ kind: "committedSnapshot" });
    first.snapshot.entities.sessions["psn_injected"] = sessionEntity("psn_injected");

    const second = await store.read({ kind: "committedSnapshot" });
    expect(second.snapshot.entities.sessions["psn_injected"]).toBeUndefined();
    expect(second.snapshot.storeRevision).toBe(0);
  });

  it("mutate失败时正式文件、内存revision和Receipt均保持不变", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    const before = await readFile(filePath, "utf8");

    await expect(
      store.transact({
        commandId: "cmd_storecore8" as CommandId,
        commandType: "BrokenTransaction",
        requestSha256: "c".repeat(64),
        mutate: () => {
          throw new Error("expected mutation failure");
        },
      }),
    ).rejects.toThrow("expected mutation failure");

    expect(await readFile(filePath, "utf8")).toBe(before);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);
    expect(snapshot.commandReceipts["cmd_storecore8" as CommandId]).toBeUndefined();
  });

  it("坏JSON启动失败关闭且原文件逐字节不变", async () => {
    const filePath = await tempStorePath();
    const corrupted = '{"schemaVersion":"chat-product-store.v27"';
    await writeFile(filePath, corrupted, "utf8");

    await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    expect(await readFile(filePath, "utf8")).toBe(corrupted);
  });

  it("未知Schema启动失败关闭且原文件逐字节不变", async () => {
    const filePath = await tempStorePath();
    const genesisPath = await tempStorePath();
    await JsonProductStore.open({ filePath: genesisPath, now: () => NOW });
    const unknown = JSON.stringify({
      ...(JSON.parse(await readFile(genesisPath, "utf8")) as Record<string, unknown>),
      schemaVersion: "chat-product-store.v999",
    });
    await writeFile(filePath, unknown, "utf8");

    await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    expect(await readFile(filePath, "utf8")).toBe(unknown);
  });

  it("已退役旧代启动失败时保留备用分支恢复动作且不改原文件", async () => {
    const filePath = await tempStorePath();
    const legacy = JSON.stringify({ schemaVersion: "chat-product-store.v9" });
    await writeFile(filePath, legacy, "utf8");

    await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toThrow(
      "备份分支升级到v10",
    );
    expect(await readFile(filePath, "utf8")).toBe(legacy);
  });

  it("atomic rename后目录fsync失败会熔断实例，重启只从已rename事实恢复", async () => {
    const filePath = await tempStorePath();
    await JsonProductStore.open({ filePath, now: () => NOW });
    let directorySyncCalls = 0;
    const store = await JsonProductStore.open({
      filePath,
      now: () => NOW,
      io: {
        fsyncParentDirectory: async () => {
          directorySyncCalls += 1;
          if (directorySyncCalls === 2) throw new Error("post-rename fsync failed");
        },
      },
    });

    await expect(
      store.transact(addSessionTransaction("cmd_storecore9", "psn_storecore9")),
    ).rejects.toBeInstanceOf(StoreCorruptedError);
    await expect(store.read({ kind: "committedSnapshot" })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    await expect(
      store.transact(addSessionTransaction("cmd_storecore10", "psn_storecore10")),
    ).rejects.toBeInstanceOf(StoreCorruptedError);

    const reopened = await JsonProductStore.open({ filePath, now: () => NOW });
    const { snapshot } = await reopened.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.sessions["psn_storecore9"]).toBeDefined();
    expect(snapshot.entities.sessions["psn_storecore10"]).toBeUndefined();
  });

  it.each([
    ["临时文件写入", { writeTempFile: async () => Promise.reject(new Error("disk full")) }],
    ["临时文件fsync", { fsyncTempFile: async () => Promise.reject(new Error("fsync failed")) }],
    [
      "rename前父目录fsync",
      {
        fsyncParentDirectory: async () => Promise.reject(new Error("directory fsync failed")),
      },
    ],
    ["atomic rename", { renameTempFile: async () => Promise.reject(new Error("rename failed")) }],
  ] satisfies ReadonlyArray<readonly [string, Partial<StoreIo>]>)(
    "%s失败时正式文件逐字节不变且内存仍指向旧快照",
    async (_label, io) => {
      const filePath = await tempStorePath();
      await JsonProductStore.open({ filePath, now: () => NOW });
      const store = await JsonProductStore.open({ filePath, now: () => NOW, io });
      const before = await readFile(filePath, "utf8");

      await expect(
        store.transact(addSessionTransaction("cmd_storecore11", "psn_storecore11")),
      ).rejects.toThrow("atomic rename前失败");

      expect(await readFile(filePath, "utf8")).toBe(before);
      const { snapshot } = await store.read({ kind: "committedSnapshot" });
      expect(snapshot.storeRevision).toBe(0);
      expect(snapshot.entities.sessions["psn_storecore11"]).toBeUndefined();
    },
  );

  it("v26统一迁移在rename前失败时保留旧文件", async () => {
    const sourcePath = await tempStorePath();
    await JsonProductStore.open({ filePath: sourcePath, now: () => NOW });
    const legacy = {
      ...(JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>),
      schemaVersion: "chat-product-store.v26",
    };
    const filePath = await tempStorePath();
    const before = JSON.stringify(legacy);
    await writeFile(filePath, before, "utf8");

    await expect(
      JsonProductStore.open({
        filePath,
        now: () => NOW,
        io: { renameTempFile: async () => Promise.reject(new Error("migration rename failed")) },
      }),
    ).rejects.toThrow("atomic rename前失败");
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("失败留下的孤立tmp不影响重启且不会被静默删除", async () => {
    const { directory, filePath } = await tempStoreLocation();
    await JsonProductStore.open({ filePath, now: () => NOW });
    const store = await JsonProductStore.open({
      filePath,
      now: () => NOW,
      io: { fsyncTempFile: async () => Promise.reject(new Error("fsync failed")) },
    });
    await expect(
      store.transact(addSessionTransaction("cmd_storecore12", "psn_storecore12")),
    ).rejects.toThrow();
    const orphaned = await listTempFiles(directory);
    expect(orphaned.length).toBeGreaterThan(0);

    const reopened = await JsonProductStore.open({ filePath, now: () => NOW });
    expect((await reopened.read({ kind: "committedSnapshot" })).snapshot.storeRevision).toBe(0);
    expect(await listTempFiles(directory)).toEqual(orphaned);
  });

  it.each([
    [
      "Receipt数量少于storeRevision",
      (snapshot: ProductSnapshot) => {
        delete snapshot.commandReceipts["cmd_storecore13" as CommandId];
      },
    ],
    [
      "Receipt提交Revision不连续",
      (snapshot: ProductSnapshot) => {
        const receipt = snapshot.commandReceipts["cmd_storecore14" as CommandId];
        if (receipt !== undefined) receipt.committedStoreRevision = 3;
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, (snapshot: ProductSnapshot) => void]>)(
    "%s时启动失败关闭",
    async (_label, corrupt) => {
      const filePath = await tempStorePath();
      const store = await JsonProductStore.open({ filePath, now: () => NOW });
      await store.transact(addSessionTransaction("cmd_storecore13", "psn_storecore13"));
      await store.transact(addSessionTransaction("cmd_storecore14", "psn_storecore14"));
      const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
      corrupt(snapshot);
      const corrupted = JSON.stringify(snapshot);
      await writeFile(filePath, corrupted, "utf8");

      await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toBeInstanceOf(
        StoreCorruptedError,
      );
      expect(await readFile(filePath, "utf8")).toBe(corrupted);
    },
  );

  it("Message悬空引用不存在的Session时启动失败关闭", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    await store.transact(addSessionTransaction("cmd_storecore15", "psn_storecore15"));
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
    snapshot.entities.messages["msg_storecore15"] = {
      schemaVersion: "message.v1",
      messageId: "msg_storecore15" as never,
      sessionId: "psn_missing" as never,
      sessionSequence: 1,
      role: "user",
      content: { format: "markdown", text: "dangling session" },
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await writeFile(filePath, JSON.stringify(snapshot), "utf8");

    await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });

  it("持久化Plan Hash被篡改时启动失败关闭", async () => {
    const filePath = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    await store.transact({
      commandId: "cmd_storecore16" as CommandId,
      commandType: "CompilePlanningInput",
      requestSha256: "d".repeat(64),
      mutate: (draft) => {
        draft.entities.sessions["psn_storecore16"] = {
          ...sessionEntity("psn_storecore16"),
          lastMessageSequence: 1,
        };
        const content = {
          objective: "验证完整性",
          summary: "生成可审核计划",
          assumptions: [],
          openQuestions: [],
          steps: [
            {
              stepId: "step1",
              title: "验证",
              purpose: "保护Plan Hash",
              dependsOn: [],
              inputRefs: [],
              expectedOutput: "完整性证据",
              successCriteria: ["Hash一致"],
              requestedCapabilities: [],
              risk: "low" as const,
            },
          ],
          completionCriteria: ["完成"],
          warnings: [],
        };
        draft.entities.runs["run_storecore16"] = {
          schemaVersion: "product-run.v3",
          runKind: "planning",
          productRunId: "run_storecore16" as never,
          sessionId: "psn_storecore16" as never,
          sourceMessageId: "msg_storecore16" as never,
          workflowViewDefinitionId: "wvd_planninglegacyv1" as never,
          runnerFamily: "legacy-planning.v1",
          runnerBundleVersion: "legacy-planning.bundle.v1",
          status: "running",
          phase: "planning",
          currentPlanId: "pln_storecore16" as never,
          currentPlanRevision: 1,
          maxPlanRevisions: 5,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.workflowViewDefinitions["wvd_planninglegacyv1"] =
          workflowViewDefinitionSchema.parse(createLegacyPlanningWorkflowView(NOW));
        draft.entities.messages["msg_storecore16"] = {
          schemaVersion: "message.v1",
          messageId: "msg_storecore16" as never,
          sessionId: "psn_storecore16" as never,
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: "生成计划" },
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const sourceMessageSha256 = hashCanonical("message.v1", {
          messageId: "msg_storecore16",
          sessionId: "psn_storecore16",
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: "生成计划" },
        });
        const contextRequest = {
          productRunId: "run_storecore16" as never,
          requestedByPrincipalId: "usr_storecore" as never,
          sourceMessageId: "msg_storecore16" as never,
          sourceMessageSha256,
        };
        draft.entities.contextRequests["ctxr_storecore16"] = {
          schemaVersion: "run-context-request.v1",
          contextRequestId: "ctxr_storecore16" as never,
          ...contextRequest,
          sha256: computeRunContextRequestSha256(contextRequest),
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const inputManifestSha256 = hashCanonical("planning-input-manifest.v1", {
          productRunId: "run_storecore16",
          planRevision: 1,
          sourceMessageRef: { messageId: "msg_storecore16", sha256: sourceMessageSha256 },
          promptTemplateVersion: "planner-prompt.v1",
          modelConfigVersion: "bailian.qwen3.7-plus.v1",
        });
        draft.entities.attempts["att_storecore16"] = {
          schemaVersion: "run-attempt.v1",
          attemptId: "att_storecore16" as never,
          productRunId: "run_storecore16" as never,
          kind: "planning",
          planRevision: 1,
          inputRunRevision: 1,
          sourceMessageSha256,
          inputManifestSha256,
          promptTemplateVersion: "planner-prompt.v1",
          modelConfigVersion: "bailian.qwen3.7-plus.v1",
          outcome: "success",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.attempts["att_storecoreworkflow16"] = {
          schemaVersion: "run-attempt.v1",
          attemptId: "att_storecoreworkflow16" as never,
          productRunId: "run_storecore16" as never,
          kind: "workflow",
          outcome: "running",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.plans["plr_storecore16"] = {
          schemaVersion: "plan-revision.v1",
          planRevisionId: "plr_storecore16" as never,
          planId: "pln_storecore16" as never,
          productRunId: "run_storecore16" as never,
          planningAttemptId: "att_storecore16" as never,
          planRevision: 1,
          status: "superseded",
          content,
          sha256: computePlanSha256({
            planId: "pln_storecore16",
            productRunId: "run_storecore16",
            planRevision: 1,
            content,
          }),
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        return {
          resultRefs: { attemptId: "att_storecore16", productRunId: "run_storecore16" },
        };
      },
    });

    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
    const plan = snapshot.entities.plans["plr_storecore16"];
    expect(plan).toBeDefined();
    if (plan !== undefined) plan.sha256 = "0".repeat(64);
    await writeFile(filePath, JSON.stringify(snapshot), "utf8");

    await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });
});
