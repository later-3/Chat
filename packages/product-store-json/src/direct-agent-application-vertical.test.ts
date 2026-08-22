import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentRuntimeBaselineDtoSchema, type CommandId, type PrincipalId } from "@chat/contracts";
import {
  authorizeDirectAgentOperation,
  beginDirectAgentAttempt,
  commitDirectAgentResult,
  commitPromptReviewDispatchOutcome,
  commitRunFailure,
  consumePromptReviewDecision,
  createProductSession,
  getCurrentPromptReview,
  persistDirectAgentCandidate,
  publishPromptReviewRequest,
  submitPromptReviewDecision,
  submitUserMessage,
  transitionConfigurablePlanningNode,
  type ApplicationDeps,
  type DirectAgentIdFactory,
  type IdFactory,
} from "@chat/application";
import { SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import { canonicalJsonStringify, computePromptReviewPayloadSha256 } from "@chat/domain";
import { JsonProductStore } from "./json-product-store.js";

const PRINCIPAL = "usr_directvertical" as PrincipalId;
const BASE_TIME = "2026-08-19T12:00:00.000Z";

function createIdFactories(): {
  readonly ids: IdFactory;
  readonly directAgentIds: DirectAgentIdFactory;
} {
  let counter = 0;
  const next = (prefix: string): string =>
    `${prefix}_vertical${(++counter).toString(36).padStart(4, "0")}`;
  return {
    ids: {
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
    },
    directAgentIds: {
      promptReviewRequest: () =>
        next("prr") as ReturnType<DirectAgentIdFactory["promptReviewRequest"]>,
      promptReviewDecision: () =>
        next("prd") as ReturnType<DirectAgentIdFactory["promptReviewDecision"]>,
      candidate: () => next("drc") as ReturnType<DirectAgentIdFactory["candidate"]>,
    },
  };
}

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "chat-direct-agent-vertical-"));
  let tick = 0;
  let commandCounter = 0;
  const now = (): string => new Date(Date.parse(BASE_TIME) + tick++ * 1_000).toISOString();
  const command = (): CommandId =>
    `cmd_vertical${(++commandCounter).toString(36).padStart(4, "0")}` as CommandId;
  const store = await JsonProductStore.open({
    filePath: join(directory, "product.json"),
    now,
  });
  const factories = createIdFactories();
  const deps: ApplicationDeps = {
    store,
    now,
    ...factories,
    promptCatalog: {
      load: async () => ({
        catalogSha256: "a".repeat(64),
        sharedSelectionProfile: {
          profileId: "test-empty-default.v1",
          defaultRevisionIds: [],
        },
        regions: [],
        builtinFragments: [],
        agents: [
          {
            agentKey: "direct",
            title: "直接执行 Agent",
            description: "负责直接处理当前请求。",
            profileVersion: "direct-agent-prompt.v1",
            supportedNodeTypes: ["agent.direct"],
            defaultPrompt: {
              kind: "pi_coding_agent",
              defaultVariantKey: "read_only",
            },
            tools: [{ name: "read", description: "读取受权文件。" }],
          },
        ],
      }),
    },
    agentRuntimeProfiles: {
      read: async (agentKey) =>
        agentKey === "direct"
          ? agentRuntimeBaselineDtoSchema.parse({
              kind: "pi_coding_agent",
              title: "Pi Coding Agent",
              packageName: "@earendil-works/pi-coding-agent",
              packageVersion: "0.84.2",
              managedSource: "later-3/pi@codex/later-custom",
              managedSourceRevision: "1".repeat(40),
              compositionStrategy: "pi_default_or_custom_then_chat_runtime_then_context",
              chatRuntimeAppend: {
                bodyMarkdown: "Direct Runtime Contract",
                sha256: "c".repeat(64),
                sourceRelativePath: "packages/pi-runtime/src/coding-agent-runtime-profile.ts",
              },
              variants: [
                {
                  variantKey: "read_only",
                  title: "只读执行",
                  description: "只读检查Workspace。",
                  capabilityCatalogSha256: "2".repeat(64),
                  enabledToolNames: ["read", "grep", "find", "ls"],
                  piSystemPrompt: {
                    bodyMarkdown: "You are an expert coding assistant operating inside pi.",
                    sha256: "d".repeat(64),
                    dynamicPlaceholders: ["WORKSPACE_ROOT"],
                    sourceRelativePaths: ["pi/packages/coding-agent/src/core/system-prompt.ts"],
                  },
                  tools: ["read", "grep", "find", "ls"].map((name) => ({
                    name,
                    description: `${name} tool`,
                    parametersJson: "{}",
                    sourceRelativePath: `pi/packages/coding-agent/src/core/tools/${name}.ts`,
                  })),
                },
              ],
              finalReviewNote: "最终内容以发送前审核为准。",
            })
          : undefined,
    },
  };
  const { session } = await createProductSession(deps, {
    principalId: PRINCIPAL,
    commandId: command(),
    payload: {},
  });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const directRevision =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
  if (directRevision === undefined) throw new Error("测试Fixture缺少Direct Agent系统Definition");
  const workflowSelection = {
    kind: "published_revision" as const,
    workflowDefinitionRevisionId: directRevision.workflowDefinitionRevisionId,
    definitionSha256: directRevision.definitionSha256,
  };
  return { command, deps, session, store, workflowSelection };
}

