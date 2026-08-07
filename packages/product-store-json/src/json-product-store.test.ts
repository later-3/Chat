import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmptySnapshot,
  productSnapshotSchema,
  type CommandId,
  type ProductSession,
  type ProductSnapshot,
} from "@chat/contracts";
import { computePlanSha256, CommandIdReusedError, StoreCorruptedError } from "@chat/application";
import { JsonProductStore, type StoreIo } from "./json-product-store.js";

const NOW = "2026-08-07T12:00:00.000Z";
let clock = 0;
const now = (): string => new Date(Date.parse(NOW) + clock++ * 1000).toISOString();

async function tempStorePath(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "chat-store-"));
  return { dir, filePath: join(dir, "chat-product-store.v1.json") };
}

function sessionEntity(id: string): ProductSession {
  return {
    schemaVersion: "product-session.v1",
    sessionId: id as ProductSession["sessionId"],
    ownerPrincipalId: "usr_debug" as ProductSession["ownerPrincipalId"],
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

async function listTempFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes(".tmp-"));
}

describe("JsonProductStore 原子提交与重启恢复", () => {
  it("文件不存在时创建创世快照并持久化", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);

    const onDisk = productSnapshotSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    expect(onDisk.schemaVersion).toBe("chat-product-store.v1");
  });

  it("transact原子提交并可跨重启读取", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const result = await store.transact(addSessionTransaction("cmd_1", "psn_1"));
    expect(result.replayed).toBe(false);
    expect(result.storeRevision).toBe(1);

    const reopened = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await reopened.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(1);
    expect(snapshot.entities.sessions["psn_1"]?.sessionId).toBe("psn_1");
    expect(snapshot.commandReceipts["cmd_1"]?.committedStoreRevision).toBe(1);
  });

  it("快照文件权限为0600", async () => {
    const { filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("同一commandId + 相同请求Hash返回原结果，mutate不再次运行", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    let mutateCalls = 0;
    const tx = {
      commandId: "cmd_9" as CommandId,
      commandType: "CreateProductSession",
      requestSha256: "b".repeat(64),
      mutate: (draft: ProductSnapshot) => {
        mutateCalls += 1;
        draft.entities.sessions["psn_9"] = sessionEntity("psn_9");
        return { resultRefs: { sessionId: "psn_9" } };
      },
    };
    const first = await store.transact(tx);
    const second = await store.transact(tx);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.resultRefs).toEqual(first.resultRefs);
    expect(mutateCalls).toBe(1);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(Object.keys(snapshot.entities.sessions)).toHaveLength(1);
  });

  it("同一commandId + 不同请求Hash抛出CommandIdReusedError", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    await store.transact(addSessionTransaction("cmd_1", "psn_1"));
    const conflicting = {
      ...addSessionTransaction("cmd_1", "psn_2"),
      requestSha256: "f".repeat(64),
    };
    await expect(store.transact(conflicting)).rejects.toBeInstanceOf(CommandIdReusedError);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.sessions["psn_2"]).toBeUndefined();
  });

  it("并发transact按单写队列序列化，storeRevision连续递增", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const results = await Promise.all([
      store.transact(addSessionTransaction("cmd_a", "psn_a")),
      store.transact(addSessionTransaction("cmd_b", "psn_b")),
      store.transact(addSessionTransaction("cmd_c", "psn_c")),
    ]);
    const revisions = results.map((result) => result.storeRevision).sort();
    expect(revisions).toEqual([1, 2, 3]);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(Object.keys(snapshot.entities.sessions)).toHaveLength(3);
  });

  it("mutate抛错时不写入任何内容", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const before = await readFile(filePath, "utf8");
    await expect(
      store.transact({
        commandId: "cmd_x" as CommandId,
        commandType: "Broken",
        requestSha256: "c".repeat(64),
        mutate: () => {
          throw new Error("business failure");
        },
      }),
    ).rejects.toThrow("business failure");
    expect(await readFile(filePath, "utf8")).toBe(before);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);
    expect(snapshot.commandReceipts["cmd_x"]).toBeUndefined();
  });
});

