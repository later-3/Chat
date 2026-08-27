import assert from "node:assert/strict";
import test from "node:test";
import { lifeosProjectionSchema } from "../src/contracts.ts";
import {
  hasActionableNoteReview,
  hasActionablePlanReview,
  hasActionablePromptReview,
  shouldShowLifeosReviewDock,
} from "../src/client/LifeosDock.tsx";

const timestamp = "2026-08-18T08:00:00.000Z";
const planSha256 = "a".repeat(64);

test("已解析Project会显示同一开工包的窄协调状态", () => {
  const coordinated = lifeosProjectionSchema.parse({
    schemaVersion: "chat-dsh-lifeos-bridge.v3",
    dshSessionId: "dsh-session-project-coordination",
    run: null,
    plan: null,
    approval: null,
    pendingDecision: null,
    noteCandidate: null,
    pendingNoteDecision: null,
    workflowSelection: null,
    executionTraces: [],
    projectCoordination: {
      schemaVersion: "project-agent-coordination.v2",
      resolution: {
        projectId: "prj_coordination1",
        sources: ["workspace_root"],
        workspaceRootId: "root_contentlab",
      },
      project: {
        projectId: "prj_coordination1",
        name: "Content Lab",
        goal: "持续产出并改进工作流。",
        status: "active",
        revision: 3,
        methodSnapshotId: "pms_coordination1",
        methodProfileId: "content-production.v1",
        methodSnapshotRevision: 1,
      },
      participant: null,
      resource: null,
      currentWork: null,
      workCandidates: [],
      requiresWorkSelection: false,
      permissions: {
        allowedActions: [],
      },
      completionGate: null,
      resourceContext: { status: "not_requested" },
      generatedAt: timestamp,
    },
    projectCoordinationTargets: null,
  });
  assert.equal(shouldShowLifeosReviewDock(coordinated), true);
});