async function startDirectAgent(text = "只读检查当前项目并给出结论", agentPromptOverride?: string) {
  const harness = await createHarness();
  const submitted = await submitUserMessage(harness.deps, {
    principalId: PRINCIPAL,
    sessionId: harness.session.sessionId,
    commandId: harness.command(),
    payload: {
      text,
      workflowSelection: {
        ...harness.workflowSelection,
        ...(agentPromptOverride === undefined
          ? {}
          : {
              runConfiguration: {
                schemaVersion: "workflow-run-configuration.v1" as const,
                overrides: [
                  {
                    kind: "node_config" as const,
                    definitionNodeId: "direct.agent",
                    field: "agentPromptOverride",
                    value: agentPromptOverride,
                  },
                ],
              },
            }),
      },
    },
  });
  const { snapshot } = await harness.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[submitted.run.productRunId];
  const workflowAttempt = Object.values(snapshot.entities.attempts).find(
    (candidate) =>
      candidate.productRunId === submitted.run.productRunId && candidate.kind === "workflow",
  );
  const runSpec =
    run?.workflowRunSpecId === undefined
      ? undefined
      : snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
  if (run?.runKind !== "direct_agent" || workflowAttempt === undefined || runSpec === undefined) {
    throw new Error("测试Fixture没有形成完整Direct Agent Run");
  }
  const begun = await beginDirectAgentAttempt(harness.deps, {
    commandId: harness.command(),
    productRunId: run.productRunId,
    workflowAttemptId: workflowAttempt.attemptId,
  });
  await transitionConfigurablePlanningNode(harness.deps, {
    commandId: harness.command(),
    productRunId: run.productRunId,
    workflowRunSpecId: runSpec.workflowRunSpecId,
    definitionNodeId: "direct.agent",
    executionPath: [],
    attemptNumber: 1,
    toStatus: "running",
    publicSummary: "正在推进直接Agent，等待下一处Provider边界",
  });
  return { ...harness, begun, run, runSpec, submitted, workflowAttempt };
}

function providerPayload(text: string): string {
  return canonicalJsonStringify({
    messages: [{ content: text, role: "user" }],
    model: "qwen3.7-plus",
  });
}

async function publishReview(
  started: Awaited<ReturnType<typeof startDirectAgent>>,
  text = "只读检查当前项目并给出结论",
  projectNode = true,
) {
  const canonicalPayloadJson = providerPayload(text);
  const published = await publishPromptReviewRequest(started.deps, {
    commandId: started.command(),
    productRunId: started.run.productRunId,
    directAgentAttemptId: started.begun.directAgentAttemptId,
    expectedRunRevision: started.begun.runRevision,
    requestIndex: 1,
    requestKind: "agent_turn",
    providerId: "bailian",
    modelId: "qwen3.7-plus",
    endpointHost: "dashscope.aliyuncs.com",
    canonicalPayloadJson,
    payloadSha256: computePromptReviewPayloadSha256(canonicalPayloadJson),
  });
  if (projectNode) {
    await transitionConfigurablePlanningNode(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      workflowRunSpecId: started.runSpec.workflowRunSpecId,
      definitionNodeId: "direct.agent",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "waiting_human",
      publicSummary: "等待审核第1次Provider完整提示词",
    });
  }
  return { canonicalPayloadJson, published };
}

