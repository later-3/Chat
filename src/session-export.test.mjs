import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportChatSessionHtml } from "./session-export.ts";
import { appendChatToolExecution } from "./tools/execution-record.ts";
import { appendPlanReviewDecision, planSha256 } from "./workflows/planning-execution/review-state.ts";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowStage,
} from "./workflows/workflow-stage.ts";

function exportedSessionData(html) {
  const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

test("exports a Pi Session as standalone HTML with iterative tree traversal", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-export-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const workspace = path.join(root, "workspace");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.create(workspace, sessionDir);
  const markerId = appendChatWorkflowStage(manager, {
    invocationId: "history-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  const userMessageId = manager.appendMessage({ role: "user", content: "history fixture", timestamp: Date.now() });
  const plannerInputId = appendChatWorkflowAgentInput(manager, {
    invocationId: "history-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    inputEntryIds: [userMessageId],
  });
  const workflowMessageId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "planner-model",
    api: "test",
    content: [
      { type: "thinking", thinking: "planner reasoning" },
      { type: "text", text: "internal plan" },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const reviewMarkerId = appendChatWorkflowStage(manager, {
    invocationId: "history-invocation",
    workflowId: "planning-execution",
    stageId: "review",
    nodeKind: "human",
  });
  const approvalMessageId = manager.appendMessage({
    role: "user",
    content: "已通过执行计划 v1，开始执行。",
    timestamp: Date.now(),
  });
  const reviewDecisionEntryId = appendPlanReviewDecision(manager, {
    schemaVersion: 3,
    workflowId: "planning-execution",
    stageId: "review",
    kind: "approve",
    reviewId: "history-invocation:1",
    workflowInvocationId: "history-invocation",
    planRevision: 1,
    planSha256: planSha256("internal plan"),
    messageEntryId: approvalMessageId,
    decidedAt: "2026-09-01T10:00:00.000Z",
  });
  const executeMarkerId = appendChatWorkflowStage(manager, {
    invocationId: "history-invocation",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  const agentInputId = appendChatWorkflowAgentInput(manager, {
    invocationId: "history-invocation",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
    inputEntryIds: [userMessageId, workflowMessageId],
  });
  const executorMessageId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [
      { type: "thinking", thinking: "executor reasoning" },
      { type: "text", text: "history response" },
    ],
    timestamp: Date.now(),
  });
  const toolExecutionEntryId = appendChatToolExecution(manager, {
    toolCallId: "memory-call-1",
    toolName: "memory_search",
    toolAddress: "system:tool/memory_search",
    toolVersion: "system:memory-search@1",
    projectId: "chat",
    workflowId: "planning-execution",
    workflowInvocationId: "history-invocation",
    stageId: "plan",
    agentId: "planner",
    startedAt: "2026-09-01T10:00:00.000Z",
    completedAt: "2026-09-01T10:00:01.000Z",
    status: "completed",
  });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);

  const exported = await exportChatSessionHtml(sessionFile);
  assert.match(exported.fileName, /^pi-session-.+\.html$/);
  assert.match(exported.html, /^<!DOCTYPE html>/);
  assert.match(exported.html, /function sortChildren\(root\)/);
  assert.match(exported.html, /const stack = \[\.\.\.tree\]\.reverse\(\)/);
  assert.match(exported.html, /const ordered = \[\]/);
  assert.doesNotMatch(exported.html, /node\.children\.forEach\(sortChildren\)/);
  assert.doesNotMatch(exported.html, /node\.children\.forEach\(mapNodes\)/);
  assert.doesNotMatch(exported.html, /if \(markActive\(child\)\)/);
  assert.match(exported.html, /id="chat-workflow-history-styles"/);
  assert.match(exported.html, /createChatWorkflowGroup/);
  assert.match(exported.html, /createChatAgentStage/);
  assert.match(exported.html, /chatWorkflowMessageByEntryId/);
  assert.match(exported.html, /chatWorkflowAgentInputByEntryId/);
  assert.match(exported.html, /createChatAgentInput/);
  assert.match(exported.html, /agentLabel \+ " thinking"/);
  assert.match(exported.html, /Tool call and output/);
  assert.match(exported.html, /agentLabel \+ " output"/);
  assert.match(exported.html, /Session configuration/);
  assert.match(exported.html, /effective model/);
  assert.match(exported.html, /effective thinking level/);
  assert.match(exported.html, /chatToolExecutionByEntryId/);
  assert.match(exported.html, /createChatToolExecution/);
  assert.match(exported.html, /Tool execution record/);
  assert.match(exported.html, /createChatPlanReviewDecision/);
  assert.match(exported.html, /Human review decision/);
  assert.match(exported.html, /已通过执行计划 v/);
  assert.match(exported.html, /chat-review-decision/);
  assert.doesNotMatch(exported.html, /\? "Input"\s*:\s*"Agent event"/);
  assert.match(exported.html, /function renderChatHistoryRegionEntry\(entry\)/);
  assert.match(exported.html, /const html = renderEntry\(entry\)/);
  assert.match(exported.html, /node\.querySelector\("\.copy-link-btn"\)\?\.remove\(\)/);
  assert.doesNotMatch(
    exported.html,
    /const node = renderEntryToNode\(\{[\s\S]*?message: \{ \.\.\.message, content/,
  );
  assert.match(exported.html, /activeStageContent/);
  const scripts = [...exported.html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const mainScript = scripts.at(-1)?.[1];
  assert.ok(mainScript);
  assert.doesNotThrow(() => new Function(mainScript));
  const sessionData = exportedSessionData(exported.html);
  assert.deepEqual(sessionData.chatWorkflowStageEntryIds, [markerId, reviewMarkerId, executeMarkerId]);
  assert.deepEqual(sessionData.chatWorkflowStages.map(({ entryId, stageId, agentId, nodeKind, schemaVersion }) => ({
    entryId, stageId, agentId, nodeKind, schemaVersion,
  })), [
    { entryId: markerId, stageId: "plan", agentId: "planner", nodeKind: "agent", schemaVersion: 2 },
    { entryId: reviewMarkerId, stageId: "review", agentId: undefined, nodeKind: "human", schemaVersion: 2 },
    { entryId: executeMarkerId, stageId: "execute", agentId: "pi-coding-agent", nodeKind: "agent", schemaVersion: 2 },
  ]);
  assert.equal(sessionData.chatWorkflowMessages.length, 0);
  assert.deepEqual(sessionData.chatPlanReviewDecisions, [{
    entryId: reviewDecisionEntryId,
    schemaVersion: 3,
    workflowId: "planning-execution",
    stageId: "review",
    kind: "approve",
    reviewId: "history-invocation:1",
    workflowInvocationId: "history-invocation",
    planRevision: 1,
    planSha256: planSha256("internal plan"),
    messageEntryId: approvalMessageId,
    decidedAt: "2026-09-01T10:00:00.000Z",
  }]);
  assert.equal(
    sessionData.entries.find((entry) => entry.id === approvalMessageId).message.content,
    "已通过执行计划 v1，开始执行。",
  );
  assert.deepEqual(sessionData.chatToolExecutions, [{
    entryId: toolExecutionEntryId,
    schemaVersion: 1,
    toolCallId: "memory-call-1",
    toolName: "memory_search",
    toolAddress: "system:tool/memory_search",
    toolVersion: "system:memory-search@1",
    projectId: "chat",
    workflowId: "planning-execution",
    workflowInvocationId: "history-invocation",
    stageId: "plan",
    agentId: "planner",
    startedAt: "2026-09-01T10:00:00.000Z",
    completedAt: "2026-09-01T10:00:01.000Z",
    status: "completed",
  }]);
  const plannerMessage = sessionData.entries.find((entry) => entry.id === workflowMessageId);
  assert.deepEqual(plannerMessage.message.content, [
    { type: "thinking", thinking: "planner reasoning" },
    { type: "text", text: "internal plan" },
  ]);
  const executorMessage = sessionData.entries.find((entry) => entry.id === executorMessageId);
  assert.deepEqual(executorMessage.message.content, [
    { type: "thinking", thinking: "executor reasoning" },
    { type: "text", text: "history response" },
  ]);
  assert.equal(sessionData.chatWorkflowAgentInputs.length, 2);
  const plannerInput = sessionData.chatWorkflowAgentInputs.find((input) => input.agentId === "planner");
  assert.equal(plannerInput.entryId, plannerInputId);
  assert.deepEqual(plannerInput.inputEntryIds, [userMessageId]);
  assert.equal("userPrompt" in plannerInput, false);
  const executorInput = sessionData.chatWorkflowAgentInputs.find(
    (input) => input.agentId === "pi-coding-agent",
  );
  assert.equal(executorInput.entryId, agentInputId);
  assert.deepEqual(executorInput.inputEntryIds, [userMessageId, workflowMessageId]);
  assert.equal("upstream" in executorInput, false);
});

test("a legacy review decision appears as a user item in the full-history tree", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-legacy-review-export-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const workspace = path.join(root, "workspace");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.create(workspace, sessionDir);
  manager.appendMessage({ role: "user", content: "legacy request", timestamp: 1 });
  appendChatWorkflowStage(manager, {
    invocationId: "legacy-review-history",
    workflowId: "planning-execution",
    stageId: "review",
    nodeKind: "human",
  });
  const decisionEntryId = appendPlanReviewDecision(manager, {
    schemaVersion: 2,
    workflowId: "planning-execution",
    stageId: "review",
    kind: "approve",
    reviewId: "legacy-review-history:1",
    workflowInvocationId: "legacy-review-history",
    planRevision: 1,
    planSha256: planSha256("legacy plan"),
    decidedAt: "2026-09-01T10:00:00.000Z",
  });
  manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "executor",
    content: [{ type: "text", text: "done" }],
    timestamp: 2,
  });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);

  const exported = await exportChatSessionHtml(sessionFile);
  const sessionData = exportedSessionData(exported.html);
  const projectedDecision = sessionData.entries.find((entry) => entry.id === decisionEntryId);
  assert.equal(projectedDecision.type, "message");
  assert.equal(projectedDecision.message.role, "user");
  assert.deepEqual(projectedDecision.message.content, [
    { type: "text", text: "已通过执行计划 v1，开始执行。" },
  ]);
  assert.equal(sessionData.chatPlanReviewDecisions[0].entryId, decisionEntryId);
  assert.match(exported.html, /region\.id = "entry-" \+ decision\.entryId/);
});
