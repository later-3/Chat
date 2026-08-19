import { describe, expect, it } from "vitest";
import { createEmptySnapshot, type ProductSnapshot, type WorkflowRunSpecId } from "@chat/contracts";
import {
  canonicalJsonStringify,
  computePromptReviewDecisionSha256,
  computePromptReviewPayloadSha256,
  computePromptReviewSha256,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import type {
  ProductStorePort,
  ProductTransaction,
  ProductTransactionResult,
} from "./product-store-port.js";
import { transitionConfigurablePlanningNode } from "./configurable-workflow-runtime-use-cases.js";
import { BUILTIN_WORKFLOW_EXECUTOR_MANIFEST } from "./workflow-executor-manifest.js";
import { compileWorkflowRunSpec } from "./workflow-run-spec-compiler.js";
import {
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_FAMILY,
  createSystemDirectAgentDefinition,
} from "./workflow-system-definitions.js";

const NOW = "2026-08-19T14:00:00.000Z";
const RUN_ID = "run_directprojection" as const;
const RUN_SPEC_ID = "wrs_directprojection" as const;
const SESSION_ID = "psn_directprojection" as const;
const SOURCE_MESSAGE_ID = "msg_directprojection" as const;
const DIRECT_ATTEMPT_ID = "att_directprojection" as const;
const REVIEW_ID = "prr_directprojection" as const;
const DECISION_ID = "prd_directprojection" as const;
const PRINCIPAL_ID = "usr_directprojection" as const;
const PROMPT_BODY = "TOP_SECRET_PROMPT_BODY_ONLY_IN_PRODUCT_STORE";

/**
 * Application单元测试使用的原子内存Store。mutate失败时不提交draft，足以证明
 * Prompt Review Hash漂移不会留下半条Node事实。
 */
class InMemoryProductStore implements ProductStorePort {
  readonly #receipts = new Map<
    string,
    { readonly requestSha256: string; readonly result: ProductTransactionResult }
  >();
  #snapshot: ProductSnapshot;

  constructor(snapshot: ProductSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }

  async read(): Promise<{ readonly snapshot: Readonly<ProductSnapshot> }> {
    return { snapshot: structuredClone(this.#snapshot) };
  }

  async transact(transaction: ProductTransaction): Promise<ProductTransactionResult> {
    const prior = this.#receipts.get(transaction.commandId);
    if (prior !== undefined) {
      if (prior.requestSha256 !== transaction.requestSha256) {
        throw new Error("测试Store检测到commandId复用");
      }
      return { ...prior.result, replayed: true };
    }
    const draft = structuredClone(this.#snapshot);
    const mutation = transaction.mutate(draft);
    draft.storeRevision += 1;
    draft.committedAt = NOW;
    this.#snapshot = draft;
    const result = {
      storeRevision: draft.storeRevision,
      resultRefs: { ...mutation.resultRefs },
      replayed: false,
    } satisfies ProductTransactionResult;
    this.#receipts.set(transaction.commandId, {
      requestSha256: transaction.requestSha256,
      result,
    });
    return result;
  }

  mutateCommitted(mutator: (snapshot: ProductSnapshot) => void): void {
    mutator(this.#snapshot);
  }

  inspect(): ProductSnapshot {
    return structuredClone(this.#snapshot);
  }
}

interface DirectProjectionFixture {
  readonly deps: ApplicationDeps;
  readonly store: InMemoryProductStore;
  readonly workflowRunSpecId: WorkflowRunSpecId;
}

function directProjectionFixture(): DirectProjectionFixture {
  const seed = createSystemDirectAgentDefinition(NOW);
  const compiled = compileWorkflowRunSpec({
    workflowRunSpecId: RUN_SPEC_ID,
    productRunId: RUN_ID,
    createdAt: NOW,
    definition: {
      schemaVersion: "workflow-definition-revision-input.v1",
      workflowDefinitionRevisionId: seed.revision.workflowDefinitionRevisionId,
      definitionRevision: seed.revision.definitionRevision,
      blueprintKey: seed.revision.blueprintKey,
      blueprintVersion: seed.revision.blueprintVersion,
      semanticRoot: seed.revision.semanticRoot,
      expectedSha256: seed.revision.definitionSha256,
    },
    runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    principal: { principalId: PRINCIPAL_ID, capabilities: [] },
    availableResources: [],
    executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
    runner: {
      runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
      runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
    },
    businessInput: { kind: "direct_agent_message" },
  });
  if (!compiled.success) throw new Error("Direct RunSpec测试Fixture编译失败");

  const snapshot = createEmptySnapshot(NOW);
  snapshot.entities.sessions[SESSION_ID] = {
    schemaVersion: "product-session.v1",
    sessionId: SESSION_ID as never,
    ownerPrincipalId: PRINCIPAL_ID as never,
    status: "active",
    lastMessageSequence: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.messages[SOURCE_MESSAGE_ID] = {
    schemaVersion: "message.v1",
    messageId: SOURCE_MESSAGE_ID as never,
    sessionId: SESSION_ID as never,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "运行Direct Agent" },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.workflowDefinitions[seed.definition.workflowDefinitionId] = seed.definition;
  snapshot.entities.workflowDefinitionRevisions[seed.revision.workflowDefinitionRevisionId] =
    seed.revision;
  snapshot.entities.workflowViewDefinitions[seed.view.workflowViewDefinitionId] = seed.view;
  snapshot.entities.workflowRunSpecs[compiled.runSpec.workflowRunSpecId] = compiled.runSpec;
  snapshot.entities.runs[RUN_ID] = {
    schemaVersion: "product-run.v3",
    runKind: "direct_agent",
    productRunId: RUN_ID as never,
    sessionId: SESSION_ID as never,
    sourceMessageId: SOURCE_MESSAGE_ID as never,
    workflowViewDefinitionId: seed.view.workflowViewDefinitionId,
    workflowRunSpecId: compiled.runSpec.workflowRunSpecId,
    runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
    runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
    status: "running",
    phase: "executing",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.attempts[DIRECT_ATTEMPT_ID] = {
    schemaVersion: "run-attempt.v1",
    attemptId: DIRECT_ATTEMPT_ID as never,
    productRunId: RUN_ID as never,
    kind: "direct_agent",
    outcome: "running",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const store = new InMemoryProductStore(snapshot);
  return {
    store,
    workflowRunSpecId: compiled.runSpec.workflowRunSpecId,
    deps: {
      store,
      now: () => NOW,
      ids: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error("该用例不应分配产品ID");
          },
        },
      ) as ApplicationDeps["ids"],
    },
  };
}

async function transition(
  fixture: DirectProjectionFixture,
  input: {
    readonly commandSuffix: string;
    readonly definitionNodeId: "direct.agent";
    readonly iteration: number;
    readonly toStatus: "running" | "waiting_human" | "succeeded" | "cancelled";
    readonly outcomeCode?: "prompt_review_required" | "completed" | "approved" | "rejected";
  },
) {
  return transitionConfigurablePlanningNode(fixture.deps, {
    commandId: `cmd_${input.commandSuffix}` as never,
    productRunId: RUN_ID as never,
    workflowRunSpecId: fixture.workflowRunSpecId as never,
    definitionNodeId: input.definitionNodeId,
    executionPath: [],
    attemptNumber: 1,
    toStatus: input.toStatus,
    ...(input.outcomeCode === undefined ? {} : { outcomeCode: input.outcomeCode }),
  });
}

function publishOpenReview(
  fixture: DirectProjectionFixture,
  requestIndex = 1,
): {
  readonly payloadSha256: string;
  readonly reviewSha256: string;
} {
  const canonicalPayloadJson = canonicalJsonStringify({
    messages: [{ role: "user", content: PROMPT_BODY }],
    model: "qwen3.7-plus",
  });
  const payloadSha256 = computePromptReviewPayloadSha256(canonicalPayloadJson);
  const reviewSha256 = computePromptReviewSha256({
    promptReviewRequestId: REVIEW_ID,
    productRunId: RUN_ID,
    directAgentAttemptId: DIRECT_ATTEMPT_ID,
    requestIndex,
    requestKind: "agent_turn",
    providerId: "bailian",
    modelId: "qwen3.7-plus",
    endpointHost: "dashscope.aliyuncs.com",
    requestRevision: 1,
    payloadSha256,
    rendererVersion: "prompt-readable.v1",
  });
  fixture.store.mutateCommitted((snapshot) => {
    snapshot.entities.promptReviewRequests[REVIEW_ID] = {
      schemaVersion: "prompt-review-request.v1",
      promptReviewRequestId: REVIEW_ID as never,
      productRunId: RUN_ID as never,
      directAgentAttemptId: DIRECT_ATTEMPT_ID as never,
      requestIndex,
      requestKind: "agent_turn",
      providerId: "bailian",
      modelId: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
      requestRevision: 1,
      status: "open",
      canonicalPayloadJson,
      payloadSha256: payloadSha256 as never,
      rendererVersion: "prompt-readable.v1",
      reviewSha256: reviewSha256 as never,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const run = snapshot.entities.runs[RUN_ID];
    if (run?.runKind !== "direct_agent") throw new Error("Direct Run Fixture不存在");
    run.status = "waiting_human";
    run.phase = "prompt_review";
    run.currentPromptReviewRequestId = REVIEW_ID as never;
    run.revision += 1;
  });
  return { payloadSha256, reviewSha256 };
}

function commitDecision(
  fixture: DirectProjectionFixture,
  kind: "approve" | "reject",
): { readonly decisionSha256: string } {
  const commandId = `cmd_decide${kind}` as const;
  let decisionSha256 = "";
  fixture.store.mutateCommitted((snapshot) => {
    const review = snapshot.entities.promptReviewRequests[REVIEW_ID];
    const run = snapshot.entities.runs[RUN_ID];
    if (review === undefined || run?.runKind !== "direct_agent") {
      throw new Error("Prompt Review Fixture不存在");
    }
    const decisionHashInput = {
      promptReviewDecisionId: DECISION_ID,
      promptReviewRequestId: REVIEW_ID,
      productRunId: RUN_ID,
      requestRevision: review.requestRevision,
      reviewSha256: review.reviewSha256,
      payloadSha256: review.payloadSha256,
      kind,
      ...(kind === "reject" ? { reason: "用户拒绝本次提示词" } : {}),
      principalId: PRINCIPAL_ID,
      commandId,
    } as const;
    decisionSha256 = computePromptReviewDecisionSha256(decisionHashInput);
    snapshot.entities.promptReviewDecisions[DECISION_ID] = {
      schemaVersion: "prompt-review-decision.v1",
      ...decisionHashInput,
      promptReviewDecisionId: DECISION_ID as never,
      promptReviewRequestId: REVIEW_ID as never,
      productRunId: RUN_ID as never,
      reviewSha256: review.reviewSha256,
      payloadSha256: review.payloadSha256,
      principalId: PRINCIPAL_ID as never,
      commandId: commandId as never,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    review.status = kind === "approve" ? "approved" : "rejected";
    review.decidedByPromptReviewDecisionId = DECISION_ID as never;
    review.revision += 1;
    run.status = kind === "approve" ? "running" : "cancelled";
    run.phase = kind === "approve" ? "executing" : "rejected";
    delete run.currentPromptReviewRequestId;
    run.revision += 1;
  });
  return { decisionSha256 };
}

function nodeTransitions(snapshot: ProductSnapshot, workflowNodeRunId: string) {
  return Object.values(snapshot.entities.nodeRunTransitions)
    .filter((candidate) => candidate.workflowNodeRunId === workflowNodeRunId)
    .sort((left, right) => left.nodeSequence - right.nodeSequence);
}

describe("Direct单节点Runtime投影", () => {
  it("所有推进复用同一个agent.direct NodeRun并以completed终结", async () => {
    const fixture = directProjectionFixture();

    const first = await transition(fixture, {
      commandSuffix: "agent1running",
      definitionNodeId: "direct.agent",
      iteration: 1,
      toStatus: "running",
    });
    const second = await transition(fixture, {
      commandSuffix: "agent2completed",
      definitionNodeId: "direct.agent",
      iteration: 2,
      toStatus: "succeeded",
      outcomeCode: "completed",
    });

    expect(first.workflowNodeRunId).toBe(second.workflowNodeRunId);
    const snapshot = fixture.store.inspect();
    expect(snapshot.entities.workflowNodeRuns[first.workflowNodeRunId]).toMatchObject({
      nodeType: "agent.direct",
      executionPath: [],
      status: "succeeded",
      outcomeCode: "completed",
    });
  });

  it("waiting_human只投影当前open Request引用，approve终态绑定权威Decision Hash", async () => {
    const fixture = directProjectionFixture();
    const review = publishOpenReview(fixture);
    const waiting = await transition(fixture, {
      commandSuffix: "reviewwaiting",
      definitionNodeId: "direct.agent",
      iteration: 1,
      toStatus: "waiting_human",
    });

    let snapshot = fixture.store.inspect();
    const waitingTransition = nodeTransitions(snapshot, waiting.workflowNodeRunId).at(-1);
    expect(waitingTransition?.relatedProductRef).toEqual({
      kind: "prompt_review_request",
      id: REVIEW_ID,
      revision: 1,
      sha256: review.reviewSha256,
      label: "提示词审核 #1",
    });
    expect(JSON.stringify(waitingTransition?.relatedProductRef)).not.toContain(PROMPT_BODY);
    expect(waitingTransition?.relatedProductRef).not.toHaveProperty("canonicalPayloadJson");

    const committed = commitDecision(fixture, "approve");
    await transition(fixture, {
      commandSuffix: "reviewapproved",
      definitionNodeId: "direct.agent",
      iteration: 1,
      toStatus: "running",
    });

    snapshot = fixture.store.inspect();
    const completedTransition = nodeTransitions(snapshot, waiting.workflowNodeRunId).at(-1);
    expect(completedTransition?.relatedProductRef).toEqual({
      kind: "prompt_review_decision",
      id: DECISION_ID,
      revision: 1,
      sha256: committed.decisionSha256,
      label: "提示词已批准",
    });
    expect(completedTransition?.relatedProductRef?.sha256).toBe(
      computePromptReviewDecisionSha256({
        promptReviewDecisionId: DECISION_ID,
        promptReviewRequestId: REVIEW_ID,
        productRunId: RUN_ID,
        requestRevision: 1,
        reviewSha256: review.reviewSha256,
        payloadSha256: review.payloadSha256,
        kind: "approve",
        principalId: PRINCIPAL_ID,
        commandId: "cmd_decideapprove",
      }),
    );
    expect(JSON.stringify(nodeTransitions(snapshot, waiting.workflowNodeRunId))).not.toContain(
      PROMPT_BODY,
    );
  });

  it("reject已先取消Product Run时仍把审核节点waiting→cancelled/rejected", async () => {
    const fixture = directProjectionFixture();
    publishOpenReview(fixture);
    const waiting = await transition(fixture, {
      commandSuffix: "rejectwaiting",
      definitionNodeId: "direct.agent",
      iteration: 1,
      toStatus: "waiting_human",
    });
    const committed = commitDecision(fixture, "reject");

    await transition(fixture, {
      commandSuffix: "reviewrejected",
      definitionNodeId: "direct.agent",
      iteration: 1,
      toStatus: "cancelled",
      outcomeCode: "rejected",
    });

    const snapshot = fixture.store.inspect();
    expect(snapshot.entities.runs[RUN_ID]).toMatchObject({
      status: "cancelled",
      phase: "rejected",
    });
    expect(snapshot.entities.workflowNodeRuns[waiting.workflowNodeRunId]).toMatchObject({
      status: "cancelled",
      outcomeCode: "rejected",
    });
    expect(nodeTransitions(snapshot, waiting.workflowNodeRunId).at(-1)?.relatedProductRef).toEqual({
      kind: "prompt_review_decision",
      id: DECISION_ID,
      revision: 1,
      sha256: committed.decisionSha256,
      label: "提示词已拒绝",
    });
  });

  it("Request reviewSha或Decision绑定漂移时原子失败关闭", async () => {
    const requestDrift = directProjectionFixture();
    publishOpenReview(requestDrift);
    requestDrift.store.mutateCommitted((snapshot) => {
      snapshot.entities.promptReviewRequests[REVIEW_ID]!.reviewSha256 = "0".repeat(64) as never;
    });
    await expect(
      transition(requestDrift, {
        commandSuffix: "requesthashdrift",
        definitionNodeId: "direct.agent",
        iteration: 1,
        toStatus: "waiting_human",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(Object.values(requestDrift.store.inspect().entities.workflowNodeRuns)).toHaveLength(0);

    const decisionDrift = directProjectionFixture();
    publishOpenReview(decisionDrift);
    const waiting = await transition(decisionDrift, {
      commandSuffix: "decisiondriftwaiting",
      definitionNodeId: "direct.agent",
      iteration: 1,
      toStatus: "waiting_human",
    });
    commitDecision(decisionDrift, "approve");
    decisionDrift.store.mutateCommitted((snapshot) => {
      snapshot.entities.promptReviewDecisions[DECISION_ID]!.payloadSha256 = "f".repeat(64) as never;
    });
    await expect(
      transition(decisionDrift, {
        commandSuffix: "decisionbindingdrift",
        definitionNodeId: "direct.agent",
        iteration: 1,
        toStatus: "running",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(
      decisionDrift.store.inspect().entities.workflowNodeRuns[waiting.workflowNodeRunId],
    ).toMatchObject({ status: "waiting_human" });
  });

  it("agent.direct没有open Prompt Review时不能伪造waiting_human", async () => {
    const fixture = directProjectionFixture();
    await expect(
      transition(fixture, {
        commandSuffix: "agentwaitinghuman",
        definitionNodeId: "direct.agent",
        iteration: 1,
        toStatus: "waiting_human",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(Object.values(fixture.store.inspect().entities.workflowNodeRuns)).toHaveLength(0);
  });
});