async function submitApproval(
  started: Awaited<ReturnType<typeof startDirectAgent>>,
  review: Awaited<ReturnType<typeof publishReview>>,
) {
  return submitPromptReviewDecision(started.deps, {
    principalId: PRINCIPAL,
    productRunId: started.run.productRunId,
    commandId: started.command(),
    expectedRunRevision: review.published.runRevision,
    payload: {
      promptReviewRequestId: review.published.promptReview.promptReviewRequestId,
      requestRevision: review.published.promptReview.requestRevision,
      reviewSha256: review.published.promptReview.reviewSha256,
      payloadSha256: review.published.promptReview.payloadSha256,
      kind: "approve",
    },
  });
}

async function approveReview(started: Awaited<ReturnType<typeof startDirectAgent>>) {
  const review = await publishReview(started);
  const approved = await submitApproval(started, review);
  await transitionConfigurablePlanningNode(started.deps, {
    commandId: started.command(),
    productRunId: started.run.productRunId,
    workflowRunSpecId: started.runSpec.workflowRunSpecId,
    definitionNodeId: "direct.agent",
    executionPath: [],
    attemptNumber: 1,
    toStatus: "running",
    publicSummary: "用户已批准本次完整提示词",
  });
  const consumeCommandId = started.command();
  const consumeInput = {
    commandId: consumeCommandId,
    productRunId: started.run.productRunId,
    directAgentAttemptId: started.begun.directAgentAttemptId,
    promptReviewRequestId: review.published.promptReview.promptReviewRequestId,
    promptReviewDecisionId: approved.decision.promptReviewDecisionId,
    requestRevision: approved.decision.requestRevision,
    reviewSha256: approved.decision.reviewSha256,
    payloadSha256: approved.decision.payloadSha256,
  };
  const consumed = await consumePromptReviewDecision(started.deps, consumeInput);
  return { ...review, approved, consumeInput, consumed };
}

