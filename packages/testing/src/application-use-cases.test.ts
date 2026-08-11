import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonProductStore } from "@chat/product-store-json";
import type { CommandId, PlanContent, PrincipalId, ProductRunId } from "@chat/contracts";
import {
  type ApplicationDeps,
  type IdFactory,
  ApplicationError,
  CommandIdReusedError,
  createProductSession,
  submitUserMessage,
  settleIncompatibleWorkflowRun,
  publishPlanForReview as publishPlanForReviewUseCase,
  submitPlanDecision,
  commitRunFailure,
  compilePlanningInput,
  getCurrentApproval,
  getProductRun,
  getRunPlans,
  getSessionMessages,
} from "@chat/application";
import { SYSTEM_NOTE_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";

const PRINCIPAL = "usr_debug" as PrincipalId;
const OTHER = "usr_other" as PrincipalId;

let idCounter = 0;
function testIds(): IdFactory {
  const next = (prefix: string) => `${prefix}_${(++idCounter).toString().padStart(6, "0")}`;
  return {
    session: () => next("psn") as ReturnType<IdFactory["session"]>,
    message: () => next("msg") as ReturnType<IdFactory["message"]>,
    run: () => next("run") as ReturnType<IdFactory["run"]>,
    attempt: () => next("att") as ReturnType<IdFactory["attempt"]>,
    plan: () => next("pln") as ReturnType<IdFactory["plan"]>,
    planRevision: () => next("plr") as ReturnType<IdFactory["planRevision"]>,
    revisionInput: () => next("rin") as ReturnType<IdFactory["revisionInput"]>,
    approval: () => next("apr") as ReturnType<IdFactory["approval"]>,
    decision: () => next("dec") as ReturnType<IdFactory["decision"]>,
    executionContract: () => next("exc") as ReturnType<IdFactory["executionContract"]>,
    executionCandidate: () => next("xcd") as ReturnType<IdFactory["executionCandidate"]>,
    validationResult: () => next("val") as ReturnType<IdFactory["validationResult"]>,
    artifact: () => next("art") as ReturnType<IdFactory["artifact"]>,
    outbox: () => next("obx") as ReturnType<IdFactory["outbox"]>,
  };
}

let clock = 0;
const now = (): string =>
  new Date(Date.parse("2026-08-07T12:00:00.000Z") + clock++ * 1000).toISOString();

const cmd = (() => {
  let n = 0;
  return () => `cmd_${(++n).toString().padStart(6, "0")}` as CommandId;
})();

async function testDeps(
  nowOverride: () => string = now,
): Promise<{ deps: ApplicationDeps; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "chat-app-"));
  const filePath = join(dir, "chat-product-store.v1.json");
  const store = await JsonProductStore.open({ filePath, now: nowOverride });
  return { deps: { store, now: nowOverride, ids: testIds() }, filePath };
}

async function reopenDeps(filePath: string): Promise<ApplicationDeps> {
  const store = await JsonProductStore.open({ filePath, now });
  return { store, now, ids: testIds() };
}

const planContent: PlanContent = {
  objective: "整理项目进展并生成Markdown周报",
  summary: "先归纳输入，再产出周报，包含风险与下一步",
  assumptions: [{ statement: "输入包含本周进展", source: "user" }],
  openQuestions: [],
  steps: [
    {
      stepId: "step-1",
      title: "整理进展",
      purpose: "结构化原始输入",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "要点清单",
      successCriteria: ["覆盖全部输入要点"],
      requestedCapabilities: [],
      risk: "low",
    },
    {
      stepId: "step-2",
      title: "生成周报",
      purpose: "产出Markdown周报",
      dependsOn: ["step-1"],
      inputRefs: [],
      expectedOutput: "Markdown周报",
      successCriteria: ["包含风险与下一步"],
      requestedCapabilities: [],
      risk: "medium",
    },
  ],
  completionCriteria: ["周报包含风险与下一步"],
  warnings: [],
};

async function seedSessionWithMessage(deps: ApplicationDeps, text = "根据我的进展生成周报") {
  const { session } = await createProductSession(deps, {
    principalId: PRINCIPAL,
    commandId: cmd(),
    payload: {},
  });
  const submitted = await submitUserMessage(deps, {
    principalId: PRINCIPAL,
    sessionId: session.sessionId,
    commandId: cmd(),
    payload: { text },
  });
  return { session, ...submitted };
}