function planReviewProjection() {
  return lifeosProjectionSchema.parse({
    schemaVersion: "chat-dsh-lifeos-bridge.v3",
    dshSessionId: "dsh-session-review",
    run: {
      productRunId: "run_review1",
      status: "waiting_human",
      phase: "plan_review",
      allowedActions: ["request_revision", "approve", "reject"],
      revision: 2,
      updatedAt: timestamp,
    },
    plan: {
      schemaVersion: "chat-product-api.v1",
      planId: "pln_review1",
      planRevision: 1,
      status: "under_review",
      sha256: planSha256,
      content: {
        objective: "完成验证",
        summary: "审核后执行。",
        assumptions: [],
        openQuestions: [],
        steps: [
          {
            stepId: "step-1",
            title: "执行",
            purpose: "完成目标",
            dependsOn: [],
            inputRefs: [],
            expectedOutput: "验证结果",
            successCriteria: ["验证通过"],
            requestedCapabilities: [],
            risk: "low",
          },
        ],
        completionCriteria: ["验证通过"],
        warnings: [],
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    approval: {
      schemaVersion: "chat-product-api.v1",
      approvalRequestId: "apr_review1",
      productRunId: "run_review1",
      planId: "pln_review1",
      planRevision: 1,
      planSha256,
      status: "open",
      createdAt: timestamp,
      expiresAt: "2026-08-19T08:00:00.000Z",
    },
    pendingDecision: null,
    noteCandidate: null,
    pendingNoteDecision: null,
    workflowSelection: null,
    executionTraces: [],
  });
}

function promptReviewProjection() {
  return lifeosProjectionSchema.parse({
    schemaVersion: "chat-dsh-lifeos-bridge.v3",
    dshSessionId: "dsh-session-prompt-review",
    run: {
      productRunId: "run_promptreview1",
      status: "waiting_human",
      phase: "prompt_review",
      allowedActions: ["approve", "reject"],
      revision: 3,
      updatedAt: timestamp,
    },
    plan: null,
    approval: null,
    pendingDecision: null,
    noteCandidate: null,
    pendingNoteDecision: null,
    promptReview: {
      schemaVersion: "chat-product-api.v1",
      promptReviewRequestId: "prr_promptreview1",
      productRunId: "run_promptreview1",
      requestIndex: 1,
      requestKind: "agent_turn",
      providerId: "bailian",
      modelId: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
      requestRevision: 1,
      status: "open",
      canonicalPayloadJson: JSON.stringify({
        model: "qwen3.7-plus",
        messages: [{ role: "user", content: "请审核我" }],
      }),
      readablePrompt: "# 请求内容\n\n用户消息：请审核我",
      readableSections: [
        {
          sectionId: "message-1",
          kind: "user_message",
          title: "1 · 用户输入",
          payloadJsonPointer: "/messages/0",
          content: "请审核我",
          contentFormat: "text",
          otherFieldsJson: JSON.stringify({ role: "user" }, null, 2),
          sources: [
            {
              addedBy: "用户输入 → DSH Bridge → Chat Product Message",
              sourceFiles: ["packages/dsh-lifeos-bridge/src/adapter.ts"],
              explanation: "来自当前DSH用户消息。",
            },
          ],
        },
      ],
      rendererVersion: "prompt-readable.v1",
      payloadSha256: "e".repeat(64),
      reviewSha256: "f".repeat(64),
      allowedActions: ["approve", "reject"],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    pendingPromptReviewDecision: null,
    workflowSelection: null,
    executionTraces: [],
  });
}

function noteReviewProjection() {
  return lifeosProjectionSchema.parse({
    schemaVersion: "chat-dsh-lifeos-bridge.v3",
    dshSessionId: "dsh-session-note-review",
    run: {
      productRunId: "run_notereview1",
      status: "waiting_human",
      phase: "note_review",
      allowedActions: [],
      revision: 2,
      updatedAt: timestamp,
    },
    plan: null,
    approval: null,
    pendingDecision: null,
    noteCandidate: {
      schemaVersion: "chat-note-api.v1",
      noteCandidateId: "ntc_review1",
      productRunId: "run_notereview1",
      candidateSequence: 1,
      proposed: {
        title: "候选笔记",
        kind: "general",
        contentMarkdown: "需要人工确认的正文。",
        tags: [{ key: "review", label: "审核" }],
      },
      sourceRefs: [
        {
          kind: "full_message",
          sourceMessageId: "msg_review1",
          sourceMessageSha256: "c".repeat(64),
        },
      ],
      sha256: "d".repeat(64),
      revision: 1,
      status: "under_review",
      allowedActions: ["confirm", "request_revision", "reject"],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    pendingNoteDecision: null,
    workflowSelection: null,
    executionTraces: [],
  });
}

test("review dock retires plan cards as soon as the confirmed decision is no longer actionable", () => {
  const waiting = planReviewProjection();
  assert.equal(hasActionablePlanReview(waiting), true);
  assert.equal(shouldShowLifeosReviewDock(waiting), true);

  const completed = lifeosProjectionSchema.parse({
    ...waiting,
    run: {
      ...waiting.run,
      status: "succeeded",
      phase: "completed",
      allowedActions: [],
      revision: 4,
    },
    plan: { ...waiting.plan, status: "approved" },
    approval: { ...waiting.approval, status: "decided" },
  });
  assert.equal(hasActionablePlanReview(completed), false);
  assert.equal(shouldShowLifeosReviewDock(completed), false);
});

test("review dock applies the same transient lifecycle to note candidates", () => {
  const waiting = noteReviewProjection();
  assert.equal(hasActionableNoteReview(waiting), true);
  assert.equal(shouldShowLifeosReviewDock(waiting), true);

  const completed = lifeosProjectionSchema.parse({
    ...waiting,
    run: {
      ...waiting.run,
      status: "succeeded",
      phase: "completed",
      revision: 4,
    },
  });
  assert.equal(hasActionableNoteReview(completed), false);
  assert.equal(shouldShowLifeosReviewDock(completed), false);
});

test("执行Agent的同一节点在Provider边界展示原始与易读Prompt Review", () => {
  const waiting = promptReviewProjection();
  assert.equal(hasActionablePromptReview(waiting), true);
  assert.equal(shouldShowLifeosReviewDock(waiting), true);
  assert.match(waiting.promptReview?.canonicalPayloadJson ?? "", /qwen3\.7-plus/);
  assert.match(waiting.promptReview?.readablePrompt ?? "", /用户消息/);

  const completed = lifeosProjectionSchema.parse({
    ...waiting,
    run: { ...waiting.run, status: "running", phase: "executing", revision: 4 },
    promptReview: { ...waiting.promptReview, status: "approved", allowedActions: [] },
  });
  assert.equal(hasActionablePromptReview(completed), false);
  assert.equal(shouldShowLifeosReviewDock(completed), false);
});

test("Bridge出口审核以冻结的完整Command plan保持Dock可操作", () => {
  const submitBody = JSON.stringify({
    commandId: `cmd_${"c".repeat(48)}`,
    payload: {
      text: "第二道边界审核",
      promptSelection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
    },
  });
  const waiting = lifeosProjectionSchema.parse({
    schemaVersion: "chat-dsh-lifeos-bridge.v3",
    dshSessionId: "dsh-session-bridge-dispatch-review",
    run: null,
    plan: null,
    approval: null,
    pendingDecision: null,
    noteCandidate: null,
    pendingNoteDecision: null,
    bridgeDispatchReviewEnabled: true,
    bridgeDispatchReview: {
      schemaVersion: "chat-bridge-chat-dispatch-review.v1",
      reviewId: `bdr_${"b".repeat(32)}`,
      status: "open",
      plan: {
        schemaVersion: "chat-bridge-chat-dispatch-plan.v2",
        requestKey: "a".repeat(48),
        productSessionId: "psn_bridgedispatchreview",
        submitMessage: {
          method: "POST",
          path: "/api/sessions/psn_bridgedispatchreview/messages",
          bodyJson: submitBody,
          bodySha256: "c".repeat(64),
          commandId: `cmd_${"c".repeat(48)}`,
          payload: {
            text: "第二道边界审核",
            promptSelection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
          },
        },
        planSha256: "d".repeat(64),
      },
    },
    workflowSelection: null,
    executionTraces: [],
  });
  assert.equal(shouldShowLifeosReviewDock(waiting), true);
  assert.equal(waiting.bridgeDispatchReview?.plan.submitMessage.bodyJson, submitBody);
  assert.equal(waiting.bridgeDispatchReview?.plan.planSha256, "d".repeat(64));

  const released = lifeosProjectionSchema.parse({
    ...waiting,
    bridgeDispatchReview: null,
  });
  assert.equal(shouldShowLifeosReviewDock(released), false);
});

test("review dock remains visible only for an outcome-unknown decision that must be retried", () => {
  const plan = planReviewProjection();
  const pendingPlan = lifeosProjectionSchema.parse({
    ...plan,
    run: { ...plan.run, status: "running", phase: "executing", allowedActions: [] },
    approval: { ...plan.approval, status: "decided" },
    pendingDecision: {
      kind: "approve",
      binding: {
        productRunId: "run_review1",
        runRevision: 2,
        approvalRequestId: "apr_review1",
        planId: "pln_review1",
        planRevision: 1,
        planSha256,
      },
    },
  });
  assert.equal(hasActionablePlanReview(pendingPlan), false);
  assert.equal(shouldShowLifeosReviewDock(pendingPlan), true);

  const note = noteReviewProjection();
  const pendingNote = lifeosProjectionSchema.parse({
    ...note,
    run: { ...note.run, status: "running", phase: "executing" },
    pendingNoteDecision: {
      kind: "confirm",
      binding: {
        productRunId: "run_notereview1",
        runRevision: 2,
        noteCandidateId: "ntc_review1",
        candidateRevision: 1,
        candidateSha256: "d".repeat(64),
      },
    },
  });
  assert.equal(hasActionableNoteReview(pendingNote), false);
  assert.equal(shouldShowLifeosReviewDock(pendingNote), true);
  assert.equal(shouldShowLifeosReviewDock(null), false);
});