describe("JsonProductStore 损坏与失败注入", () => {
  it.each([
    [
      "临时文件写入",
      {
        writeTempFile: async () => Promise.reject(new Error("disk full")),
      } satisfies Partial<StoreIo>,
    ],
    [
      "临时文件fsync",
      {
        fsyncTempFile: async () => Promise.reject(new Error("fsync failed")),
      } satisfies Partial<StoreIo>,
    ],
    [
      "父目录fsync",
      {
        fsyncParentDirectory: async () => Promise.reject(new Error("dir fsync failed")),
      } satisfies Partial<StoreIo>,
    ],
    [
      "rename",
      {
        renameTempFile: async () => Promise.reject(new Error("rename failed")),
      } satisfies Partial<StoreIo>,
    ],
  ])("%s失败时旧快照逐字节不变，内存仍指向旧快照", async (_label, ioOverride) => {
    const { dir, filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    await writeFile(filePath, JSON.stringify(createEmptySnapshot(NOW), null, 2));
    const store = await JsonProductStore.open({ filePath, now, io: ioOverride });
    const before = await readFile(filePath, "utf8");

    await expect(store.transact(addSessionTransaction("cmd_1", "psn_1"))).rejects.toThrow();

    expect(await readFile(filePath, "utf8")).toBe(before);
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);
    expect(snapshot.entities.sessions["psn_1"]).toBeUndefined();
    // 孤立临时文件被隔离保留供诊断，不被误当正式快照
    void dir;
  });

  it("写失败产生的孤立临时文件不影响open，也不被静默删除", async () => {
    const { dir, filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    const store = await JsonProductStore.open({
      filePath,
      now,
      io: { fsyncTempFile: async () => Promise.reject(new Error("fsync failed")) },
    });
    await expect(store.transact(addSessionTransaction("cmd_1", "psn_1"))).rejects.toThrow();
    expect((await listTempFiles(dir)).length).toBeGreaterThan(0);

    const reopened = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await reopened.read({ kind: "committedSnapshot" });
    expect(snapshot.storeRevision).toBe(0);
    expect((await listTempFiles(dir)).length).toBeGreaterThan(0);
  });

  it("截断JSON启动失败关闭，原文件逐字节不变", async () => {
    const { filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    const original = await readFile(filePath, "utf8");
    await writeFile(filePath, original.slice(0, original.length - 20));
    const corrupted = await readFile(filePath, "utf8");
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    expect(await readFile(filePath, "utf8")).toBe(corrupted);
  });

  it("未知Schema版本启动失败关闭", async () => {
    const { filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    snapshot["schemaVersion"] = "chat-product-store.v999";
    await writeFile(filePath, JSON.stringify(snapshot));
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });

  it("悬空引用启动失败关闭", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    await store.transact(addSessionTransaction("cmd_1", "psn_1"));
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
    snapshot.entities.messages["msg_1"] = {
      schemaVersion: "message.v1",
      messageId: "msg_1" as never,
      sessionId: "psn_missing" as never,
      sessionSequence: 1,
      role: "user",
      content: { format: "markdown", text: "hi" },
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await writeFile(filePath, JSON.stringify(snapshot));
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });

  it("Plan Hash不一致启动失败关闭", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    await store.transact({
      commandId: "cmd_1" as CommandId,
      commandType: "SeedPlan",
      requestSha256: "d".repeat(64),
      mutate: (draft) => {
        draft.entities.sessions["psn_1"] = sessionEntity("psn_1");
        const content = {
          objective: "o",
          summary: "s",
          assumptions: [],
          openQuestions: [],
          steps: [
            {
              stepId: "s1",
              title: "t",
              purpose: "p",
              dependsOn: [],
              inputRefs: [],
              expectedOutput: "e",
              successCriteria: ["c"],
              requestedCapabilities: [],
              risk: "low" as const,
            },
          ],
          completionCriteria: ["done"],
          warnings: [],
        };
        draft.entities.runs["run_1"] = {
          schemaVersion: "product-run.v1",
          productRunId: "run_1" as never,
          sessionId: "psn_1" as never,
          sourceMessageId: "msg_1" as never,
          status: "waiting_human",
          phase: "plan_review",
          maxPlanRevisions: 5,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.messages["msg_1"] = {
          schemaVersion: "message.v1",
          messageId: "msg_1" as never,
          sessionId: "psn_1" as never,
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: "hi" },
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.plans["plr_1"] = {
          schemaVersion: "plan-revision.v1",
          planRevisionId: "plr_1" as never,
          planId: "pln_1" as never,
          productRunId: "run_1" as never,
          planRevision: 1,
          status: "under_review",
          content,
          sha256: computePlanSha256({
            planId: "pln_1",
            productRunId: "run_1",
            planRevision: 1,
            content,
          }),
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        return { resultRefs: { planRevisionId: "plr_1" } };
      },
    });
    // 篡改持久化的Plan Hash
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
    const plan = snapshot.entities.plans["plr_1"];
    expect(plan).toBeDefined();
    if (plan !== undefined) plan.sha256 = "0".repeat(64);
    await writeFile(filePath, JSON.stringify(snapshot));
    await expect(JsonProductStore.open({ filePath, now })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
  });
});