describe("Direct Agent Application + JsonProductStore最小纵向", () => {
  it("prepare阶段失败可在没有Direct Attempt时收敛为failed/queued", async () => {
    const harness = await createHarness();
    const submitted = await submitUserMessage(harness.deps, {
      principalId: PRINCIPAL,
      sessionId: harness.session.sessionId,
      commandId: harness.command(),
      payload: {
        text: "现在几点了",
        workflowSelection: harness.workflowSelection,
      },
    });

    await commitRunFailure(harness.deps, {
      commandId: harness.command(),
      productRunId: submitted.run.productRunId,
      errorCode: "direct_agent.prepare_failed",
      summary: "Direct Agent在创建Pi执行前失败",
    });

    const { snapshot } = await harness.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[submitted.run.productRunId]).toMatchObject({
      status: "failed",
      phase: "queued",
      failure: { code: "direct_agent.prepare_failed" },
    });
    expect(
      Object.values(snapshot.entities.attempts).filter(
        (attempt) =>
          attempt.productRunId === submitted.run.productRunId && attempt.kind === "direct_agent",
      ),
    ).toHaveLength(0);
    expect(
      Object.values(snapshot.entities.attempts).find(
        (attempt) =>
          attempt.productRunId === submitted.run.productRunId && attempt.kind === "workflow",
      ),
    ).toMatchObject({ outcome: "failure", errorCode: "direct_agent.prepare_failed" });
  });

  it("只在Workflow节点绑定同一Review证据后公开并接受审核", async () => {
    const started = await startDirectAgent();
    const review = await publishReview(started, undefined, false);

    await expect(
      getCurrentPromptReview(started.deps, {
        principalId: PRINCIPAL,
        productRunId: started.run.productRunId,
      }),
    ).resolves.toEqual({ promptReview: null });
    await expect(submitApproval(started, review)).rejects.toMatchObject({
      code: "revision_conflict",
    });

    await transitionConfigurablePlanningNode(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      workflowRunSpecId: started.runSpec.workflowRunSpecId,
      definitionNodeId: "direct.agent",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "waiting_human",
      publicSummary: "等待审核第1次Provider完整提示词",
    });
    const actionable = await getCurrentPromptReview(started.deps, {
      principalId: PRINCIPAL,
      productRunId: started.run.productRunId,
    });
    expect(actionable.promptReview?.promptReviewRequestId).toBe(
      review.published.promptReview.promptReviewRequestId,
    );
    await expect(submitApproval(started, review)).resolves.toMatchObject({
      decision: { kind: "approve" },
    });
  });

  it("拒绝Direct上下文，并通过正式Submit→Begin→Authorize冻结只读输入", async () => {
    const harness = await createHarness();
    await expect(
      submitUserMessage(harness.deps, {
        principalId: PRINCIPAL,
        sessionId: harness.session.sessionId,
        commandId: harness.command(),
        payload: {
          text: "不要把Workspace上下文带入Direct V1",
          context: {
            workspaceInstructions: {
              schemaVersion: "workspace-instructions-input.v1",
              items: [{ content: "这是不允许带入Direct V1的上下文" }],
            },
          },
          workflowSelection: harness.workflowSelection,
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed", httpStatus: 422 });
    expect(
      (await harness.store.read({ kind: "committedSnapshot" })).snapshot.entities.sessions[
        harness.session.sessionId
      ]?.lastMessageSequence,
    ).toBe(0);

    const runtimePromptOverride = "你是本次Run完整覆盖的Direct Agent。";
    const started = await startDirectAgent("请只读检查，不要执行写操作", runtimePromptOverride);
    const authorized = await authorizeDirectAgentOperation(started.deps, {
      productRunId: started.run.productRunId,
      directAgentAttemptId: started.begun.directAgentAttemptId,
      workflowRunSpecId: started.runSpec.workflowRunSpecId,
      workflowRunSpecSha256: started.runSpec.sha256,
      inputManifestSha256: started.begun.inputManifestSha256,
    });

    expect(started.submitted.run).toMatchObject({ status: "pending", phase: "queued" });
    expect(authorized).toMatchObject({
      productRunId: started.run.productRunId,
      directAgentAttemptId: started.begun.directAgentAttemptId,
      sourceMessage: { text: "请只读检查，不要执行写操作" },
      capabilityMode: "pi_cli_default",
      promptAssembly: {
        piSystemPrompt: {
          kind: "pi_coding_agent",
          mode: "replace",
          bodyMarkdown: runtimePromptOverride,
        },
      },
    });
    expect(authorized.limits.maxProviderRequests).toBeGreaterThan(0);
  });

  it("批准后只交付一次完整canonical正文，稳定Command重放不再返回正文", async () => {
    const started = await startDirectAgent();
    const approved = await approveReview(started);
    expect(approved.consumed).toMatchObject({
      status: "authorized",
      canonicalPayloadJson: approved.canonicalPayloadJson,
      payloadSha256: approved.published.promptReview.payloadSha256,
      reviewSha256: approved.published.promptReview.reviewSha256,
    });
    expect(approved.published.promptReview.readablePrompt).toContain("qwen3.7-plus");

    const replayed = await consumePromptReviewDecision(started.deps, approved.consumeInput);
    expect(replayed.status).toBe("already_claimed");
    expect(replayed).not.toHaveProperty("canonicalPayloadJson");

    const { snapshot } = await started.store.read({ kind: "committedSnapshot" });
    expect(Object.values(snapshot.entities.promptReviewRequests)).toHaveLength(1);
    expect(
      snapshot.entities.promptReviewRequests[approved.published.promptReview.promptReviewRequestId]
        ?.canonicalPayloadJson,
    ).toBe(approved.canonicalPayloadJson);
  });

  it("Publish响应丢失后即使用户已决定，稳定重放仍返回同一Review引用", async () => {
    const started = await startDirectAgent();
    const canonicalPayloadJson = providerPayload("只读检查当前项目并给出结论");
    const commandId = started.command();
    const publishInput = {
      commandId,
      productRunId: started.run.productRunId,
      directAgentAttemptId: started.begun.directAgentAttemptId,
      expectedRunRevision: started.begun.runRevision,
      requestIndex: 1,
      requestKind: "agent_turn" as const,
      providerId: "bailian",
      modelId: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
      canonicalPayloadJson,
      payloadSha256: computePromptReviewPayloadSha256(canonicalPayloadJson),
    };
    const first = await publishPromptReviewRequest(started.deps, publishInput);
    await transitionConfigurablePlanningNode(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      workflowRunSpecId: started.runSpec.workflowRunSpecId,
      definitionNodeId: "direct.agent",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "waiting_human",
      publicSummary: "等待审核第1次Provider完整提示词",
    });
    const approved = await submitApproval(started, { canonicalPayloadJson, published: first });

    const replayed = await publishPromptReviewRequest(started.deps, publishInput);
    expect(replayed.promptReview).toMatchObject({
      promptReviewRequestId: first.promptReview.promptReviewRequestId,
      status: "approved",
      reviewSha256: first.promptReview.reviewSha256,
      payloadSha256: first.promptReview.payloadSha256,
    });
    expect(replayed.runRevision).toBe(approved.run.revision);
    const { snapshot } = await started.store.read({ kind: "committedSnapshot" });
    expect(Object.values(snapshot.entities.promptReviewRequests)).toHaveLength(1);
  });

  it("Dispatch完成后先持久化success Candidate，再幂等提交唯一Assistant Message", async () => {
    const started = await startDirectAgent();
    const approved = await approveReview(started);
    if (approved.consumed.status !== "authorized") {
      throw new Error("测试Fixture未取得首次Provider dispatch permit");
    }
    await commitPromptReviewDispatchOutcome(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      directAgentAttemptId: started.begun.directAgentAttemptId,
      promptReviewRequestId: approved.published.promptReview.promptReviewRequestId,
      outcome: "dispatched",
    });
    const candidate = await persistDirectAgentCandidate(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      directAgentAttemptId: started.begun.directAgentAttemptId,
      output: { format: "markdown", text: "检查完成：没有发现需要写入的变更。" },
    });
    const afterCandidate = (await started.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(afterCandidate.entities.attempts[started.begun.directAgentAttemptId]?.outcome).toBe(
      "success",
    );

    const commitCommandId = started.command();
    const commitInput = {
      commandId: commitCommandId,
      productRunId: started.run.productRunId,
      directAgentAttemptId: started.begun.directAgentAttemptId,
      directAgentCandidateId: candidate.directAgentCandidateId,
      candidateSha256: candidate.sha256,
    };
    const first = await commitDirectAgentResult(started.deps, commitInput);
    const replayed = await commitDirectAgentResult(started.deps, commitInput);
    expect(replayed.message.messageId).toBe(first.message.messageId);
    expect(replayed.run).toMatchObject({ status: "succeeded", phase: "completed" });

    const { snapshot } = await started.store.read({ kind: "committedSnapshot" });
    const sessionMessages = Object.values(snapshot.entities.messages).filter(
      (message) => message.sessionId === started.session.sessionId,
    );
    expect(sessionMessages).toHaveLength(2);
    expect(snapshot.entities.sessions[started.session.sessionId]?.lastMessageSequence).toBe(2);
    expect(sessionMessages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("拒绝审核只返回Decision引用、不返回正文，并把Run收敛为cancelled", async () => {
    const started = await startDirectAgent();
    const review = await publishReview(started);
    const rejected = await submitPromptReviewDecision(started.deps, {
      principalId: PRINCIPAL,
      productRunId: started.run.productRunId,
      commandId: started.command(),
      expectedRunRevision: review.published.runRevision,
      payload: {
        promptReviewRequestId: review.published.promptReview.promptReviewRequestId,
        requestRevision: review.published.promptReview.requestRevision,
        reviewSha256: review.published.promptReview.reviewSha256,
        payloadSha256: review.published.promptReview.payloadSha256,
        kind: "reject",
        reason: "提示词范围过大",
      },
    });
    const consumed = await consumePromptReviewDecision(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      directAgentAttemptId: started.begun.directAgentAttemptId,
      promptReviewRequestId: review.published.promptReview.promptReviewRequestId,
      promptReviewDecisionId: rejected.decision.promptReviewDecisionId,
      requestRevision: rejected.decision.requestRevision,
      reviewSha256: rejected.decision.reviewSha256,
      payloadSha256: rejected.decision.payloadSha256,
    });
    expect(consumed.status).toBe("rejected");
    expect(consumed).not.toHaveProperty("canonicalPayloadJson");
    expect(rejected.run).toMatchObject({ status: "cancelled", phase: "rejected" });
    await expect(
      authorizeDirectAgentOperation(started.deps, {
        productRunId: started.run.productRunId,
        directAgentAttemptId: started.begun.directAgentAttemptId,
        workflowRunSpecId: started.runSpec.workflowRunSpecId,
        workflowRunSpecSha256: started.runSpec.sha256,
        inputManifestSha256: started.begun.inputManifestSha256,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("拒绝过期Run revision与篡改的Review/RunSpec Hash", async () => {
    const started = await startDirectAgent();
    await expect(
      authorizeDirectAgentOperation(started.deps, {
        productRunId: started.run.productRunId,
        directAgentAttemptId: started.begun.directAgentAttemptId,
        workflowRunSpecId: started.runSpec.workflowRunSpecId,
        workflowRunSpecSha256: "0".repeat(64),
        inputManifestSha256: started.begun.inputManifestSha256,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const review = await publishReview(started);
    const baseDecision = {
      principalId: PRINCIPAL,
      productRunId: started.run.productRunId,
      commandId: started.command(),
      expectedRunRevision: review.published.runRevision,
      payload: {
        promptReviewRequestId: review.published.promptReview.promptReviewRequestId,
        requestRevision: review.published.promptReview.requestRevision,
        reviewSha256: review.published.promptReview.reviewSha256,
        payloadSha256: review.published.promptReview.payloadSha256,
        kind: "approve" as const,
      },
    };
    await expect(
      submitPromptReviewDecision(started.deps, {
        ...baseDecision,
        expectedRunRevision: baseDecision.expectedRunRevision + 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      submitPromptReviewDecision(started.deps, {
        ...baseDecision,
        commandId: started.command(),
        payload: { ...baseDecision.payload, reviewSha256: "f".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const { snapshot } = await started.store.read({ kind: "committedSnapshot" });
    expect(Object.values(snapshot.entities.promptReviewDecisions)).toHaveLength(0);
    expect(
      snapshot.entities.promptReviewRequests[review.published.promptReview.promptReviewRequestId]
        ?.status,
    ).toBe("open");
  });

  it("普通失败会关闭仍为open的Review并把Run收敛为failed", async () => {
    const started = await startDirectAgent();
    const review = await publishReview(started);

    await commitRunFailure(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      errorCode: "direct.executor_failed",
      summary: "Executor在Provider边界前失败",
    });

    const { snapshot } = await started.store.read({ kind: "committedSnapshot" });
    const settledRun = snapshot.entities.runs[started.run.productRunId];
    if (settledRun?.runKind !== "direct_agent") {
      throw new Error("失败收敛后Direct Agent Run身份损坏");
    }
    expect(settledRun).toMatchObject({
      status: "failed",
      phase: "prompt_review",
      failure: { code: "direct.executor_failed" },
    });
    expect(settledRun.currentPromptReviewRequestId).toBeUndefined();
    expect(
      snapshot.entities.promptReviewRequests[review.published.promptReview.promptReviewRequestId]
        ?.status,
    ).toBe("cancelled");
  });

  it("批准但未消费permit时，普通失败保留Decision并取消Review", async () => {
    const started = await startDirectAgent();
    const review = await publishReview(started);
    const approved = await submitApproval(started, review);

    await commitRunFailure(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      errorCode: "direct.resume_failed",
      summary: "批准后恢复Executor失败，但Provider permit尚未交付",
    });

    const { snapshot } = await started.store.read({ kind: "committedSnapshot" });
    const storedReview =
      snapshot.entities.promptReviewRequests[review.published.promptReview.promptReviewRequestId];
    expect(snapshot.entities.runs[started.run.productRunId]).toMatchObject({
      status: "failed",
      phase: "executing",
      failure: { code: "direct.resume_failed" },
    });
    expect(storedReview).toMatchObject({
      status: "cancelled",
      decidedByPromptReviewDecisionId: approved.decision.promptReviewDecisionId,
    });
    expect(
      snapshot.entities.promptReviewDecisions[approved.decision.promptReviewDecisionId],
    ).toMatchObject({ kind: "approve", reviewSha256: approved.decision.reviewSha256 });
  });

  it("permit已消费后即使报告普通failed，也保守收敛Review与Run为outcome_unknown", async () => {
    const started = await startDirectAgent();
    const approved = await approveReview(started);
    if (approved.consumed.status !== "authorized") {
      throw new Error("测试Fixture未取得首次Provider dispatch permit");
    }

    await commitRunFailure(started.deps, {
      commandId: started.command(),
      productRunId: started.run.productRunId,
      errorCode: "direct.provider_response_lost",
      summary: "调用方只报告普通失败，但Provider请求结果无法确认",
    });

    const { snapshot } = await started.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[started.run.productRunId]).toMatchObject({
      status: "outcome_unknown",
      phase: "executing",
      failure: { code: "direct.provider_response_lost" },
    });
    expect(
      snapshot.entities.promptReviewRequests[approved.published.promptReview.promptReviewRequestId]
        ?.status,
    ).toBe("outcome_unknown");
  });
});