/** 测试也必须走正式Planning Input -> Attempt -> Plan发布绑定，禁止无Attempt捷径。 */
async function publishPlanForReview(
  deps: ApplicationDeps,
  input: { productRunId: ProductRunId; commandId: CommandId; content: PlanContent },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const planRevision =
    Object.values(snapshot.entities.plans).filter(
      (plan) => plan.productRunId === input.productRunId,
    ).length + 1;
  const planning = await compilePlanningInput(deps, {
    commandId: cmd(),
    productRunId: input.productRunId,
    planRevision,
  });
  return publishPlanForReviewUseCase(deps, {
    ...input,
    attemptId: planning.attemptId,
    expectedRunRevision: planning.inputRunRevision,
    inputManifestSha256: planning.inputManifestSha256,
  });
}

describe("CreateProductSession + SubmitUserMessage", () => {
  it("原子提交Message + Run + Receipt + Outbox，重启后恢复", async () => {
    const { deps, filePath } = await testDeps();
    const { message, run } = await seedSessionWithMessage(deps);
    expect(run.status).toBe("pending");
    expect(run.phase).toBe("queued");

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const outboxEntries = Object.values(snapshot.outbox);
    expect(outboxEntries).toHaveLength(1);
    expect(outboxEntries[0]?.kind).toBe("workflow_start");
    expect(outboxEntries[0]?.status).toBe("pending");
    expect(Object.keys(snapshot.commandReceipts)).toHaveLength(2);

    // API重启：重新open同一文件，已提交事实全部可读
    const restarted = await reopenDeps(filePath);
    const { messages } = await getSessionMessages(restarted, {
      principalId: PRINCIPAL,
      sessionId: message.sessionId,
    });
    expect(messages.items).toHaveLength(1);
    expect(messages.items[0]?.content.text).toBe("根据我的进展生成周报");
    const { run: recoveredRun } = await getProductRun(restarted, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
    });
    expect(recoveredRun.status).toBe("pending");
  });

  it("相同commandId + 相同payload重试返回原结果，不新增Message/Run", async () => {
    const { deps } = await testDeps();
    const { session } = await createProductSession(deps, {
      principalId: PRINCIPAL,
      commandId: cmd(),
      payload: {},
    });
    const commandId = cmd();
    const first = await submitUserMessage(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
      commandId,
      payload: { text: "hi" },
    });
    const second = await submitUserMessage(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
      commandId,
      payload: { text: "hi" },
    });
    expect(second.message.messageId).toBe(first.message.messageId);
    expect(second.run.productRunId).toBe(first.run.productRunId);
    const { messages } = await getSessionMessages(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
    });
    expect(messages.items).toHaveLength(1);
  });

  it("相同commandId + 不同payload返回COMMAND_ID_REUSED", async () => {
    const { deps } = await testDeps();
    const { session } = await createProductSession(deps, {
      principalId: PRINCIPAL,
      commandId: cmd(),
      payload: {},
    });
    const commandId = cmd();
    await submitUserMessage(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
      commandId,
      payload: { text: "hi" },
    });
    await expect(
      submitUserMessage(deps, {
        principalId: PRINCIPAL,
        sessionId: session.sessionId,
        commandId,
        payload: { text: "different" },
      }),
    ).rejects.toBeInstanceOf(CommandIdReusedError);
  });

  it("同一Session允许Planning与Note各自形成独立未终态Run和Outbox", async () => {
    const { deps } = await testDeps();
    const { session } = await createProductSession(deps, {
      principalId: PRINCIPAL,
      commandId: cmd(),
      payload: {},
    });
    const planning = await submitUserMessage(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
      commandId: cmd(),
      payload: { text: "第一项工作" },
    });

    const { snapshot: beforeNote } = await deps.store.read({ kind: "committedSnapshot" });
    const noteRevision =
      beforeNote.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
    if (noteRevision === undefined) throw new Error("测试Fixture缺少Note Definition");
    const note = await submitUserMessage(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
      commandId: cmd(),
      payload: {
        text: "把这一项保存为笔记",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: noteRevision.workflowDefinitionRevisionId,
          definitionSha256: noteRevision.definitionSha256,
        },
      },
    });

    const { messages } = await getSessionMessages(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
    });
    expect(messages.items.map((message) => message.content.text)).toEqual([
      "第一项工作",
      "把这一项保存为笔记",
    ]);
    expect(planning.run.productRunId).not.toBe(note.run.productRunId);
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[planning.run.productRunId]).toMatchObject({
      runKind: "planning",
    });
    expect(snapshot.entities.runs[note.run.productRunId]).toMatchObject({
      runKind: "note_capture",
    });
    expect(
      Object.values(snapshot.outbox).filter(
        (entry) => entry.kind === "workflow_start" && entry.status === "pending",
      ),
    ).toHaveLength(2);
  });

  it("本地旧版本Workflow不可恢复时原子收敛Run、Attempt与Outbox并保留消息", async () => {
    const { deps } = await testDeps();
    const { session, message, run } = await seedSessionWithMessage(deps);
    const commandId = cmd();
    const input = {
      commandId,
      productRunId: run.productRunId,
      errorCode: "workflow.version_incompatible",
      summary: "本地代码版本已变化，旧后台运行无法安全恢复",
    };
    await settleIncompatibleWorkflowRun(deps, input);
    await settleIncompatibleWorkflowRun(deps, input);

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[run.productRunId]).toMatchObject({
      status: "failed",
      phase: "queued",
      failure: { code: "workflow.version_incompatible" },
    });
    expect(snapshot.entities.messages[message.messageId]?.content.text).toBe(
      "根据我的进展生成周报",
    );
    expect(
      Object.values(snapshot.entities.attempts).find(
        (attempt) => attempt.productRunId === run.productRunId,
      ),
    ).toMatchObject({ outcome: "failure", errorCode: "workflow.version_incompatible" });
    expect(
      Object.values(snapshot.outbox).filter(
        (entry) => entry.kind === "workflow_start" && entry.productRunId === run.productRunId,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "workflow_start",
        status: "failed_terminal",
        lastErrorCode: "workflow.version_incompatible",
      }),
    ]);

    // 旧Run已经明确终结，同一Session可以提交新的工作；不需要清空Product Store。
    await expect(
      submitUserMessage(deps, {
        principalId: PRINCIPAL,
        sessionId: session.sessionId,
        commandId: cmd(),
        payload: { text: "使用当前代码重新开始" },
      }),
    ).resolves.toMatchObject({ run: { status: "pending" } });
  });
});

