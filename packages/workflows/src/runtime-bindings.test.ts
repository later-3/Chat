import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readSafeMemoryImportRuntimeEvidence,
  readSafePromptReviewRuntimeEvidence,
  RuntimeBindingError,
  RuntimeBindingStore,
} from "./runtime-bindings.js";
import {
  CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
  NOTE_CAPTURE_RUNNER_FAMILY,
} from "./definition-kernel-executor-registry.js";

const NOW = "2026-08-07T12:00:00.000Z";

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chat-bindings-"));
  return join(dir, "runtime-bindings.v1.json");
}

async function claimWorkflow(store: RuntimeBindingStore, workflowRunId = "wrun_a") {
  const intent = await store.claimStartIntent({
    productRunId: "run_1" as never,
    outboxId: "obx_1" as never,
    workflowDefinitionVersion: "planning-execution-workflow.v1",
    now: NOW,
  });
  expect(intent).toBe("claimed");
  return store.claimWorkflowBinding({
    productRunId: "run_1" as never,
    outboxId: "obx_1" as never,
    workflowRunId,
    workflowDefinitionVersion: "planning-execution-workflow.v1",
    now: NOW,
  });
}

async function claimDirectWorkflow(
  store: RuntimeBindingStore,
  input: {
    readonly productRunId?: string;
    readonly workflowRunId?: string;
    readonly outboxId?: string;
    readonly workflowRunSpecId?: string;
  } = {},
) {
  const productRunId = input.productRunId ?? "run_directbinding1";
  const workflowRunId = input.workflowRunId ?? "wrun_directbinding1";
  const outboxId = input.outboxId ?? "obx_directbinding1";
  const workflowRunSpecId = input.workflowRunSpecId ?? "wrs_directbinding1";
  const evidence = {
    runnerFamily: "direct-agent.v1" as never,
    runnerBundleVersion: "direct-agent.bundle.v1",
    workflowRunSpecId,
  } as const;
  expect(
    await store.claimStartIntent({
      productRunId: productRunId as never,
      outboxId: outboxId as never,
      workflowDefinitionVersion: "direct-agent.bundle.v1",
      ...evidence,
      now: NOW,
    }),
  ).toBe("claimed");
  await store.claimWorkflowBinding({
    productRunId: productRunId as never,
    outboxId: outboxId as never,
    workflowRunId,
    workflowDefinitionVersion: "direct-agent.bundle.v1",
    ...evidence,
    now: NOW,
  });
  return { productRunId, workflowRunId };
}

