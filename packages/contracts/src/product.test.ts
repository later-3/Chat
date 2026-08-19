import { describe, expect, it } from "vitest";
import {
  commandReceiptSchema,
  decisionSchema,
  outboxEntrySchema,
  planRevisionSchema,
  productRunSchema,
  productSessionSchema,
  type PlanContent,
} from "./product.js";
import { createEmptySnapshot, productSnapshotSchema } from "./product-store.js";
import {
  messageResponseSchema,
  runDtoSchema,
  submitDecisionPayloadSchema,
  submitMessagePayloadSchema,
} from "./product-api.js";
import {
  commitConfirmedNoteRuntimeRequestSchema,
  commitExecutionResultRequestSchema,
  loadNoteDecisionRuntimeRequestSchema,
  prepareNoteCaptureInputRuntimeRequestSchema,
  prepareNoteCaptureInputRuntimeResponseSchema,
  persistValidationResultRequestSchema,
  publishNoteCandidateRuntimeRequestSchema,
} from "./internal-runtime.js";

const NOW = "2026-08-07T12:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const planContent: PlanContent = {
  objective: "整理项目进展并生成周报",
  summary: "先归纳输入，再产出Markdown周报",
  assumptions: [{ statement: "输入包含本周进展", source: "user" }],
  openQuestions: [],
  steps: [
    {
      stepId: "step-1",
      title: "整理进展",
      purpose: "把原始输入整理为结构化要点",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "要点清单",
      successCriteria: ["覆盖全部输入要点"],
      requestedCapabilities: [],
      risk: "low",
    },
  ],
  completionCriteria: ["周报包含风险与下一步"],
  warnings: [],
};