describe("PublishPlanForReview + SubmitPlanDecision", () => {
  it("发布v1进入waiting_human；修改意见产生v2并保留v1历史", async () => {
    const { deps } = await testDeps();
    const { run } = await seedSessionWithMessage(deps);

    const v1 = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    expect(v1.plan.planRevision).toBe(1);
    expect(v1.run.status).toBe("waiting_human");
    expect(v1.run.phase).toBe("plan_review");
    expect(v1.run.allowedActions).toEqual(["request_revision", "approve", "reject"]);

    const decided = await submitPlanDecision(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
      commandId: cmd(),
      expectedRunRevision: v1.run.revision,
      payload: {
        approvalRequestId: v1.approval.approvalRequestId,
        planId: v1.plan.planId,
        planRevision: 1,
        planSha256: v1.plan.sha256,
        kind: "request_revision",
        revisionInstruction: "把风险单独成节，并增加下周三个行动项",
      },
    });
    expect(decided.run.status).toBe("running");
    expect(decided.run.phase).toBe("planning");

    const v2 = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: { ...planContent, summary: "风险单独成节" },
    });
    expect(v2.plan.planRevision).toBe(2);
    expect(v2.plan.planId).toBe(v1.plan.planId);
    expect(v2.plan.sha256).not.toBe(v1.plan.sha256);

    // v1仍可作为历史事实读取，状态superseded，不可再批准
    const { plans } = await getRunPlans(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
    });
    expect(plans).toHaveLength(2);
    expect(plans[0]?.status).toBe("superseded");
    expect(plans[1]?.status).toBe("under_review");

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(Object.values(snapshot.entities.revisionInputs)).toHaveLength(1);
    const resumeEntries = Object.values(snapshot.outbox).filter(
      (entry) => entry.kind === "workflow_resume",
    );
    expect(resumeEntries).toHaveLength(1);
    expect(resumeEntries[0]?.decisionId).toBe(decided.decision.decisionId);
  });

  it("approve进入executing；reject进入cancelled/rejected", async () => {
    const { deps } = await testDeps();
    const { run } = await seedSessionWithMessage(deps);
    const v1 = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    const approved = await submitPlanDecision(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
      commandId: cmd(),
      expectedRunRevision: v1.run.revision,
      payload: {
        approvalRequestId: v1.approval.approvalRequestId,
        planId: v1.plan.planId,
        planRevision: 1,
        planSha256: v1.plan.sha256,
        kind: "approve",
      },
    });
    expect(approved.run.status).toBe("running");
    expect(approved.run.phase).toBe("executing");
    expect(approved.run.allowedActions).toEqual([]);
    expect(
      (
        await getCurrentApproval(deps, {
          principalId: PRINCIPAL,
          productRunId: run.productRunId,
        })
      ).approval,
    ).toBeNull();

    // 第二个Run走reject路径
    const { run: run2 } = await seedSessionWithMessage(deps, "另一条消息");
    const r2v1 = await publishPlanForReview(deps, {
      productRunId: run2.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    const rejected = await submitPlanDecision(deps, {
      principalId: PRINCIPAL,
      productRunId: run2.productRunId,
      commandId: cmd(),
      expectedRunRevision: r2v1.run.revision,
      payload: {
        approvalRequestId: r2v1.approval.approvalRequestId,
        planId: r2v1.plan.planId,
        planRevision: 1,
        planSha256: r2v1.plan.sha256,
        kind: "reject",
        reason: "不需要了",
      },
    });
    expect(rejected.run.status).toBe("cancelled");
    expect(rejected.run.phase).toBe("rejected");
  });

  it("旧revision、错误Hash、已决定、错误Principal、错误CAS全部失败关闭", async () => {
    const { deps } = await testDeps();
    const { run } = await seedSessionWithMessage(deps);
    const v1 = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    const basePayload = {
      approvalRequestId: v1.approval.approvalRequestId,
      planId: v1.plan.planId,
      planRevision: 1,
      planSha256: v1.plan.sha256,
      kind: "approve" as const,
    };

    // 错误CAS
    await expect(
      submitPlanDecision(deps, {
        principalId: PRINCIPAL,
        productRunId: run.productRunId,
        commandId: cmd(),
        expectedRunRevision: v1.run.revision + 99,
        payload: basePayload,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    // 错误Hash
    await expect(
      submitPlanDecision(deps, {
        principalId: PRINCIPAL,
        productRunId: run.productRunId,
        commandId: cmd(),
        expectedRunRevision: v1.run.revision,
        payload: { ...basePayload, planSha256: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "plan_hash_conflict" });

    // 错误Principal
    await expect(
      submitPlanDecision(deps, {
        principalId: OTHER,
        productRunId: run.productRunId,
        commandId: cmd(),
        expectedRunRevision: v1.run.revision,
        payload: basePayload,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // 正常approve后，旧Approval再次决定失败
    const approved = await submitPlanDecision(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
      commandId: cmd(),
      expectedRunRevision: v1.run.revision,
      payload: basePayload,
    });
    await expect(
      submitPlanDecision(deps, {
        principalId: PRINCIPAL,
        productRunId: run.productRunId,
        commandId: cmd(),
        expectedRunRevision: approved.run.revision,
        payload: basePayload,
      }),
    ).rejects.toMatchObject({ code: "approval_already_decided" });
  });

  it("两个并发Decision只有一个提交成功", async () => {
    const { deps } = await testDeps();
    const { run } = await seedSessionWithMessage(deps);
    const v1 = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    const payload = {
      approvalRequestId: v1.approval.approvalRequestId,
      planId: v1.plan.planId,
      planRevision: 1,
      planSha256: v1.plan.sha256,
      kind: "approve" as const,
    };
    const results = await Promise.allSettled([
      submitPlanDecision(deps, {
        principalId: PRINCIPAL,
        productRunId: run.productRunId,
        commandId: cmd(),
        expectedRunRevision: v1.run.revision,
        payload,
      }),
      submitPlanDecision(deps, {
        principalId: PRINCIPAL,
        productRunId: run.productRunId,
        commandId: cmd(),
        expectedRunRevision: v1.run.revision,
        payload,
      }),
    ]);
    const succeeded = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(Object.keys(snapshot.entities.decisions)).toHaveLength(1);
  });

  it("拒绝输入证据不匹配或Run CAS过期的Planner候选", async () => {
    const { deps } = await testDeps();
    const { run } = await seedSessionWithMessage(deps);
    const planning = await compilePlanningInput(deps, {
      commandId: cmd(),
      productRunId: run.productRunId,
      planRevision: 1,
    });

    await expect(
      publishPlanForReviewUseCase(deps, {
        productRunId: run.productRunId,
        commandId: cmd(),
        content: planContent,
        attemptId: planning.attemptId,
        expectedRunRevision: planning.inputRunRevision,
        inputManifestSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    await expect(
      publishPlanForReviewUseCase(deps, {
        productRunId: run.productRunId,
        commandId: cmd(),
        content: planContent,
        attemptId: planning.attemptId,
        expectedRunRevision: planning.inputRunRevision + 1,
        inputManifestSha256: planning.inputManifestSha256,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(Object.keys(snapshot.entities.plans)).toHaveLength(0);
  });

  it("Approval超过expiresAt后原子过期并失败关闭，重复命令保持同一结果", async () => {
    let instant = Date.parse("2026-08-07T12:00:00.000Z");
    const controlledNow = () => new Date(instant).toISOString();
    const { deps } = await testDeps(controlledNow);
    const { run } = await seedSessionWithMessage(deps);
    const published = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    expect(Date.parse(published.approval.expiresAt)).toBeGreaterThan(instant);

    instant = Date.parse(published.approval.expiresAt) + 1;
    const commandId = cmd();
    const input = {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
      commandId,
      expectedRunRevision: published.run.revision,
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: published.plan.planRevision,
        planSha256: published.plan.sha256,
        kind: "approve" as const,
      },
    };
    await expect(submitPlanDecision(deps, input)).rejects.toMatchObject({
      code: "approval_expired",
    });
    await expect(submitPlanDecision(deps, input)).rejects.toMatchObject({
      code: "approval_expired",
    });

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const storedRun = snapshot.entities.runs[run.productRunId];
    expect(storedRun?.runKind).toBe("planning");
    if (storedRun?.runKind !== "planning") throw new Error("fixture必须产生Planning Run");
    expect(storedRun.status).toBe("failed");
    expect(storedRun.currentApprovalRequestId).toBeUndefined();
    expect(snapshot.entities.approvalRequests[published.approval.approvalRequestId]?.status).toBe(
      "expired",
    );
    expect(Object.keys(snapshot.entities.decisions)).toHaveLength(0);
    expect(
      Object.values(snapshot.outbox).filter((entry) => entry.kind === "workflow_resume"),
    ).toHaveLength(0);
  });

  it("相同Decision commandId重放只产生一个Decision和一个Resume Outbox", async () => {
    const { deps } = await testDeps();
    const { run } = await seedSessionWithMessage(deps);
    const v1 = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    const commandId = cmd();
    const input = {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
      commandId,
      expectedRunRevision: v1.run.revision,
      payload: {
        approvalRequestId: v1.approval.approvalRequestId,
        planId: v1.plan.planId,
        planRevision: 1,
        planSha256: v1.plan.sha256,
        kind: "approve" as const,
      },
    };
    const first = await submitPlanDecision(deps, input);
    const second = await submitPlanDecision(deps, input);
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(Object.keys(snapshot.entities.decisions)).toHaveLength(1);
    expect(
      Object.values(snapshot.outbox).filter((entry) => entry.kind === "workflow_resume"),
    ).toHaveLength(1);
  });

  it("规划修订达到5版后第6次发布失败关闭", async () => {
    const { deps } = await testDeps();
    const { run } = await seedSessionWithMessage(deps);
    let current = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    for (let i = 2; i <= 5; i++) {
      const decided = await submitPlanDecision(deps, {
        principalId: PRINCIPAL,
        productRunId: run.productRunId,
        commandId: cmd(),
        expectedRunRevision: current.run.revision,
        payload: {
          approvalRequestId: current.approval.approvalRequestId,
          planId: current.plan.planId,
          planRevision: current.plan.planRevision,
          planSha256: current.plan.sha256,
          kind: "request_revision",
          revisionInstruction: `第${String(i)}次修改`,
        },
      });
      expect(decided.run.phase).toBe("planning");
      current = await publishPlanForReview(deps, {
        productRunId: run.productRunId,
        commandId: cmd(),
        content: planContent,
      });
      expect(current.plan.planRevision).toBe(i);
    }
    // 第5版仍在审核；用户再次要求修改后，第6次发布失败
    const fifth = await submitPlanDecision(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
      commandId: cmd(),
      expectedRunRevision: current.run.revision,
      payload: {
        approvalRequestId: current.approval.approvalRequestId,
        planId: current.plan.planId,
        planRevision: 5,
        planSha256: current.plan.sha256,
        kind: "request_revision",
        revisionInstruction: "第6次修改",
      },
    });
    expect(fifth.run.phase).toBe("planning");
    await expect(
      publishPlanForReview(deps, {
        productRunId: run.productRunId,
        commandId: cmd(),
        content: planContent,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });
});

describe("查询用例", () => {
  it("Message分页使用服务端cursor，顺序由sessionSequence固定", async () => {
    const { deps } = await testDeps();
    const { session } = await createProductSession(deps, {
      principalId: PRINCIPAL,
      commandId: cmd(),
      payload: {},
    });
    for (let i = 1; i <= 3; i++) {
      const submitted = await submitUserMessage(deps, {
        principalId: PRINCIPAL,
        sessionId: session.sessionId,
        commandId: cmd(),
        payload: { text: `消息${String(i)}` },
      });
      if (i < 3) {
        await compilePlanningInput(deps, {
          commandId: cmd(),
          productRunId: submitted.run.productRunId,
          planRevision: 1,
        });
        await commitRunFailure(deps, {
          commandId: cmd(),
          productRunId: submitted.run.productRunId,
          errorCode: "test.completed_boundary",
          summary: "分页Fixture结束前一个Run",
        });
      }
    }
    const page1 = await getSessionMessages(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
      limit: 2,
    });
    expect(page1.messages.items).toHaveLength(2);
    expect(page1.messages.items[0]?.sessionSequence).toBe(1);
    expect(page1.messages.nextCursor).toBeDefined();
    const page2 = await getSessionMessages(deps, {
      principalId: PRINCIPAL,
      sessionId: session.sessionId,
      cursor: page1.messages.nextCursor,
      limit: 2,
    });
    expect(page2.messages.items).toHaveLength(1);
    expect(page2.messages.items[0]?.sessionSequence).toBe(3);
    expect(page2.messages.nextCursor).toBeUndefined();
  });

  it("非法、非规范或带尾随内容的cursor以validation_failed拒绝", async () => {
    const { deps } = await testDeps();
    const { session } = await createProductSession(deps, {
      principalId: PRINCIPAL,
      commandId: cmd(),
      payload: {},
    });
    await expect(
      getSessionMessages(deps, {
        principalId: PRINCIPAL,
        sessionId: session.sessionId,
        cursor: "not-a-cursor",
      }),
    ).rejects.toBeInstanceOf(ApplicationError);
    for (const cursor of [
      Buffer.from("seq:1junk", "utf8").toString("base64url"),
      `${Buffer.from("seq:1", "utf8").toString("base64url")}=`,
      Buffer.from("seq:01", "utf8").toString("base64url"),
      Buffer.from("seq:1.5", "utf8").toString("base64url"),
    ]) {
      await expect(
        getSessionMessages(deps, {
          principalId: PRINCIPAL,
          sessionId: session.sessionId,
          cursor,
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
  });

  it("GetCurrentApproval返回当前open Approval或null", async () => {
    const { deps } = await testDeps();
    const { run } = await seedSessionWithMessage(deps);
    const before = await getCurrentApproval(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
    });
    expect(before.approval).toBeNull();
    const v1 = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    const after = await getCurrentApproval(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
    });
    expect(after.approval?.approvalRequestId).toBe(v1.approval.approvalRequestId);
  });

  it("到达expiresAt后Query明确投影expired且不再返回可操作动作", async () => {
    let instant = Date.parse("2026-08-07T12:00:00.000Z");
    const controlledNow = () => new Date(instant).toISOString();
    const { deps } = await testDeps(controlledNow);
    const { run } = await seedSessionWithMessage(deps);
    const published = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: cmd(),
      content: planContent,
    });
    instant = Date.parse(published.approval.expiresAt);

    const approval = await getCurrentApproval(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
    });
    const projectedRun = await getProductRun(deps, {
      principalId: PRINCIPAL,
      productRunId: run.productRunId,
    });
    expect(approval.approval?.status).toBe("expired");
    expect(projectedRun.run.allowedActions).toEqual([]);

    // Query只做时间投影，不在读取路径偷偷改写Product Store。
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.approvalRequests[published.approval.approvalRequestId]?.status).toBe(
      "open",
    );
  });
});