describe("RuntimeBindingStore", () => {
  it("缺失时初始化空映射并持久化0600", async () => {
    const filePath = await tempPath();
    await RuntimeBindingStore.open(filePath);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("已有Workflow耐久数据时禁止用空Binding覆盖丢失映射", async () => {
    const filePath = await tempPath();
    await expect(RuntimeBindingStore.open(filePath, { allowCreate: false })).rejects.toThrow(
      "已有耐久运行数据",
    );
  });

  it("同一productRunId重复认领幂等；不同workflowRunId冲突失败关闭", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    const first = await claimWorkflow(store);
    expect(first.alreadyExisted).toBe(false);
    const second = await store.claimWorkflowBinding({
      productRunId: "run_1" as never,
      outboxId: "obx_1" as never,
      workflowRunId: "wrun_a",
      workflowDefinitionVersion: "planning-execution-workflow.v1",
      now: NOW,
    });
    expect(second.alreadyExisted).toBe(true);
    await expect(
      store.claimWorkflowBinding({
        productRunId: "run_1" as never,
        outboxId: "obx_1" as never,
        workflowRunId: "wrun_b",
        workflowDefinitionVersion: "planning-execution-workflow.v1",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
  });

  it("Hook映射缺失、冲突与Resume状态流转", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    await claimWorkflow(store);
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
    await store.markResumeDispatching("apr_1" as never, NOW);
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
    await claimWorkflow(store);
    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getWorkflowBinding("run_1" as never)?.workflowRunId).toBe("wrun_a");
  });

  it("Configurable Planning绑定冻结RunSpec且拒绝重放时改标legacy", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    const evidence = {
      runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
      runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: "wrs_configurable1",
    } as const;
    await store.claimStartIntent({
      productRunId: "run_configurable1" as never,
      outboxId: "obx_configurable1" as never,
      workflowDefinitionVersion: "planning-execution-workflow.v2",
      ...evidence,
      now: NOW,
    });
    await store.claimWorkflowBinding({
      productRunId: "run_configurable1" as never,
      outboxId: "obx_configurable1" as never,
      workflowRunId: "wrun_configurable1",
      workflowDefinitionVersion: "planning-execution-workflow.v2",
      ...evidence,
      now: NOW,
    });

    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getWorkflowBinding("run_configurable1" as never)).toMatchObject(evidence);
    await expect(
      reopened.claimStartIntent({
        productRunId: "run_configurable1" as never,
        outboxId: "obx_configurable1" as never,
        workflowDefinitionVersion: "planning-execution-workflow.v2",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
  });

  it("v3历史Binding迁移为显式legacy family，保留私有Run与Hook映射", async () => {
    const filePath = await tempPath();
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: "runtime-bindings.v3",
        startIntents: {},
        workflows: {
          run_legacy1: {
            workflowRunId: "wrun_legacy1",
            workflowDefinitionVersion: "planning-execution-workflow.v2",
            startDispatchState: "started",
            createdAt: NOW,
          },
        },
        hooks: {
          apr_legacy1: {
            hookToken: "pdh-run_legacy1-1",
            productRunId: "run_legacy1",
            planRevision: 1,
            hookClaimState: "claimed",
            resumeDispatchState: "none",
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
        memoryImportStartIntents: {},
        memoryImportWorkflows: {},
        projectIntakeStartIntents: {},
        projectIntakeWorkflows: {},
      }),
    );
    const store = await RuntimeBindingStore.open(filePath);
    expect(store.getWorkflowBinding("run_legacy1" as never)).toMatchObject({
      workflowRunId: "wrun_legacy1",
      runnerFamily: "legacy-planning.v1",
      runnerBundleVersion: "legacy-planning.bundle.v1",
    });
    expect(store.getHookBinding("apr_legacy1" as never)?.hookToken).toBe("pdh-run_legacy1-1");
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      schemaVersion: "runtime-bindings.v7",
    });
  });

  it("v6 Binding原样迁移既有映射并初始化空Prompt Review第三族", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    await claimWorkflow(store);
    await store.claimHookBinding({
      approvalRequestId: "apr_v6migration1" as never,
      productRunId: "run_1" as never,
      planRevision: 1,
      hookToken: "pdh-v6migration1",
      now: NOW,
    });
    const legacy = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    legacy["schemaVersion"] = "runtime-bindings.v6";
    delete legacy["promptReviewHooks"];
    await writeFile(filePath, JSON.stringify(legacy));

    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getWorkflowBinding("run_1" as never)?.workflowRunId).toBe("wrun_a");
    expect(reopened.getHookBinding("apr_v6migration1" as never)?.hookToken).toBe(
      "pdh-v6migration1",
    );
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      schemaVersion: "runtime-bindings.v7",
      promptReviewHooks: {},
    });
  });

  it("Note family冻结RunSpec并以Candidate隔离Hook恢复状态", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    const evidence = {
      runnerFamily: NOTE_CAPTURE_RUNNER_FAMILY,
      runnerBundleVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: "wrs_notebinding1",
    } as const;
    await store.claimStartIntent({
      productRunId: "run_notebinding1" as never,
      outboxId: "obx_notebinding1" as never,
      workflowDefinitionVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
      ...evidence,
      now: NOW,
    });
    await store.claimWorkflowBinding({
      productRunId: "run_notebinding1" as never,
      outboxId: "obx_notebinding1" as never,
      workflowRunId: "wrun_notebinding1",
      workflowDefinitionVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
      ...evidence,
      now: NOW,
    });
    await store.claimNoteHookBinding({
      noteCandidateId: "ntc_notebinding1" as never,
      productRunId: "run_notebinding1" as never,
      candidateSequence: 1,
      hookToken: "ndh-run-notebinding1-1",
      now: NOW,
    });
    await store.markNoteResumeDispatching("ntc_notebinding1" as never, NOW);
    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getWorkflowBinding("run_notebinding1" as never)).toMatchObject(evidence);
    expect(reopened.getNoteHookBinding("ntc_notebinding1" as never)).toMatchObject({
      productRunId: "run_notebinding1",
      candidateSequence: 1,
      resumeDispatchState: "dispatching",
    });
    await expect(
      reopened.claimNoteHookBinding({
        noteCandidateId: "ntc_notebinding1" as never,
        productRunId: "run_notebinding1" as never,
        candidateSequence: 2,
        hookToken: "ndh-run-notebinding1-2",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
  });

  it("未决start意图与dispatching Resume重启后保持结果未知，禁止盲重试", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    expect(
      await store.claimStartIntent({
        productRunId: "run_unknown" as never,
        outboxId: "obx_unknown" as never,
        workflowDefinitionVersion: "planning-execution-workflow.v1",
        now: NOW,
      }),
    ).toBe("claimed");
    await store.claimStartIntent({
      productRunId: "run_bound" as never,
      outboxId: "obx_bound" as never,
      workflowDefinitionVersion: "planning-execution-workflow.v1",
      now: NOW,
    });
    await store.claimWorkflowBinding({
      productRunId: "run_bound" as never,
      outboxId: "obx_bound" as never,
      workflowRunId: "wrun_bound",
      workflowDefinitionVersion: "planning-execution-workflow.v1",
      now: NOW,
    });
    await store.claimHookBinding({
      approvalRequestId: "apr_unknown" as never,
      productRunId: "run_bound" as never,
      planRevision: 1,
      hookToken: "pdh-run-unknown-1",
      now: NOW,
    });
    await store.markResumeDispatching("apr_unknown" as never, NOW);

    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getStartState("run_unknown" as never)).toBe("outcome_unknown");
    expect(
      await reopened.claimStartIntent({
        productRunId: "run_unknown" as never,
        outboxId: "obx_unknown" as never,
        workflowDefinitionVersion: "planning-execution-workflow.v1",
        now: NOW,
      }),
    ).toBe("outcome_unknown");
    expect(reopened.getHookBinding("apr_unknown" as never)?.resumeDispatchState).toBe(
      "dispatching",
    );
  });

  it("Prompt Review按Request独立认领Hook，原子绑定Decision并抵抗并发、重启与冲突", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    const workflow = await claimDirectWorkflow(store);
    const firstReview = {
      promptReviewRequestId: "prr_bindingreview1" as never,
      productRunId: workflow.productRunId as never,
      startWorkflowRunId: workflow.workflowRunId,
      requestRevision: 1,
      reviewSha256: "a".repeat(64),
      hookToken: "prh-bindingreview1",
      now: NOW,
    } as const;
    expect(await store.claimPromptReviewHookBinding(firstReview)).toEqual({
      alreadyExisted: false,
    });
    expect(await store.claimPromptReviewHookBinding(firstReview)).toEqual({
      alreadyExisted: true,
    });
    await expect(
      store.claimPromptReviewHookBinding({ ...firstReview, reviewSha256: "b".repeat(64) }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
    await expect(
      store.claimPromptReviewHookBinding({
        ...firstReview,
        startWorkflowRunId: "wrun_different",
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);

    const decision = {
      promptReviewRequestId: firstReview.promptReviewRequestId,
      promptReviewDecisionId: "prd_bindingdecision1" as never,
      requestRevision: 1,
      reviewSha256: firstReview.reviewSha256,
      now: NOW,
    } as const;
    const concurrent = await Promise.all([
      store.claimPromptReviewResumeDispatch(decision),
      store.claimPromptReviewResumeDispatch(decision),
    ]);
    expect([...concurrent].sort()).toEqual(["claimed", "outcome_unknown"]);
    expect(store.getPromptReviewHookBinding(firstReview.promptReviewRequestId)).toMatchObject({
      promptReviewDecisionId: decision.promptReviewDecisionId,
      resumeDispatchState: "dispatching",
    });
    await expect(
      store.claimPromptReviewResumeDispatch({
        ...decision,
        promptReviewDecisionId: "prd_differentdecision" as never,
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
    await expect(
      store.claimPromptReviewResumeDispatch({ ...decision, reviewSha256: "b".repeat(64) }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
    await expect(
      store.markPromptReviewResumeDispatched({
        promptReviewRequestId: firstReview.promptReviewRequestId,
        promptReviewDecisionId: "prd_differentdecision" as never,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
    await store.markPromptReviewResumeDispatched({
      promptReviewRequestId: firstReview.promptReviewRequestId,
      promptReviewDecisionId: decision.promptReviewDecisionId,
      now: NOW,
    });
    expect(await store.claimPromptReviewResumeDispatch(decision)).toBe("already_dispatched");
    expect(await store.claimPromptReviewHookBinding(firstReview)).toEqual({
      alreadyExisted: true,
    });

    const secondReview = {
      ...firstReview,
      promptReviewRequestId: "prr_bindingreview2" as never,
      requestRevision: 2,
      reviewSha256: "c".repeat(64),
      hookToken: "prh-bindingreview2",
    } as const;
    await expect(
      store.claimPromptReviewHookBinding({
        ...secondReview,
        promptReviewRequestId: "prr_reusedhook" as never,
        hookToken: firstReview.hookToken,
      }),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
    expect(await store.claimPromptReviewHookBinding(secondReview)).toEqual({
      alreadyExisted: false,
    });
    const secondDecision = {
      promptReviewRequestId: secondReview.promptReviewRequestId,
      promptReviewDecisionId: "prd_bindingdecision2" as never,
      requestRevision: secondReview.requestRevision,
      reviewSha256: secondReview.reviewSha256,
      now: NOW,
    } as const;
    expect(await store.claimPromptReviewResumeDispatch(secondDecision)).toBe("claimed");
    await store.markPromptReviewResumeOutcomeUnknown({
      promptReviewRequestId: secondReview.promptReviewRequestId,
      promptReviewDecisionId: secondDecision.promptReviewDecisionId,
      now: NOW,
    });

    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getPromptReviewHookBinding(firstReview.promptReviewRequestId)).toMatchObject({
      resumeDispatchState: "dispatched",
      promptReviewDecisionId: decision.promptReviewDecisionId,
    });
    expect(reopened.getPromptReviewHookBinding(secondReview.promptReviewRequestId)).toMatchObject({
      resumeDispatchState: "outcome_unknown",
      promptReviewDecisionId: secondDecision.promptReviewDecisionId,
    });
    expect(await reopened.claimPromptReviewResumeDispatch(secondDecision)).toBe("outcome_unknown");

    const safeEvidence = readSafePromptReviewRuntimeEvidence({
      path: filePath,
      promptReviewRequestId: firstReview.promptReviewRequestId,
      productRunId: workflow.productRunId,
      requestRevision: firstReview.requestRevision,
      reviewSha256: firstReview.reviewSha256,
    });
    expect(safeEvidence).toMatchObject({
      status: "ok",
      entry: {
        promptReviewRequestId: firstReview.promptReviewRequestId,
        resumeDispatchState: "dispatched",
      },
    });
    expect(JSON.stringify(safeEvidence)).not.toContain(firstReview.hookToken);
    expect(JSON.stringify(safeEvidence)).not.toContain(workflow.workflowRunId);
  });

  it("Prompt Review Binding严格拒绝正文，并持久化failed_terminal终态", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    const workflow = await claimDirectWorkflow(store, {
      productRunId: "run_directbinding2",
      workflowRunId: "wrun_directbinding2",
      outboxId: "obx_directbinding2",
      workflowRunSpecId: "wrs_directbinding2",
    });
    const review = {
      promptReviewRequestId: "prr_bindingreview3" as never,
      productRunId: workflow.productRunId as never,
      startWorkflowRunId: workflow.workflowRunId,
      requestRevision: 1,
      reviewSha256: "d".repeat(64),
      hookToken: "prh-bindingreview3",
      now: NOW,
    } as const;
    await store.claimPromptReviewHookBinding(review);
    const decision = {
      promptReviewRequestId: review.promptReviewRequestId,
      promptReviewDecisionId: "prd_bindingdecision3" as never,
      requestRevision: review.requestRevision,
      reviewSha256: review.reviewSha256,
      now: NOW,
    } as const;
    await store.claimPromptReviewResumeDispatch(decision);
    await store.markPromptReviewResumeFailedTerminal({
      promptReviewRequestId: review.promptReviewRequestId,
      promptReviewDecisionId: decision.promptReviewDecisionId,
      now: NOW,
    });
    expect(await store.claimPromptReviewResumeDispatch(decision)).toBe("failed_terminal");

    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      promptReviewHooks: Record<string, Record<string, unknown>>;
    };
    expect(raw.promptReviewHooks[review.promptReviewRequestId]).not.toHaveProperty(
      "canonicalPayloadJson",
    );
    raw.promptReviewHooks[review.promptReviewRequestId]!["canonicalPayloadJson"] =
      '{"secret":"must-not-enter-binding"}';
    await writeFile(filePath, JSON.stringify(raw));
    await expect(RuntimeBindingStore.open(filePath)).rejects.toBeInstanceOf(RuntimeBindingError);
  });

  it("Memory Import回放复用严格Binding Schema且安全投影不暴露Workflow Run ID", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    await store.claimMemoryImportStartIntent({
      outboxId: "obx_import1" as never,
      memoryImportIntentId: "mii_import1" as never,
      memoryImportResultId: "mir_import1" as never,
      mode: "import",
      workflowDefinitionVersion: "memory-import-workflow.v1",
      now: NOW,
    });
    await store.claimMemoryImportWorkflowBinding({
      outboxId: "obx_import1" as never,
      memoryImportIntentId: "mii_import1" as never,
      memoryImportResultId: "mir_import1" as never,
      mode: "import",
      workflowRunId: "private-workflow-run-must-not-leak",
      workflowDefinitionVersion: "memory-import-workflow.v1",
      now: NOW,
    });
    const evidence = readSafeMemoryImportRuntimeEvidence({
      path: filePath,
      memoryImportIntentId: "mii_import1",
      memoryImportResultId: "mir_import1",
      outbox: [{ outboxId: "obx_import1", kind: "memory_import_start" }],
    });
    expect(evidence.status).toBe("ok");
    expect(JSON.stringify(evidence)).not.toContain("private-workflow-run-must-not-leak");

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    parsed["unexpected"] = "strict-schema-must-reject";
    await writeFile(filePath, JSON.stringify(parsed));
    expect(
      readSafeMemoryImportRuntimeEvidence({
        path: filePath,
        memoryImportIntentId: "mii_import1",
        memoryImportResultId: "mir_import1",
        outbox: [{ outboxId: "obx_import1", kind: "memory_import_start" }],
      }).status,
    ).toBe("invalid");
  });

  it("Project Intake的start与resume先落栅栏，重启后禁止重复派发", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    expect(
      await store.claimProjectIntakeStartIntent({
        projectCandidateId: "pca_candidate1" as never,
        outboxId: "obx_project1" as never,
        workflowDefinitionVersion: "project-intake-workflow.v1",
        now: NOW,
      }),
    ).toBe("claimed");
    await store.claimProjectIntakeWorkflowBinding({
      projectCandidateId: "pca_candidate1" as never,
      outboxId: "obx_project1" as never,
      workflowRunId: "private-project-workflow-run",
      workflowDefinitionVersion: "project-intake-workflow.v1",
      hookToken: "pih-pca_candidate1",
      now: NOW,
    });
    await store.markProjectIntakeResumeDispatching("pca_candidate1" as never, NOW);

    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getProjectIntakeStartState("pca_candidate1" as never)).toBe("exists");
    expect(
      await reopened.claimProjectIntakeStartIntent({
        projectCandidateId: "pca_candidate1" as never,
        outboxId: "obx_project1" as never,
        workflowDefinitionVersion: "project-intake-workflow.v1",
        now: NOW,
      }),
    ).toBe("already_started");
    expect(reopened.getProjectIntakeBinding("pca_candidate1" as never)?.resumeDispatchState).toBe(
      "dispatching",
    );
    await expect(
      reopened.markProjectIntakeResumeDispatching("pca_candidate1" as never, NOW),
    ).rejects.toBeInstanceOf(RuntimeBindingError);
  });

  it("Project Intake未确认start结果时重启后保持unknown", async () => {
    const filePath = await tempPath();
    const store = await RuntimeBindingStore.open(filePath);
    await store.claimProjectIntakeStartIntent({
      projectCandidateId: "pca_unknown1" as never,
      outboxId: "obx_unknown1" as never,
      workflowDefinitionVersion: "project-intake-workflow.v1",
      now: NOW,
    });
    await store.markProjectIntakeStartOutcomeUnknown("pca_unknown1" as never, NOW);

    const reopened = await RuntimeBindingStore.open(filePath);
    expect(reopened.getProjectIntakeStartState("pca_unknown1" as never)).toBe("outcome_unknown");
    expect(
      await reopened.claimProjectIntakeStartIntent({
        projectCandidateId: "pca_unknown1" as never,
        outboxId: "obx_unknown1" as never,
        workflowDefinitionVersion: "project-intake-workflow.v1",
        now: NOW,
      }),
    ).toBe("outcome_unknown");
  });
});
