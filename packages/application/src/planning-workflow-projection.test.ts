import { describe, expect, it } from "vitest";
import { createEmptySnapshot, type ProductSnapshot, type WorkflowNodeRun } from "@chat/contracts";
import { LEGACY_PLANNING_VIEW_ID, hashCanonical } from "@chat/domain";
import { synchronizePlanningWorkflowProjection } from "./planning-workflow-projection.js";

const NOW = "2026-08-10T00:00:00.000Z";
const LATER = "2026-08-10T00:00:10.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function baseSnapshot(): ProductSnapshot {
  const snapshot = createEmptySnapshot(NOW);
  snapshot.entities.sessions["psn_projection"] = {
    schemaVersion: "product-session.v1",
    sessionId: "psn_projection" as never,
    ownerPrincipalId: "usr_projection" as never,
    status: "active",
    lastMessageSequence: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.messages["msg_projection"] = {
    schemaVersion: "message.v1",
    messageId: "msg_projection" as never,
    sessionId: "psn_projection" as never,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "请整理计划" },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.runs["run_projection"] = {
    schemaVersion: "product-run.v3",
    runKind: "planning",
    productRunId: "run_projection" as never,
    sessionId: "psn_projection" as never,
    sourceMessageId: "msg_projection" as never,
    workflowViewDefinitionId: LEGACY_PLANNING_VIEW_ID as never,
    runnerFamily: "legacy-planning.v1",
    runnerBundleVersion: "legacy-planning.bundle.v1",
    status: "pending",
    phase: "queued",
    maxPlanRevisions: 5,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return snapshot;
}

const findNode = (
  snapshot: ProductSnapshot,
  definitionNodeId: string,
  iteration?: number,
): WorkflowNodeRun => {
  const node = Object.values(snapshot.entities.workflowNodeRuns).find(
    (candidate) =>
      candidate.definitionNodeId === definitionNodeId &&
      (iteration === undefined || candidate.executionPath[0]?.iteration === iteration),
  );
  if (node === undefined) throw new Error(`测试Fixture缺少节点:${definitionNodeId}`);
  return node;
};

const manifestRefs = (snapshot: ProductSnapshot, manifestId: string | undefined) =>
  manifestId === undefined
    ? []
    : (snapshot.entities.nodeValueManifests[manifestId]?.slots.flatMap((slot) => slot.refs) ?? []);

const planContent = (title: string) => ({
  objective: title,
  summary: `${title}摘要`,
  assumptions: [],
  openQuestions: [],
  steps: [
    {
      stepId: "step-a",
      title: "步骤A",
      purpose: "完成A",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "Markdown",
      successCriteria: ["A完成"],
      requestedCapabilities: [],
      risk: "low" as const,
    },
  ],
  completionCriteria: ["任务完成"],
  warnings: [],
});

function addTwoReviewCycles(snapshot: ProductSnapshot): void {
  snapshot.entities.attempts["att_plan1"] = {
    schemaVersion: "run-attempt.v1",
    attemptId: "att_plan1" as never,
    productRunId: "run_projection" as never,
    kind: "planning",
    planRevision: 1,
    outcome: "success",
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.attempts["att_plan2"] = {
    schemaVersion: "run-attempt.v1",
    attemptId: "att_plan2" as never,
    productRunId: "run_projection" as never,
    kind: "planning",
    planRevision: 2,
    outcome: "success",
    revision: 2,
    createdAt: LATER,
    updatedAt: LATER,
  };
  snapshot.entities.plans["plr_plan1"] = {
    schemaVersion: "plan-revision.v1",
    planRevisionId: "plr_plan1" as never,
    planId: "pln_projection" as never,
    productRunId: "run_projection" as never,
    planningAttemptId: "att_plan1" as never,
    planRevision: 1,
    status: "superseded",
    content: planContent("第一版"),
    sha256: HASH_A,
    revision: 2,
    createdAt: NOW,
    updatedAt: LATER,
  };
  snapshot.entities.plans["plr_plan2"] = {
    schemaVersion: "plan-revision.v1",
    planRevisionId: "plr_plan2" as never,
    planId: "pln_projection" as never,
    productRunId: "run_projection" as never,
    planningAttemptId: "att_plan2" as never,
    planRevision: 2,
    status: "under_review",
    content: planContent("第二版"),
    sha256: HASH_B,
    revision: 1,
    createdAt: LATER,
    updatedAt: LATER,
  };
  snapshot.entities.approvalRequests["apr_plan1"] = {
    schemaVersion: "approval-request.v1",
    approvalRequestId: "apr_plan1" as never,
    productRunId: "run_projection" as never,
    planId: "pln_projection" as never,
    planRevision: 1,
    planSha256: HASH_A,
    status: "decided",
    decidedByDecisionId: "dec_plan1" as never,
    expiresAt: "2026-08-11T00:00:00.000Z",
    revision: 2,
    createdAt: NOW,
    updatedAt: LATER,
  };
  snapshot.entities.approvalRequests["apr_plan2"] = {
    schemaVersion: "approval-request.v1",
    approvalRequestId: "apr_plan2" as never,
    productRunId: "run_projection" as never,
    planId: "pln_projection" as never,
    planRevision: 2,
    planSha256: HASH_B,
    status: "open",
    expiresAt: "2026-08-11T00:00:00.000Z",
    revision: 1,
    createdAt: LATER,
    updatedAt: LATER,
  };
  snapshot.entities.decisions["dec_plan1"] = {
    schemaVersion: "decision.v1",
    decisionId: "dec_plan1" as never,
    approvalRequestId: "apr_plan1" as never,
    productRunId: "run_projection" as never,
    planId: "pln_projection" as never,
    planRevision: 1,
    planSha256: HASH_A,
    kind: "request_revision",
    revisionInputId: "rin_plan1" as never,
    principalId: "usr_projection" as never,
    commandId: "cmd_plan1" as never,
    revision: 1,
    createdAt: LATER,
    updatedAt: LATER,
  };
  snapshot.entities.revisionInputs["rin_plan1"] = {
    schemaVersion: "revision-input.v1",
    revisionInputId: "rin_plan1" as never,
    productRunId: "run_projection" as never,
    planId: "pln_projection" as never,
    planRevision: 1,
    instruction: "补充风险",
    revision: 1,
    createdAt: LATER,
    updatedAt: LATER,
  };
  const run = snapshot.entities.runs["run_projection"];
  if (run?.runKind !== "planning") throw new Error("fixture run must be planning");
  snapshot.entities.runs["run_projection"] = {
    ...run,
    status: "waiting_human",
    phase: "plan_review",
    currentPlanId: "pln_projection" as never,
    currentPlanRevision: 2,
    currentApprovalRequestId: "apr_plan2" as never,
    revision: 4,
    updatedAt: LATER,
  };
}

describe("planning workflow product projection", () => {
  it("首次投影生成六个稳定节点，重复同步逐字节幂等", () => {
    const snapshot = baseSnapshot();
    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, NOW);
    expect(Object.keys(snapshot.entities.workflowViewDefinitions)).toEqual([
      LEGACY_PLANNING_VIEW_ID,
    ]);
    expect(Object.values(snapshot.entities.workflowNodeRuns)).toHaveLength(6);
    expect(
      Object.values(snapshot.entities.workflowNodeRuns).map((node) => [
        node.definitionNodeId,
        node.status,
      ]),
    ).toEqual([
      ["context", "queued"],
      ["plan", "queued"],
      ["review", "queued"],
      ["execute", "queued"],
      ["validate", "queued"],
      ["commit", "queued"],
    ]);
    const once = JSON.stringify(snapshot);
    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);
    expect(JSON.stringify(snapshot)).toBe(once);
  });

  it.each(["cancelled", "outcome_unknown"] as const)(
    "planning无Plan收到%s终态时不把running agent.plan倒退为queued",
    (status) => {
      const snapshot = baseSnapshot();
      const pending = snapshot.entities.runs["run_projection"];
      if (pending?.runKind !== "planning") throw new Error("fixture run must be planning");
      snapshot.entities.runs["run_projection"] = {
        ...pending,
        status: "running",
        phase: "planning",
        revision: 2,
        updatedAt: LATER,
      };
      synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);
      expect(findNode(snapshot, "plan").status).toBe("running");

      snapshot.entities.runs["run_projection"] = {
        ...snapshot.entities.runs["run_projection"]!,
        status,
        ...(status === "outcome_unknown"
          ? { failure: { code: "runtime.outcome_unknown", summary: "Runtime结果未知" } }
          : {}),
        revision: 3,
        updatedAt: LATER,
      };
      synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);

      expect(findNode(snapshot, "plan").status).toBe(
        status === "cancelled" ? "cancelled" : "failed",
      );
    },
  );

  it("validating收到outcome_unknown时只把外部执行节点标记未知", () => {
    const snapshot = baseSnapshot();
    const run = snapshot.entities.runs["run_projection"];
    if (run?.runKind !== "planning") throw new Error("fixture run must be planning");
    snapshot.entities.runs["run_projection"] = {
      ...run,
      status: "outcome_unknown",
      phase: "validating",
      failure: { code: "runtime.outcome_unknown", summary: "Runtime结果未知" },
      revision: 2,
      updatedAt: LATER,
    };

    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);

    expect(findNode(snapshot, "execute").status).toBe("outcome_unknown");
    expect(findNode(snapshot, "validate").status).toBe("failed");
    expect(findNode(snapshot, "validate").nodeType).toBe("result.validate");
  });

  it("多轮修订不覆盖历史，当前Plan只引用上一版而不自引用/引用未来版", () => {
    const snapshot = baseSnapshot();
    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, NOW);
    addTwoReviewCycles(snapshot);
    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);

    const plan1 = findNode(snapshot, "plan", 1);
    const review1 = findNode(snapshot, "review", 1);
    const plan2 = findNode(snapshot, "plan", 2);
    const review2 = findNode(snapshot, "review", 2);
    expect([plan1.status, review1.status, plan2.status, review2.status]).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "waiting_human",
    ]);
    expect(manifestRefs(snapshot, plan1.inputManifestId).map((ref) => ref.id)).not.toContain(
      "plr_plan2",
    );
    expect(manifestRefs(snapshot, plan2.inputManifestId).map((ref) => ref.id)).toContain(
      "plr_plan1",
    );
    expect(manifestRefs(snapshot, plan2.inputManifestId).map((ref) => ref.id)).not.toContain(
      "plr_plan2",
    );
    expect(manifestRefs(snapshot, review1.outputManifestId)).toContainEqual(
      expect.objectContaining({ kind: "decision", id: "dec_plan1" }),
    );
    expect(manifestRefs(snapshot, review2.inputManifestId)).toContainEqual(
      expect.objectContaining({ kind: "approval_request", id: "apr_plan2" }),
    );

    const identities = [plan1, review1, plan2, review2].map((node) => node.workflowNodeRunId);
    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);
    expect(
      [
        findNode(snapshot, "plan", 1),
        findNode(snapshot, "review", 1),
        findNode(snapshot, "plan", 2),
        findNode(snapshot, "review", 2),
      ].map((node) => node.workflowNodeRunId),
    ).toEqual(identities);
  });

  it("execute动态子节点按stepId稳定，不把父失败/未知伪造成每个子步骤失败", () => {
    const snapshot = baseSnapshot();
    const run = snapshot.entities.runs["run_projection"];
    if (run?.runKind !== "planning") throw new Error("fixture run must be planning");
    snapshot.entities.runs["run_projection"] = {
      ...run,
      status: "outcome_unknown",
      phase: "executing",
      failure: { code: "execution.response_lost", summary: "执行响应未知" },
      revision: 2,
      updatedAt: LATER,
    };
    const steps = [
      {
        stepId: "step-b",
        title: "步骤B",
        purpose: "完成B",
        dependsOn: ["step-a"],
        inputRefs: [],
        expectedOutput: "B",
        successCriteria: ["B完成"],
        capabilityRefs: [],
      },
      {
        stepId: "step-a",
        title: "步骤A",
        purpose: "完成A",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "A",
        successCriteria: ["A完成"],
        capabilityRefs: [],
      },
    ];
    snapshot.entities.executionContracts["exc_projection"] = {
      schemaVersion: "execution-contract.v1",
      executionContractId: "exc_projection" as never,
      productRunId: "run_projection" as never,
      approvedPlanId: "pln_projection" as never,
      approvedPlanRevision: 1,
      approvedPlanSha256: HASH_A,
      approvalDecisionId: "dec_approve" as never,
      steps,
      completionCriteria: ["完成"],
      capabilityRefs: [],
      limits: { maxTurnsPerStep: 1, timeoutMsPerStep: 1_000 },
      sha256: HASH_A,
      revision: 1,
      createdAt: NOW,
      updatedAt: LATER,
    };
    snapshot.entities.attempts["att_stepa"] = {
      schemaVersion: "run-attempt.v1",
      attemptId: "att_stepa" as never,
      productRunId: "run_projection" as never,
      kind: "execution",
      stepId: "step-a",
      outcome: "success",
      revision: 2,
      createdAt: NOW,
      updatedAt: LATER,
    };
    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);

    expect(findNode(snapshot, "execute").status).toBe("outcome_unknown");
    const children = Object.values(snapshot.entities.workflowNodeRuns).filter(
      (node) => node.nodeType === "execute.plan_step",
    );
    expect(children.map((node) => node.publicSummary)).toEqual(["步骤A", "步骤B"]);
    expect(children.map((node) => node.status)).toEqual(["succeeded", "queued"]);
    const ids = Object.fromEntries(
      children.map((node) => [node.publicSummary, node.workflowNodeRunId]),
    );

    snapshot.entities.executionContracts["exc_projection"] = {
      ...snapshot.entities.executionContracts["exc_projection"]!,
      steps: [...steps].reverse(),
    };
    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);
    const reorderedIds = Object.fromEntries(
      Object.values(snapshot.entities.workflowNodeRuns)
        .filter((node) => node.nodeType === "execute.plan_step")
        .map((node) => [node.publicSummary, node.workflowNodeRunId]),
    );
    expect(reorderedIds).toEqual(ids);
    expect(new Set(Object.values(reorderedIds)).size).toBe(2);
  });

  it("legacy来源缺少ContextPackage和正式结果引用时不借Run终态补写成功", () => {
    const snapshot = baseSnapshot();
    snapshot.entities.runs["run_projection"] = {
      ...snapshot.entities.runs["run_projection"]!,
      status: "succeeded",
      phase: "completed",
      revision: 9,
      updatedAt: LATER,
    };
    synchronizePlanningWorkflowProjection(
      snapshot,
      "run_projection" as never,
      LATER,
      "legacy_product_facts",
    );
    expect(findNode(snapshot, "context").status).toBe("queued");
    expect(findNode(snapshot, "commit").status).toBe("queued");
    for (const node of Object.values(snapshot.entities.workflowNodeRuns)) {
      expect(node.startedAt).toBeUndefined();
      expect(node.projectionSource).toBe("legacy_product_facts");
      const transitions = Object.values(snapshot.entities.nodeRunTransitions).filter(
        (transition) => transition.workflowNodeRunId === node.workflowNodeRunId,
      );
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.reasonKind).toBe("projected");
    }
  });

  it("无Artifact时，已绑定的正式Assistant Message仍是Product Commit成功事实", () => {
    const snapshot = baseSnapshot();
    snapshot.entities.messages["msg_result"] = {
      schemaVersion: "message.v1",
      messageId: "msg_result" as never,
      sessionId: "psn_projection" as never,
      sessionSequence: 2,
      role: "assistant",
      content: { format: "markdown", text: "正式交付结果" },
      sourceRunId: "run_projection" as never,
      revision: 1,
      createdAt: LATER,
      updatedAt: LATER,
    };
    snapshot.entities.sessions["psn_projection"] = {
      ...snapshot.entities.sessions["psn_projection"]!,
      lastMessageSequence: 2,
      revision: 2,
      updatedAt: LATER,
    };
    snapshot.entities.runs["run_projection"] = {
      ...snapshot.entities.runs["run_projection"]!,
      status: "succeeded",
      phase: "completed",
      finalMessageId: "msg_result" as never,
      revision: 9,
      updatedAt: LATER,
    };
    synchronizePlanningWorkflowProjection(
      snapshot,
      "run_projection" as never,
      LATER,
      "legacy_product_facts",
    );

    const commit = findNode(snapshot, "commit");
    expect(commit.status).toBe("succeeded");
    expect(manifestRefs(snapshot, commit.outputManifestId)).toContainEqual(
      expect.objectContaining({ kind: "message", id: "msg_result" }),
    );
    expect(Object.keys(snapshot.entities.artifacts)).toHaveLength(0);
  });

  it("Manifest只保存版本引用，不复制消息、Plan或执行正文", () => {
    const snapshot = baseSnapshot();
    addTwoReviewCycles(snapshot);
    synchronizePlanningWorkflowProjection(snapshot, "run_projection" as never, LATER);
    const serialized = JSON.stringify(snapshot.entities.nodeValueManifests);
    expect(
      Object.values(snapshot.entities.nodeValueManifests).every(
        (manifest) => manifest.revision === 1 && manifest.createdAt === manifest.updatedAt,
      ),
    ).toBe(true);
    expect(serialized).not.toContain("请整理计划");
    expect(serialized).not.toContain("第一版摘要");
    expect(serialized).not.toContain("第二版摘要");
    expect(serialized).not.toContain("hookToken");
    expect(serialized).not.toContain("workflowRunId");
    expect(serialized).toContain(
      hashCanonical("message.v1", {
        messageId: "msg_projection",
        sessionId: "psn_projection",
        sessionSequence: 1,
        role: "user",
        content: { format: "markdown", text: "请整理计划" },
      }),
    );
  });
});