describe("product entity contracts", () => {
  it("接受合法实体并拒绝未知字段（strict失败关闭）", () => {
    const session = productSessionSchema.parse({
      schemaVersion: "product-session.v1",
      sessionId: "psn_1",
      ownerPrincipalId: "usr_debug",
      status: "active",
      lastMessageSequence: 0,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(session.sessionId).toBe("psn_1");

    expect(() =>
      productSessionSchema.parse({
        ...session,
        workflowRunId: "should-not-exist",
      }),
    ).toThrow();
  });

  it("Plan Revision永久保留并携带Hash", () => {
    const plan = planRevisionSchema.parse({
      schemaVersion: "plan-revision.v1",
      planRevisionId: "plr_1",
      planId: "pln_1",
      productRunId: "run_1",
      planningAttemptId: "att_1",
      planRevision: 1,
      status: "under_review",
      content: planContent,
      sha256: HASH_A,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(plan.sha256).toBe(HASH_A);
  });

  it("Decision必须绑定approvalRequestId + planId + planRevision + planSha256", () => {
    const base = {
      schemaVersion: "decision.v1",
      decisionId: "dec_1",
      approvalRequestId: "apr_1",
      productRunId: "run_1",
      planId: "pln_1",
      planRevision: 2,
      planSha256: HASH_B,
      kind: "approve",
      principalId: "usr_debug",
      commandId: "cmd_1",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(decisionSchema.parse(base).kind).toBe("approve");
    for (const field of ["approvalRequestId", "planId", "planRevision", "planSha256"]) {
      const broken = { ...base, [field]: undefined };
      expect(() => decisionSchema.parse(broken), field).toThrow();
    }
  });

  it("Product Run拒绝未知status/phase组合以外的值", () => {
    const base = {
      schemaVersion: "product-run.v3",
      runKind: "planning",
      productRunId: "run_1",
      sessionId: "psn_1",
      sourceMessageId: "msg_1",
      workflowViewDefinitionId: "wvd_planninglegacyv1",
      runnerFamily: "legacy-planning.v1",
      runnerBundleVersion: "legacy-planning.bundle.v1",
      status: "waiting_human",
      phase: "plan_review",
      maxPlanRevisions: 5,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(productRunSchema.parse(base).phase).toBe("plan_review");
    expect(() => productRunSchema.parse({ ...base, status: "done" })).toThrow();
    expect(() => productRunSchema.parse({ ...base, phase: "thinking" })).toThrow();
  });

  it("Command Receipt与Outbox不保存Hook Token或正文", () => {
    const receipt = commandReceiptSchema.parse({
      commandId: "cmd_1",
      commandType: "SubmitUserMessage",
      requestSha256: HASH_A,
      resultRefs: { messageId: "msg_1", productRunId: "run_1" },
      committedStoreRevision: 3,
      createdAt: NOW,
    });
    expect(receipt.resultRefs["productRunId"]).toBe("run_1");

    const entry = outboxEntrySchema.parse({
      schemaVersion: "outbox-entry.v1",
      outboxId: "obx_1",
      kind: "workflow_resume",
      status: "pending",
      productRunId: "run_1",
      approvalRequestId: "apr_1",
      decisionId: "dec_1",
      dispatchAttempts: 0,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(entry.status).toBe("pending");
    const noteResume = outboxEntrySchema.parse({
      ...entry,
      outboxId: "obx_2",
      approvalRequestId: undefined,
      decisionId: undefined,
      hookNoteCandidateId: "ntc_1",
      noteCandidateId: "ntc_1",
      noteDecisionId: "ntd_1",
    });
    expect(noteResume.kind).toBe("workflow_resume");
    expect(() =>
      outboxEntrySchema.parse({
        ...entry,
        outboxId: "obx_3",
        hookNoteCandidateId: "ntc_1",
        noteCandidateId: "ntc_1",
        noteDecisionId: "ntd_1",
      }),
    ).toThrow();
    expect(() => outboxEntrySchema.parse({ ...entry, hookToken: "secret" })).toThrow();
  });
});

describe("product snapshot contract", () => {
  it("空快照合法且集合为Map形态", () => {
    const snapshot = productSnapshotSchema.parse(createEmptySnapshot(NOW));
    expect(snapshot.storeRevision).toBe(0);
    expect(Object.keys(snapshot.entities.sessions)).toHaveLength(0);
  });

  it("拒绝未知顶层字段与未知Schema版本", () => {
    const snapshot = createEmptySnapshot(NOW);
    expect(() => productSnapshotSchema.parse({ ...snapshot, extra: {} })).toThrow();
    expect(() =>
      productSnapshotSchema.parse({ ...snapshot, schemaVersion: "chat-product-store.v0" }),
    ).toThrow();
  });
});

describe("product api command payloads", () => {
  it("私有验证与Product Commit合同不接受Workflow伪造结论或正文", () => {
    const validation = {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_1",
      productRunId: "run_1",
      executionContractId: "exc_1",
      executionCandidateId: "xcd_1",
      strictEvidence: true,
    };
    expect(persistValidationResultRequestSchema.parse(validation)).toEqual(validation);
    expect(() =>
      persistValidationResultRequestSchema.parse({
        ...validation,
        outcome: "pass",
        failures: [],
      }),
    ).toThrow();

    const commit = {
      schemaVersion: validation.schemaVersion,
      commandId: validation.commandId,
      productRunId: validation.productRunId,
      executionContractId: validation.executionContractId,
      executionCandidateId: validation.executionCandidateId,
      validationResultId: "val_1",
    };
    expect(commitExecutionResultRequestSchema.parse(commit)).toEqual(commit);
    expect(() =>
      commitExecutionResultRequestSchema.parse({
        ...commit,
        renderedMarkdown: "绕过Candidate注入的正文",
      }),
    ).toThrow();
  });

  it("Note Runtime私有合同不接受伪造source/sourceRefs且Decision加载不访问DTO union shape", () => {
    const proposed = {
      title: "候选笔记",
      kind: "general",
      contentMarkdown: "候选正文",
      tagLabels: [],
    };
    const request = {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_notepublish1",
      productRunId: "run_notepublish1",
      proposed,
    };
    expect(publishNoteCandidateRuntimeRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      publishNoteCandidateRuntimeRequestSchema.parse({
        ...request,
        sourceRefs: [],
      }),
    ).toThrow();
    expect(() =>
      publishNoteCandidateRuntimeRequestSchema.parse({
        ...request,
        source: { kind: "full_message" },
      }),
    ).toThrow();

    const prepare = {
      schemaVersion: "chat-internal-runtime.v1",
      productRunId: "run_notepublish1",
      workflowRunSpecId: "wrs_notepublish1",
    };
    expect(prepareNoteCaptureInputRuntimeRequestSchema.parse(prepare)).toEqual(prepare);
    expect(
      prepareNoteCaptureInputRuntimeResponseSchema.parse({
        ...prepare,
        source: {
          kind: "full_message",
          sourceMessageId: "msg_notepublish1",
          sourceMessageSha256: HASH_A,
        },
        sourceText: "Runtime只能读取Application派生的来源正文",
        defaultKind: "general",
        suggestedTagLabels: ["Runtime"],
      }).sourceText,
    ).toContain("Application");

    const load = {
      schemaVersion: "chat-internal-runtime.v1",
      productRunId: "run_notepublish1",
      workflowRunSpecId: "wrs_notepublish1",
      noteCandidateId: "ntc_notepublish1",
      noteDecisionId: "ntd_notepublish1",
    };
    expect(loadNoteDecisionRuntimeRequestSchema.parse(load)).toEqual(load);

    const commit = {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_notecommit1",
      productRunId: "run_notepublish1",
      noteCandidateId: "ntc_notepublish1",
    };
    expect(commitConfirmedNoteRuntimeRequestSchema.parse(commit)).toEqual(commit);
  });

  it("Message payload拒绝浏览器指定Provider/模型/Runtime参数", () => {
    expect(submitMessagePayloadSchema.parse({ text: "帮我写周报" }).text).toBe("帮我写周报");
    expect(() => submitMessagePayloadSchema.parse({ text: "hi", model: "qwen3.7-plus" })).toThrow();
    expect(() => submitMessagePayloadSchema.parse({ text: "hi", provider: "bailian" })).toThrow();
    expect(() => submitMessagePayloadSchema.parse({ text: "" })).toThrow();
  });

  it("Decision payload按kind约束revisionInstruction与reason", () => {
    const base = {
      approvalRequestId: "apr_1",
      planId: "pln_1",
      planRevision: 1,
      planSha256: HASH_A,
    };
    expect(() =>
      submitDecisionPayloadSchema.parse({ ...base, kind: "request_revision" }),
    ).toThrow();
    expect(
      submitDecisionPayloadSchema.parse({
        ...base,
        kind: "request_revision",
        revisionInstruction: "把风险单独成节",
      }).kind,
    ).toBe("request_revision");
    expect(() =>
      submitDecisionPayloadSchema.parse({ ...base, kind: "approve", revisionInstruction: "x" }),
    ).toThrow();
    expect(() =>
      submitDecisionPayloadSchema.parse({ ...base, kind: "approve", reason: "x" }),
    ).toThrow();
    expect(
      submitDecisionPayloadSchema.parse({ ...base, kind: "reject", reason: "不需要了" }).kind,
    ).toBe("reject");
  });

  it("Run DTO不携带Runtime私有身份", () => {
    const dto = runDtoSchema.parse({
      schemaVersion: "chat-product-api.v1",
      productRunId: "run_1",
      sessionId: "psn_1",
      sourceMessageId: "msg_1",
      runKind: "planning",
      status: "waiting_human",
      phase: "plan_review",
      currentPlan: { planId: "pln_1", planRevision: 1, status: "under_review", sha256: HASH_A },
      currentApprovalRequestId: "apr_1",
      maxPlanRevisions: 5,
      allowedActions: ["request_revision", "approve", "reject"],
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(dto.allowedActions).toContain("approve");
    expect(() => runDtoSchema.parse({ ...dto, workflowRunId: "wfr_1" })).toThrow();
  });

  it("精确Message Query只接受公开Message envelope", () => {
    const response = {
      message: {
        schemaVersion: "chat-product-api.v1",
        messageId: "msg_1",
        sessionId: "psn_1",
        sessionSequence: 1,
        role: "assistant",
        content: { format: "markdown", text: "正式回复" },
        sourceRunId: "run_1",
        sha256: HASH_A,
        createdAt: NOW,
      },
    };
    expect(messageResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      messageResponseSchema.parse({ ...response, workflowRunId: "private-runtime-id" }),
    ).toThrow();
  });
});
