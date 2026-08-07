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
  type TraceEventInput,
} from "@chat/contracts";
import {
  compilePlanningInput,
  computePlanSha256,
  createProductSession,
  publishPlanForReview,
  submitUserMessage,
  CommandIdReusedError,
  StoreCorruptedError,
  type ApplicationDeps,
  type IdFactory,
} from "@chat/application";
import { hashCanonical } from "@chat/domain";
import { JsonProductStore, type StoreIo } from "./json-product-store.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

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

async function validReviewSnapshot(): Promise<ProductSnapshot> {
  const { filePath } = await tempStorePath();
  const store = await JsonProductStore.open({ filePath, now });
  let id = 0;
  const next = (prefix: string) => `${prefix}_integrity${(++id).toString(36)}`;
  const ids = {
    session: () => next("psn"),
    message: () => next("msg"),
    run: () => next("run"),
    attempt: () => next("att"),
    plan: () => next("pln"),
    planRevision: () => next("plr"),
    revisionInput: () => next("rin"),
    approval: () => next("apr"),
    decision: () => next("dec"),
    executionContract: () => next("exc"),
    executionCandidate: () => next("xcd"),
    validationResult: () => next("val"),
    artifact: () => next("art"),
    outbox: () => next("obx"),
  } as IdFactory;
  const deps: ApplicationDeps = { store, now, ids };
  const { session } = await createProductSession(deps, {
    principalId: "usr_integrity" as never,
    commandId: "cmd_integritysession" as never,
    payload: {},
  });
  const { run } = await submitUserMessage(deps, {
    principalId: "usr_integrity" as never,
    sessionId: session.sessionId,
    commandId: "cmd_integritymessage" as never,
    payload: { text: "生成包含风险与下一步的周报" },
  });
  const planning = await compilePlanningInput(deps, {
    commandId: "cmd_integritycompile" as never,
    productRunId: run.productRunId,
    planRevision: 1,
  });
  await publishPlanForReview(deps, {
    commandId: "cmd_integritypublish" as never,
    productRunId: run.productRunId,
    attemptId: planning.attemptId,
    expectedRunRevision: planning.inputRunRevision,
    inputManifestSha256: planning.inputManifestSha256,
    content: {
      objective: "生成周报",
      summary: "整理进展并输出周报",
      assumptions: [],
      openQuestions: [],
      steps: [
        {
          stepId: "step-1",
          title: "整理",
          purpose: "整理输入",
          dependsOn: [],
          inputRefs: [],
          expectedOutput: "Markdown",
          successCriteria: ["包含风险与下一步"],
          requestedCapabilities: [],
          risk: "low",
        },
      ],
      completionCriteria: ["包含风险与下一步"],
      warnings: [],
    },
  });
  return structuredClone(
    (await store.read({ kind: "committedSnapshot" })).snapshot,
  ) as ProductSnapshot;
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

  it("事务Trace只记录真实执行，幂等重放不重复计数且不含正文", async () => {
    const { filePath } = await tempStorePath();
    const events: TraceEventInput[] = [];
    const store = await JsonProductStore.open({
      filePath,
      now,
      trace: (event) => events.push(event),
    });
    const transaction = {
      ...addSessionTransaction("cmd_trace", "psn_trace"),
      traceContext: { productSessionId: "psn_trace" as never },
    };
    await store.transact(transaction);
    await store.transact(transaction);

    expect(events.map((event) => event.eventName)).toEqual([
      "product.transaction.started",
      "product.transaction.committed",
    ]);
    expect(JSON.stringify(events)).not.toContain("PRODUCT_CONTENT_MUST_NEVER_BE_WRITTEN");
  });

  it("事务失败记录稳定错误而不提交Receipt", async () => {
    const { filePath } = await tempStorePath();
    const events: TraceEventInput[] = [];
    const store = await JsonProductStore.open({
      filePath,
      now,
      trace: (event) => events.push(event),
    });
    await expect(
      store.transact({
        commandId: "cmd_tracefail" as CommandId,
        commandType: "CreateProductSession",
        requestSha256: "a".repeat(64),
        mutate: () => {
          throw new Error("PRODUCT_CONTENT_MUST_NEVER_BE_WRITTEN");
        },
      }),
    ).rejects.toThrow();
    expect(events.map((event) => event.eventName)).toEqual([
      "product.transaction.started",
      "product.transaction.failed",
    ]);
    expect(JSON.stringify(events)).not.toContain("PRODUCT_CONTENT_MUST_NEVER_BE_WRITTEN");
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

  it("read返回防御性副本，调用方不能绕过事务修改内存权威快照", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    const first = await store.read({ kind: "committedSnapshot" });
    first.snapshot.entities.sessions["psn_injected"] = sessionEntity("psn_injected");

    const second = await store.read({ kind: "committedSnapshot" });
    expect(second.snapshot.entities.sessions["psn_injected"]).toBeUndefined();
    expect(second.snapshot.storeRevision).toBe(0);
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
  it("rename后目录fsync失败会熔断实例，禁止旧内存覆盖已rename的提交", async () => {
    const { filePath } = await tempStorePath();
    await JsonProductStore.open({ filePath, now });
    let directorySyncCalls = 0;
    const store = await JsonProductStore.open({
      filePath,
      now,
      io: {
        fsyncParentDirectory: async () => {
          directorySyncCalls += 1;
          if (directorySyncCalls === 2) throw new Error("post-rename fsync failed");
        },
      },
    });

    await expect(
      store.transact(addSessionTransaction("cmd_first", "psn_first")),
    ).rejects.toBeInstanceOf(StoreCorruptedError);
    await expect(store.read({ kind: "committedSnapshot" })).rejects.toBeInstanceOf(
      StoreCorruptedError,
    );
    await expect(
      store.transact(addSessionTransaction("cmd_second", "psn_second")),
    ).rejects.toBeInstanceOf(StoreCorruptedError);

    const reopened = await JsonProductStore.open({ filePath, now });
    const { snapshot } = await reopened.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.sessions["psn_first"]).toBeDefined();
    expect(snapshot.entities.sessions["psn_second"]).toBeUndefined();
  });

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

  it("删除任一已提交Receipt但保留storeRevision时启动失败关闭", async () => {
    const { filePath } = await tempStorePath();
    const store = await JsonProductStore.open({ filePath, now });
    await store.transact(addSessionTransaction("cmd_receipt", "psn_receipt"));
    const snapshot = JSON.parse(await readFile(filePath, "utf8")) as ProductSnapshot;
    delete snapshot.commandReceipts["cmd_receipt" as CommandId];
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
      commandType: "CompilePlanningInput",
      requestSha256: "d".repeat(64),
      mutate: (draft) => {
        draft.entities.sessions["psn_1"] = {
          ...sessionEntity("psn_1"),
          lastMessageSequence: 1,
        };
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
          status: "running",
          phase: "planning",
          currentPlanId: "pln_1" as never,
          currentPlanRevision: 1,
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
        const sourceMessageSha256 = hashCanonical("message.v1", {
          messageId: "msg_1",
          sessionId: "psn_1",
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: "hi" },
        });
        const inputManifestSha256 = hashCanonical("planning-input-manifest.v1", {
          productRunId: "run_1",
          planRevision: 1,
          sourceMessageRef: { messageId: "msg_1", sha256: sourceMessageSha256 },
          promptTemplateVersion: "planner-prompt.v1",
          modelConfigVersion: "bailian.qwen3.7-plus.v1",
        });
        draft.entities.attempts["att_1"] = {
          schemaVersion: "run-attempt.v1",
          attemptId: "att_1" as never,
          productRunId: "run_1" as never,
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
        draft.entities.attempts["att_workflow"] = {
          schemaVersion: "run-attempt.v1",
          attemptId: "att_workflow" as never,
          productRunId: "run_1" as never,
          kind: "workflow",
          outcome: "running",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        draft.entities.plans["plr_1"] = {
          schemaVersion: "plan-revision.v1",
          planRevisionId: "plr_1" as never,
          planId: "pln_1" as never,
          productRunId: "run_1" as never,
          planningAttemptId: "att_1" as never,
          planRevision: 1,
          status: "superseded",
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
        return { resultRefs: { attemptId: "att_1", productRunId: "run_1" } };
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

describe("Product Snapshot跨对象完整性", () => {
  it.each([
    [
      "Map键与实体ID不一致",
      (snapshot: ProductSnapshot) => {
        const session = Object.values(snapshot.entities.sessions)[0];
        if (session === undefined) throw new Error("fixture缺少session");
        delete snapshot.entities.sessions[session.sessionId];
        snapshot.entities.sessions["psn_wrongkey"] = session;
      },
    ],
    [
      "Run status/phase组合非法",
      (snapshot: ProductSnapshot) => {
        const run = Object.values(snapshot.entities.runs)[0];
        if (run === undefined) throw new Error("fixture缺少run");
        snapshot.entities.runs[run.productRunId] = { ...run, phase: "completed" };
      },
    ],
    [
      "Session消息序号账本不一致",
      (snapshot: ProductSnapshot) => {
        const session = Object.values(snapshot.entities.sessions)[0];
        if (session === undefined) throw new Error("fixture缺少session");
        snapshot.entities.sessions[session.sessionId] = { ...session, lastMessageSequence: 99 };
      },
    ],
    [
      "Planning输入Manifest被篡改",
      (snapshot: ProductSnapshot) => {
        const attempt = Object.values(snapshot.entities.attempts).find(
          (candidate) => candidate.kind === "planning",
        );
        if (attempt === undefined) throw new Error("fixture缺少planning attempt");
        snapshot.entities.attempts[attempt.attemptId] = {
          ...attempt,
          inputManifestSha256: "0".repeat(64),
        };
      },
    ],
    [
      "Plan绑定错误Attempt",
      (snapshot: ProductSnapshot) => {
        const plan = Object.values(snapshot.entities.plans)[0];
        const workflowAttempt = Object.values(snapshot.entities.attempts).find(
          (candidate) => candidate.kind === "workflow",
        );
        if (plan === undefined || workflowAttempt === undefined) throw new Error("fixture不完整");
        snapshot.entities.plans[plan.planRevisionId] = {
          ...plan,
          planningAttemptId: workflowAttempt.attemptId,
        };
      },
    ],
    [
      "Approval与Plan Hash不一致",
      (snapshot: ProductSnapshot) => {
        const approval = Object.values(snapshot.entities.approvalRequests)[0];
        if (approval === undefined) throw new Error("fixture缺少approval");
        snapshot.entities.approvalRequests[approval.approvalRequestId] = {
          ...approval,
          planSha256: "0".repeat(64),
        };
      },
    ],
    [
      "waiting_human丢失活动Approval引用",
      (snapshot: ProductSnapshot) => {
        const run = Object.values(snapshot.entities.runs)[0];
        if (run === undefined) throw new Error("fixture缺少run");
        const broken = { ...run };
        delete broken.currentApprovalRequestId;
        snapshot.entities.runs[run.productRunId] = broken;
      },
    ],
  ])("拒绝%s", async (_label, corrupt) => {
    const snapshot = await validReviewSnapshot();
    corrupt(snapshot);
    expect(() => assertSnapshotIntegrity(snapshot)).toThrow(StoreCorruptedError);
  });
});
