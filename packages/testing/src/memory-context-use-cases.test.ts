import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compilePlanningInput,
  compileExecutionContract,
  createProductSession,
  beginPlanningContext,
  beginRunAttempt,
  MemoryBackendError,
  normalizeMemoryQueryResult,
  persistPlanningContextResult,
  preparePlanningMemoryContext,
  publishPlanForReview,
  stableMemoryBackendFailure,
  submitPlanDecision,
  submitUserMessage,
  type ApplicationDeps,
  type IdFactory,
  type MemoryBackendPort,
  type ProductStorePort,
} from "@chat/application";
import { SYSTEM_PLANNING_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import type {
  BeginPlanningContextResponse,
  MemoryBackendId,
  MemoryQueryExecutionResult,
  PlanContent,
  ProductSnapshot,
  TraceEventInput,
} from "@chat/contracts";
import { EXECUTOR_PROMPT_TEMPLATE_VERSION, MODEL_CONFIG_VERSION } from "@chat/contracts";
import { computeExecutionInputManifestSha256 } from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";

const NOW = "2026-08-08T01:00:00.000Z";

function ids(): IdFactory {
  let count = 0;
  const next = (prefix: string) => `${prefix}_mc${(++count).toString(36)}`;
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

function fakeBackend(query: MemoryBackendPort["query"]): MemoryBackendPort {
  return {
    describe: () => ({
      backendId: "mbk_memmy" as MemoryBackendId,
      displayName: "memmy 本地记忆",
      kind: "memmy",
      adapterContractVersion: "memmy-http-query.v1",
      configured: true,
      authMode: "none",
      credentialRevision: "none",
      configurationFingerprint: "a".repeat(64),
      capabilities: {
        query: true,
        tags: true,
        layers: ["L1", "L2", "L3", "Skill"],
        maxLimit: 20,
        maxContextBudget: 8192,
      },
    }),
    health: async () => ({ status: "ready" }),
    query,
  };
}

async function executeDispatch(
  deps: ApplicationDeps,
  backend: MemoryBackendPort,
  begun: BeginPlanningContextResponse,
  commandId: string,
) {
  if (begun.status !== "dispatch_required") throw new Error("缺少Memory Query dispatch");
  let result: MemoryQueryExecutionResult;
  try {
    const output = await backend.query({
      operationId: begun.query.memoryQueryId,
      productRunId: begun.query.productRunId,
      productSessionId: begun.query.productSessionId,
      query: begun.query.queryText,
      tags: begun.query.tags,
      layers: begun.query.layers,
      limit: begun.query.limit,
      contextBudget: begun.query.contextBudget,
    });
    result = normalizeMemoryQueryResult(begun.query, output);
  } catch (error) {
    result = { outcome: "failure", errorCode: stableMemoryBackendFailure(error) };
  }
  return persistPlanningContextResult(deps, {
    commandId: commandId as never,
    productRunId: begun.query.productRunId,
    attemptId: Object.values(
      (await deps.store.read({ kind: "committedSnapshot" })).snapshot.entities.attempts,
    ).find((attempt) => attempt.kind === "workflow")!.attemptId,
    memoryQueryId: begun.query.memoryQueryId,
    result,
  });
}

async function depsWith(
  backend: MemoryBackendPort,
  events: TraceEventInput[] = [],
): Promise<ApplicationDeps> {
  const dir = await mkdtemp(join(tmpdir(), "chat-memory-context-"));
  const store = await JsonProductStore.open({ filePath: join(dir, "store.json"), now: () => NOW });
  return {
    store,
    now: () => NOW,
    ids: ids(),
    trace: (event) => events.push(event),
    memoryBackends: {
      list: () => [backend],
      get: (backendId) => (backendId === "mbk_memmy" ? backend : undefined),
    },
  };
}

async function newRun(deps: ApplicationDeps, requirement?: "required" | "optional") {
  const { session } = await createProductSession(deps, {
    principalId: "usr_memorytest" as never,
    commandId: "cmd_memorysession" as never,
    payload: {},
  });
  const { run } = await submitUserMessage(deps, {
    principalId: "usr_memorytest" as never,
    sessionId: session.sessionId,
    commandId: "cmd_memorymessage" as never,
    payload: {
      text: "Orchid protocol 的审批颜色是什么？",
      ...(requirement !== undefined
        ? {
            context: {
              memory: {
                backendId: "mbk_memmy" as never,
                requirement,
                tags: ["ORCHID", "orchid"],
                layers: ["L2" as const],
                limit: 3,
                contextBudget: 512,
              },
            },
          }
        : {}),
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const workflowAttempt = Object.values(snapshot.entities.attempts).find(
    (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "workflow",
  );
  if (workflowAttempt === undefined) throw new Error("缺少Workflow Attempt");
  return { run, workflowAttempt };
}

describe("Memory Context纵向用例", () => {
  it("未选择Memory时不调用后端且Planning Input保持无ContextPackage", async () => {
    let calls = 0;
    const deps = await depsWith(
      fakeBackend(async () => {
        calls += 1;
        throw new Error("不应调用");
      }),
    );
    const { run, workflowAttempt } = await newRun(deps);
    const prepared = await beginPlanningContext(deps, {
      commandId: "cmd_preparememorynone" as never,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    });
    expect(prepared).toEqual({ schemaVersion: "chat-internal-runtime.v1", status: "none" });
    expect(calls).toBe(0);
    const planning = await compilePlanningInput(deps, {
      commandId: "cmd_compilememorynone" as never,
      productRunId: run.productRunId,
      planRevision: 1,
    });
    expect(planning.contextPackage).toBeUndefined();
  });

  it("真实边界成功后冻结Package；重放不重复查询且Planning Manifest绑定来源", async () => {
    let calls = 0;
    const events: TraceEventInput[] = [];
    const backend = fakeBackend(async () => {
      calls += 1;
      return {
        externalQueryId: "search-orchid-1",
        hitCount: 1,
        tokenEstimate: 16,
        sections: [
          {
            externalObjectIds: ["memory-orchid-1"],
            title: "Orchid 审批事实",
            kind: "trace",
            memoryLayer: "L2",
            content: "Orchid protocol approval color is heliotrope.",
            tags: ["orchid"],
            score: 0.99,
            tokenEstimate: 16,
          },
        ],
      };
    });
    const deps = await depsWith(backend, events);
    const { run, workflowAttempt } = await newRun(deps, "required");
    const command = {
      commandId: "cmd_preparememorysuccess" as never,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    };
    const begun = await beginPlanningContext(deps, command);
    expect(calls).toBe(0);
    const first = await executeDispatch(deps, backend, begun, "cmd_persistmemorysuccess");
    const second = await beginPlanningContext(deps, command);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    if (first.status !== "ready" || second.status !== "ready") throw new Error("上下文未完成");
    const planning = await compilePlanningInput(deps, {
      commandId: "cmd_compilememorysuccess" as never,
      productRunId: run.productRunId,
      planRevision: 1,
      contextPackageRef: first.contextPackageRef,
    });
    expect(planning.contextPackage?.memory.items[0]?.content).toContain("heliotrope");
    expect(planning.contextPackage?.memory.items[0]?.refId).toMatch(/^mrs_/u);
    expect(planning.inputManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    const serializedTrace = JSON.stringify(events);
    expect(serializedTrace).not.toContain("heliotrope");
    expect(events.filter((event) => event.eventName === "context.assembly.started")).toHaveLength(
      1,
    );
  });

  it("显式Memory选择只进入所选正文，篡改失败且规划修订与执行复用同一冻结Selection", async () => {
    const selectedCanary = "EXPLICIT_MEMORY_SELECTED_35C1";
    const unselectedCanary = "EXPLICIT_MEMORY_UNSELECTED_82B7";
    const backend = fakeBackend(async () => ({
      externalQueryId: "search-explicit-memory-selection",
      hitCount: 2,
      tokenEstimate: 28,
      sections: [
        {
          externalObjectIds: ["memory-selected"],
          title: "选中的冻结事实",
          kind: "world_model",
          memoryLayer: "L2",
          content: `${selectedCanary}：发布前必须完成两人复核。`,
          tags: ["selected"],
          tokenEstimate: 14,
        },
        {
          externalObjectIds: ["memory-unselected"],
          title: "未选中的冻结事实",
          kind: "world_model",
          memoryLayer: "L2",
          content: `${unselectedCanary}：这条内容不应进入新Run。`,
          tags: ["unselected"],
          tokenEstimate: 14,
        },
      ],
    }));
    const deps = await depsWith(backend);
    const source = await newRun(deps, "required");
    const begun = await beginPlanningContext(deps, {
      commandId: "cmd_beginexplicitmemory" as never,
      productRunId: source.run.productRunId,
      attemptId: source.workflowAttempt.attemptId,
      planRevision: 1,
    });
    await executeDispatch(deps, backend, begun, "cmd_persistexplicitmemory");
    const sourceSnapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const selected = Object.values(sourceSnapshot.entities.memoryResultSnapshots).find((item) =>
      item.content.includes(selectedCanary),
    );
    const unselected = Object.values(sourceSnapshot.entities.memoryResultSnapshots).find((item) =>
      item.content.includes(unselectedCanary),
    );
    const definition =
      sourceSnapshot.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
    if (selected === undefined || unselected === undefined || definition === undefined) {
      throw new Error("显式Memory测试fixture不完整");
    }

    const { session } = await createProductSession(deps, {
      principalId: "usr_memorytest" as never,
      commandId: "cmd_explicitmemorysession" as never,
      payload: {},
    });
    const submitted = await submitUserMessage(deps, {
      principalId: "usr_memorytest" as never,
      sessionId: session.sessionId,
      commandId: "cmd_explicitmemorymessage" as never,
      payload: {
        text: "只使用我明确选择的记忆制定审核计划",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
          definitionSha256: definition.definitionSha256,
          runConfiguration: {
            schemaVersion: "workflow-run-configuration.v1",
            overrides: [
              {
                kind: "resource_selection",
                definitionNodeId: "planning.memory",
                resourceKind: "memory",
                required: true,
                selections: [
                  {
                    resourceId: selected.memoryResultSnapshotId,
                    expectedRevision: selected.revision,
                    expectedSha256: selected.sha256,
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const configured = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const configuredRun = configured.entities.runs[submitted.run.productRunId];
    if (configuredRun?.runKind !== "planning" || configuredRun.workflowRunSpecId === undefined) {
      throw new Error("显式Memory RunSpec未生成");
    }
    const prepared = await preparePlanningMemoryContext(deps, {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_prepareexplicitmemory" as never,
      productRunId: configuredRun.productRunId,
      workflowRunSpecId: configuredRun.workflowRunSpecId,
      definitionNodeId: "planning.memory",
      executionPath: [],
      attemptNumber: 1,
    });
    if (prepared.status !== "ready") throw new Error("显式Memory Selection未冻结");
    expect(prepared.snapshots.map((item) => item.memoryResultSnapshotId)).toEqual([
      selected.memoryResultSnapshotId,
    ]);

    await expect(
      compilePlanningInput(deps, {
        commandId: "cmd_compileexplicitmemorytamper" as never,
        productRunId: configuredRun.productRunId,
        planRevision: 1,
        planningMemorySelectionRef: {
          ...prepared.selectionRef,
          sha256: "0".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const planningV1 = await compilePlanningInput(deps, {
      commandId: "cmd_compileexplicitmemoryv1" as never,
      productRunId: configuredRun.productRunId,
      planRevision: 1,
      planningMemorySelectionRef: prepared.selectionRef,
    });
    expect(planningV1.memorySelection?.ref).toEqual(prepared.selectionRef);
    expect(planningV1.memorySelection?.items).toEqual([
      expect.objectContaining({
        refId: selected.memoryResultSnapshotId,
        content: expect.stringContaining(selectedCanary),
      }),
    ]);
    expect(JSON.stringify(planningV1)).not.toContain(unselectedCanary);

    const planContent: PlanContent = {
      objective: "按冻结Memory制定计划",
      summary: "只引用用户明确选择的Memory",
      assumptions: [{ statement: "选择事实有效", source: "context" }],
      openQuestions: [],
      steps: [
        {
          stepId: "answer",
          title: "形成审核方案",
          purpose: "使用冻结事实",
          dependsOn: [],
          inputRefs: [
            {
              refId: selected.memoryResultSnapshotId,
              revision: selected.revision,
              sha256: selected.sha256,
            },
          ],
          expectedOutput: "Markdown方案",
          successCriteria: ["只采用明确选择的事实"],
          requestedCapabilities: ["markdown_text_compose"],
          risk: "low",
        },
      ],
      completionCriteria: ["方案可审核"],
      warnings: [],
    };
    const reviewV1 = await publishPlanForReview(deps, {
      commandId: "cmd_publishexplicitmemoryv1" as never,
      productRunId: configuredRun.productRunId,
      attemptId: planningV1.attemptId,
      expectedRunRevision: planningV1.inputRunRevision,
      inputManifestSha256: planningV1.inputManifestSha256,
      content: planContent,
    });
    await submitPlanDecision(deps, {
      commandId: "cmd_revisionexplicitmemory" as never,
      principalId: "usr_memorytest" as never,
      productRunId: configuredRun.productRunId,
      expectedRunRevision: reviewV1.run.revision,
      payload: {
        approvalRequestId: reviewV1.approval.approvalRequestId,
        planId: reviewV1.plan.planId,
        planRevision: reviewV1.plan.planRevision,
        planSha256: reviewV1.plan.sha256,
        kind: "request_revision",
        revisionInstruction: "保留同一Memory证据并缩短说明",
      },
    });
    const planningV2 = await compilePlanningInput(deps, {
      commandId: "cmd_compileexplicitmemoryv2" as never,
      productRunId: configuredRun.productRunId,
      planRevision: 2,
      planningMemorySelectionRef: prepared.selectionRef,
    });
    expect(planningV2.memorySelection?.ref).toEqual(planningV1.memorySelection?.ref);
    expect(planningV2.revisionInstruction).toContain("保留同一Memory证据");
    expect(JSON.stringify(planningV2)).not.toContain(unselectedCanary);

    const reviewV2 = await publishPlanForReview(deps, {
      commandId: "cmd_publishexplicitmemoryv2" as never,
      productRunId: configuredRun.productRunId,
      attemptId: planningV2.attemptId,
      expectedRunRevision: planningV2.inputRunRevision,
      inputManifestSha256: planningV2.inputManifestSha256,
      content: { ...planContent, summary: "缩短后的冻结Memory计划" },
    });
    const approved = await submitPlanDecision(deps, {
      commandId: "cmd_approveexplicitmemory" as never,
      principalId: "usr_memorytest" as never,
      productRunId: configuredRun.productRunId,
      expectedRunRevision: reviewV2.run.revision,
      payload: {
        approvalRequestId: reviewV2.approval.approvalRequestId,
        planId: reviewV2.plan.planId,
        planRevision: reviewV2.plan.planRevision,
        planSha256: reviewV2.plan.sha256,
        kind: "approve",
      },
    });
    const { contract } = await compileExecutionContract(deps, {
      commandId: "cmd_contractexplicitmemory" as never,
      productRunId: configuredRun.productRunId,
      approvalDecisionId: approved.decision.decisionId,
    });
    const execution = await beginRunAttempt(deps, {
      commandId: "cmd_attemptexplicitmemory" as never,
      productRunId: configuredRun.productRunId,
      kind: "execution",
      executionContractId: contract.executionContractId,
      stepId: "answer",
      dependencyRefs: [],
      promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
      modelConfigVersion: MODEL_CONFIG_VERSION,
    });
    expect(execution.contextItems).toEqual([
      expect.objectContaining({
        refId: selected.memoryResultSnapshotId,
        content: expect.stringContaining(selectedCanary),
      }),
    ]);
    expect(JSON.stringify(execution)).not.toContain(unselectedCanary);
  });

  it("执行前只解析Approved Step明确引用的冻结Memory，伪造ref失败关闭", async () => {
    const memoryContent = "Orchid protocol approval color is heliotrope.";
    const backend = fakeBackend(async () => ({
      externalQueryId: "search-execution-context-1",
      hitCount: 1,
      tokenEstimate: 16,
      sections: [
        {
          externalObjectIds: ["memory-execution-context-1"],
          title: "Orchid 审批事实",
          kind: "world_model",
          memoryLayer: "L2",
          content: memoryContent,
          tags: ["orchid"],
          tokenEstimate: 16,
        },
      ],
    }));
    const deps = await depsWith(backend);
    const { run, workflowAttempt } = await newRun(deps, "required");
    const begun = await beginPlanningContext(deps, {
      commandId: "cmd_beginexecutioncontext" as never,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    });
    const prepared = await executeDispatch(deps, backend, begun, "cmd_persistexecutioncontext");
    if (prepared.status !== "ready") throw new Error("Memory上下文未完成");
    const planning = await compilePlanningInput(deps, {
      commandId: "cmd_compileexecutioncontext" as never,
      productRunId: run.productRunId,
      planRevision: 1,
      contextPackageRef: prepared.contextPackageRef,
    });
    const frozen = planning.contextPackage?.memory.items[0];
    if (frozen === undefined) throw new Error("缺少冻结Memory条目");
    const plan: PlanContent = {
      objective: "回答Orchid审批颜色",
      summary: "根据冻结Memory生成答案",
      assumptions: [{ statement: "Memory条目可用", source: "context" }],
      openQuestions: [],
      steps: [
        {
          stepId: "answer",
          title: "生成答案",
          purpose: "使用冻结Memory回答",
          dependsOn: [],
          inputRefs: [{ refId: frozen.refId, revision: frozen.revision, sha256: frozen.sha256 }],
          expectedOutput: "Markdown答案",
          successCriteria: ["包含准确审批颜色"],
          requestedCapabilities: ["markdown_text_compose"],
          risk: "low",
        },
      ],
      completionCriteria: ["答案可读"],
      warnings: [],
    };
    const review = await publishPlanForReview(deps, {
      commandId: "cmd_publishexecutioncontext" as never,
      productRunId: run.productRunId,
      attemptId: planning.attemptId,
      expectedRunRevision: planning.inputRunRevision,
      inputManifestSha256: planning.inputManifestSha256,
      content: plan,
    });
    const approved = await submitPlanDecision(deps, {
      commandId: "cmd_approveexecutioncontext" as never,
      principalId: "usr_memorytest" as never,
      productRunId: run.productRunId,
      expectedRunRevision: review.run.revision,
      payload: {
        approvalRequestId: review.approval.approvalRequestId,
        planId: review.plan.planId,
        planRevision: review.plan.planRevision,
        planSha256: review.plan.sha256,
        kind: "approve",
      },
    });
    const { contract } = await compileExecutionContract(deps, {
      commandId: "cmd_contractexecutioncontext" as never,
      productRunId: run.productRunId,
      approvalDecisionId: approved.decision.decisionId,
    });
    const execution = await beginRunAttempt(deps, {
      commandId: "cmd_attemptexecutioncontext" as never,
      productRunId: run.productRunId,
      kind: "execution",
      executionContractId: contract.executionContractId,
      stepId: "answer",
      dependencyRefs: [],
      promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
      modelConfigVersion: MODEL_CONFIG_VERSION,
    });
    expect(execution.contextItems).toEqual([
      expect.objectContaining({
        refId: frozen.refId,
        revision: frozen.revision,
        sha256: frozen.sha256,
        content: memoryContent,
      }),
    ]);
    expect(execution.inputManifestSha256).toBe(
      computeExecutionInputManifestSha256({
        executionContractId: contract.executionContractId,
        approvedPlanSha256: contract.approvedPlanSha256,
        stepId: "answer",
        inputRefs: contract.steps[0]!.inputRefs,
        dependencyRefs: [],
        promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
      }),
    );

    // 额外用一个破坏的Store Port证明Application不依赖Adapter的完整性偶然保护。
    const { snapshot: committed } = await deps.store.read({ kind: "committedSnapshot" });
    const forged = structuredClone(committed) as ProductSnapshot;
    const forgedContract = forged.entities.executionContracts[contract.executionContractId]!;
    const forgedPlan = Object.values(forged.entities.plans).find(
      (candidate) =>
        candidate.planId === review.plan.planId &&
        candidate.planRevision === review.plan.planRevision,
    );
    if (forgedPlan === undefined) throw new Error("缺少已批准Plan fixture");
    const forgedRef = { ...frozen, sha256: "0".repeat(64) };
    forgedContract.steps[0]!.inputRefs = [
      { refId: forgedRef.refId, revision: forgedRef.revision, sha256: forgedRef.sha256 },
    ];
    forgedPlan.content.steps[0]!.inputRefs = [
      { refId: forgedRef.refId, revision: forgedRef.revision, sha256: forgedRef.sha256 },
    ];
    const forgedStore: ProductStorePort = {
      read: async () => ({ snapshot: forged }),
      transact: async (command) => {
        const mutation = command.mutate(forged);
        return {
          storeRevision: forged.storeRevision,
          resultRefs: mutation.resultRefs,
          replayed: false,
        };
      },
    };
    await expect(
      beginRunAttempt(
        { ...deps, store: forgedStore },
        {
          commandId: "cmd_forgedexecutioncontext" as never,
          productRunId: run.productRunId,
          kind: "execution",
          executionContractId: contract.executionContractId,
          stepId: "answer",
          dependencyRefs: [],
          promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
          modelConfigVersion: MODEL_CONFIG_VERSION,
        },
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("optional失败提交排除Package并允许继续规划", async () => {
    const backend = fakeBackend(async () => {
      throw new MemoryBackendError({
        code: "memory.backend.timeout",
        message: "timeout",
        retryable: true,
      });
    });
    const deps = await depsWith(backend);
    const { run, workflowAttempt } = await newRun(deps, "optional");
    const begun = await beginPlanningContext(deps, {
      commandId: "cmd_preparememoryoptional" as never,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    });
    const prepared = await executeDispatch(deps, backend, begun, "cmd_persistmemoryoptional");
    expect(prepared.status).toBe("optional_failed");
    if (prepared.status !== "optional_failed") throw new Error("应为optional_failed");
    const planning = await compilePlanningInput(deps, {
      commandId: "cmd_compilememoryoptional" as never,
      productRunId: run.productRunId,
      planRevision: 1,
      contextPackageRef: prepared.contextPackageRef,
    });
    expect(planning.contextPackage?.memory.items).toEqual([]);
    expect(planning.contextPackage?.memory.exclusions[0]?.reasonCode).toBe(
      "memory.backend.timeout",
    );
  });

  it("required失败持久化Query终态并在Planner调用前失败关闭", async () => {
    const events: TraceEventInput[] = [];
    const backend = fakeBackend(async () => {
      throw new MemoryBackendError({
        code: "memory.backend.forbidden",
        message: "forbidden",
        retryable: false,
      });
    });
    const deps = await depsWith(backend, events);
    const { run, workflowAttempt } = await newRun(deps, "required");
    const command = {
      commandId: "cmd_preparememoryrequired" as never,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    };
    const begun = await beginPlanningContext(deps, command);
    const prepared = await executeDispatch(deps, backend, begun, "cmd_persistmemoryrequired");
    expect(prepared.status).toBe("required_failed");
    expect(await beginPlanningContext(deps, command)).toMatchObject({ status: "required_failed" });
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const query = Object.values(snapshot.entities.memoryQueries)[0];
    expect(query?.status).toBe("failed");
    expect(query?.status === "failed" ? query.errorCode : undefined).toBe(
      "memory.backend.forbidden",
    );
    expect(Object.keys(snapshot.entities.contextPackages)).toHaveLength(0);
    expect(
      Object.values(snapshot.entities.attempts).filter((attempt) => attempt.kind === "planning"),
    ).toHaveLength(0);
    expect(events.filter((event) => event.eventName === "context.assembly.started")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.eventName === "context.assembly.failed")).toHaveLength(1);
  });

  it("同一命令并发开始时只冻结一个Query且两个调用都得到同一dispatch", async () => {
    let backendCalls = 0;
    const events: TraceEventInput[] = [];
    const deps = await depsWith(
      fakeBackend(async () => {
        backendCalls += 1;
        throw new Error("begin节点不应调用外部后端");
      }),
      events,
    );
    const { run, workflowAttempt } = await newRun(deps, "required");
    const command = {
      commandId: "cmd_beginmemoryconcurrent" as never,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    };

    const [first, second] = await Promise.all([
      beginPlanningContext(deps, command),
      beginPlanningContext(deps, command),
    ]);

    expect(first).toEqual(second);
    expect(first.status).toBe("dispatch_required");
    expect(backendCalls).toBe(0);
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(Object.values(snapshot.entities.memoryQueries)).toHaveLength(1);
    expect(events.filter((event) => event.eventName === "context.assembly.started")).toHaveLength(
      1,
    );
  });

  it("外部调用成功但产品提交失败时保留pending，不伪造失败终态或完成Trace", async () => {
    const events: TraceEventInput[] = [];
    const backend = fakeBackend(async () => ({
      externalQueryId: "search-persist-failure",
      hitCount: 1,
      tokenEstimate: 8,
      sections: [
        {
          externalObjectIds: ["memory-persist-failure"],
          title: "持久化故障事实",
          kind: "trace",
          memoryLayer: "L2",
          content: "checkpoint survives while product commit fails",
          tags: ["persistence"],
          tokenEstimate: 8,
        },
      ],
    }));
    const deps = await depsWith(backend, events);
    const { run, workflowAttempt } = await newRun(deps, "required");
    const begun = await beginPlanningContext(deps, {
      commandId: "cmd_beginpersistfailure" as never,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    });
    if (begun.status !== "dispatch_required") throw new Error("缺少Memory dispatch");
    const output = await backend.query({
      operationId: begun.query.memoryQueryId,
      productRunId: begun.query.productRunId,
      productSessionId: begun.query.productSessionId,
      query: begun.query.queryText,
      tags: begun.query.tags,
      layers: begun.query.layers,
      limit: begun.query.limit,
      contextBudget: begun.query.contextBudget,
    });
    const checkpoint = normalizeMemoryQueryResult(begun.query, output);
    const committedStore = deps.store;
    const failingStore: ProductStorePort = {
      read: (query) => committedStore.read(query),
      transact: async (command) => {
        if (command.commandType === "CompleteMemoryContextQuery") {
          throw new Error("injected product commit failure");
        }
        return committedStore.transact(command);
      },
    };

    await expect(
      persistPlanningContextResult(
        { ...deps, store: failingStore },
        {
          commandId: "cmd_persistfailure" as never,
          productRunId: run.productRunId,
          attemptId: workflowAttempt.attemptId,
          memoryQueryId: begun.query.memoryQueryId,
          result: checkpoint,
        },
      ),
    ).rejects.toThrow("injected product commit failure");

    const { snapshot } = await committedStore.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.memoryQueries[begun.query.memoryQueryId]?.status).toBe("pending");
    expect(Object.values(snapshot.entities.memoryResultSnapshots)).toHaveLength(0);
    expect(Object.values(snapshot.entities.contextPackages)).toHaveLength(0);
    expect(events.filter((event) => event.eventName === "context.assembly.completed")).toHaveLength(
      0,
    );
    expect(events.filter((event) => event.eventName === "context.assembly.failed")).toHaveLength(0);
  });

  it("相同完成命令携带不同checkpoint以及相同编译命令改变Context ref都失败关闭", async () => {
    const backend = fakeBackend(async () => ({
      externalQueryId: "search-command-binding-a",
      hitCount: 1,
      tokenEstimate: 8,
      sections: [
        {
          externalObjectIds: ["memory-command-binding"],
          title: "命令绑定事实",
          kind: "trace",
          memoryLayer: "L2",
          content: "command hashes bind the frozen checkpoint",
          tags: ["idempotency"],
          tokenEstimate: 8,
        },
      ],
    }));
    const deps = await depsWith(backend);
    const { run, workflowAttempt } = await newRun(deps, "required");
    const begun = await beginPlanningContext(deps, {
      commandId: "cmd_begincommandbinding" as never,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    });
    if (begun.status !== "dispatch_required") throw new Error("缺少Memory dispatch");
    const firstCheckpoint = normalizeMemoryQueryResult(
      begun.query,
      await backend.query({
        operationId: begun.query.memoryQueryId,
        productRunId: begun.query.productRunId,
        productSessionId: begun.query.productSessionId,
        query: begun.query.queryText,
        tags: begun.query.tags,
        layers: begun.query.layers,
        limit: begun.query.limit,
        contextBudget: begun.query.contextBudget,
      }),
    );
    const persistCommandId = "cmd_persistcommandbinding" as never;
    const prepared = await persistPlanningContextResult(deps, {
      commandId: persistCommandId,
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      memoryQueryId: begun.query.memoryQueryId,
      result: firstCheckpoint,
    });
    if (prepared.status !== "ready") throw new Error("Memory上下文未完成");
    const changedCheckpoint = normalizeMemoryQueryResult(begun.query, {
      externalQueryId: "search-command-binding-b",
      hitCount: firstCheckpoint.hitCount,
      tokenEstimate: firstCheckpoint.tokenEstimate,
      sections: firstCheckpoint.sections,
    });
    await expect(
      persistPlanningContextResult(deps, {
        commandId: persistCommandId,
        productRunId: run.productRunId,
        attemptId: workflowAttempt.attemptId,
        memoryQueryId: begun.query.memoryQueryId,
        result: changedCheckpoint,
      }),
    ).rejects.toMatchObject({ code: "command_id_reused" });

    const compileCommandId = "cmd_compilecommandbinding" as never;
    await compilePlanningInput(deps, {
      commandId: compileCommandId,
      productRunId: run.productRunId,
      planRevision: 1,
      contextPackageRef: prepared.contextPackageRef,
    });
    await expect(
      compilePlanningInput(deps, {
        commandId: compileCommandId,
        productRunId: run.productRunId,
        planRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "command_id_reused" });
  });
});
