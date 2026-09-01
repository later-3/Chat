import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProject } from "./projects/registry.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  listChatSessions,
  normalizeMessageForFrontend,
  projectSessionContext,
  readChatSession,
} from "./session-read-model.ts";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowStage,
} from "./workflows/workflow-stage.ts";
import { setChatWorkflowAgentPromptResources } from "./workflows/workflow-configuration.ts";
import { appendChatPromptResourceProposal } from "./workflows/prompt-resource-proposal.ts";
import {
  appendPlanReview,
  appendPlanReviewDecision,
  bindPlanningExecutionRun,
  planSha256,
  publishPlanReviewState,
  setPlanningExecutionPhase,
} from "./workflows/planning-execution/review-state.ts";

function userEntry(id, parentId, content) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content },
  };
}

function assistantEntry(id, parentId, content) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "assistant", provider: "test", model: "test-model", content },
  };
}

test("Pi toolCall fields are projected to the frontend contract", () => {
  assert.deepEqual(
    normalizeMessageForFrontend({
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/repo/a.ts" } }],
    }),
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "tool-1",
        toolName: "read",
        input: { path: "/repo/a.ts" },
      }],
    },
  );
});

test("compaction-aware messages stay aligned with entry ids", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", [{ type: "text", text: "old answer" }]),
    userEntry("u2", "a1", "kept request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];
  const context = projectSessionContext(entries);
  assert.deepEqual(context.entryIds, ["cmp", "u2", "u3"]);
  assert.equal(context.messages.length, context.entryIds.length);
  assert.equal(context.messages[0].role, "compactionSummary");
});

test("a selected branch does not include a later compaction on another branch", () => {
  const entries = [
    userEntry("u1", null, "root"),
    assistantEntry("a1", "u1", [{ type: "text", text: "answer" }]),
    userEntry("main", "a1", "main"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "main",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main summary",
      firstKeptEntryId: "main",
      tokensBefore: 100,
    },
    userEntry("alternate", "a1", "alternate"),
  ];
  const context = projectSessionContext(entries, "alternate");
  assert.deepEqual(context.entryIds, ["u1", "a1", "alternate"]);
  assert.equal(context.messages.some((message) => message.role === "compactionSummary"), false);
  assert.deepEqual(projectSessionContext(entries, null).entryIds, []);
});

test("historical thinking is deferred only when requested", () => {
  const entries = [
    userEntry("u1", null, "start"),
    assistantEntry("a1", "u1", [
      { type: "thinking", thinking: "large reasoning" },
      { type: "text", text: "answer" },
    ]),
  ];
  const deferred = projectSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });
  assert.equal(projectSessionContext(entries).messages[1].content[0].thinking, "large reasoning");
});

test("native Planner output stays visible with Workflow provenance", () => {
  const manager = SessionManager.inMemory("/workspace");
  appendChatWorkflowStage(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  const userEntryId = manager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
  appendChatWorkflowAgentInput(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    inputEntryIds: [userEntryId],
  });
  const plannerEntryId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "planner-model",
    content: [
      { type: "thinking", thinking: "planner reasoning" },
      { type: "text", text: "planner plan" },
    ],
    timestamp: 2,
  });
  appendChatWorkflowStage(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  appendChatWorkflowAgentInput(manager, {
    invocationId: "invocation-1",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
    inputEntryIds: [userEntryId, plannerEntryId],
  });
  const executorEntryId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "executor-model",
    content: [{ type: "text", text: "final answer" }],
    timestamp: 3,
  });

  const projected = projectSessionContext(manager.getEntries(), undefined, { deferThinking: true });
  assert.deepEqual(projected.messages.map((message) => message.role), ["user", "assistant", "assistant"]);
  assert.deepEqual(projected.entryIds, [userEntryId, plannerEntryId, executorEntryId]);
  assert.equal(projected.messages[0].content, "original request");
  assert.deepEqual(projected.messages[1].content[0], { type: "thinking", thinking: "", deferred: true });
  assert.equal(projected.messages[1].chatWorkflow.agentId, "planner");
  assert.equal(projected.messages[2].content[0].text, "final answer");
  assert.deepEqual(
    manager.buildSessionContext().messages.map((message) => message.role),
    ["user", "assistant", "assistant"],
  );
});

test("a planning turn remains a coherent user request and plan while waiting for review", () => {
  const manager = SessionManager.inMemory("/workspace");
  appendChatWorkflowStage(manager, {
    invocationId: "waiting-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  const userEntryId = manager.appendMessage({
    role: "user",
    content: "original waiting request",
    timestamp: 1,
  });
  appendChatWorkflowAgentInput(manager, {
    invocationId: "waiting-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    inputEntryIds: [userEntryId],
  });
  const planEntryId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "planner-model",
    content: [{ type: "text", text: "review this plan" }],
    timestamp: 2,
  });

  const projected = projectSessionContext(manager.getEntries());
  assert.deepEqual(projected.messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(projected.entryIds, [userEntryId, planEntryId]);
  assert.equal(projected.messages[0].content, "original waiting request");
  assert.equal(projected.messages[1].content[0].text, "review this plan");
  assert.deepEqual(manager.buildSessionContext().messages.map((message) => message.role), ["user", "assistant"]);
});

test("plan revisions and the user's feedback stay ordered in the same projected conversation", () => {
  const manager = SessionManager.inMemory("/workspace");
  appendChatWorkflowStage(manager, {
    invocationId: "revision-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  const originalUserEntryId = manager.appendMessage({
    role: "user",
    content: "keep this one conversation",
    timestamp: 1,
  });
  const appendPlan = (revision, text, inputEntryIds) => {
    appendChatWorkflowAgentInput(manager, {
      invocationId: "revision-invocation",
      workflowId: "planning-execution",
      stageId: "plan",
      agentId: "planner",
      inputEntryIds,
    });
    const planEntryId = manager.appendMessage({
      role: "assistant",
      provider: "test",
      model: "planner-model",
      content: [{ type: "text", text }],
      timestamp: revision + 1,
    });
    const review = {
      schemaVersion: 1,
      workflowId: "planning-execution",
      stageId: "review",
      reviewId: `revision-invocation:${revision}`,
      workflowInvocationId: "revision-invocation",
      sessionId: manager.getSessionId(),
      planRevision: revision,
      planSha256: planSha256(text),
      planEntryId,
      plan: text,
      createdAt: `2026-09-01T00:0${revision}:00.000Z`,
    };
    appendPlanReview(manager, review);
    return review;
  };
  const first = appendPlan(1, "plan one", [originalUserEntryId]);
  appendChatWorkflowStage(manager, {
    invocationId: "revision-invocation",
    workflowId: "planning-execution",
    stageId: "review",
    nodeKind: "human",
  });
  const feedbackEntryId = manager.appendMessage({
    role: "user",
    content: "keep the Session and add rollback",
    timestamp: 3,
  });
  appendPlanReviewDecision(manager, {
    schemaVersion: 2,
    workflowId: "planning-execution",
    stageId: "review",
    kind: "request_revision",
    reviewId: first.reviewId,
    workflowInvocationId: first.workflowInvocationId,
    planRevision: first.planRevision,
    planSha256: first.planSha256,
    feedback: "keep the Session and add rollback",
    feedbackEntryId,
    decidedAt: "2026-09-01T00:01:30.000Z",
  });
  appendChatWorkflowStage(manager, {
    invocationId: "revision-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  const second = appendPlan(2, "plan two", [originalUserEntryId, first.planEntryId, feedbackEntryId]);

  const projected = projectSessionContext(manager.getEntries());
  assert.deepEqual(projected.messages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  assert.equal(projected.messages[0].content, "keep this one conversation");
  assert.equal(projected.messages[1].content[0].text, "plan one");
  assert.equal(projected.messages[2].content, "keep the Session and add rollback");
  assert.equal(projected.messages[3].content[0].text, "plan two");
  assert.deepEqual(projected.entryIds, [originalUserEntryId, first.planEntryId, feedbackEntryId, second.planEntryId]);
});

test("an approval is a native human message between the reviewed plan and Executor output", () => {
  const manager = SessionManager.inMemory("/workspace");
  appendChatWorkflowStage(manager, {
    invocationId: "approval-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  const userEntryId = manager.appendMessage({ role: "user", content: "plan this", timestamp: 1 });
  const planEntryId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "planner",
    content: [{ type: "text", text: "approved plan" }],
    timestamp: 2,
  });
  appendChatWorkflowStage(manager, {
    invocationId: "approval-invocation",
    workflowId: "planning-execution",
    stageId: "review",
    nodeKind: "human",
  });
  const approvalEntryId = manager.appendMessage({
    role: "user",
    content: "已通过执行计划 v1，开始执行。",
    timestamp: 3,
  });
  appendPlanReviewDecision(manager, {
    schemaVersion: 3,
    workflowId: "planning-execution",
    stageId: "review",
    kind: "approve",
    reviewId: "approval-invocation:1",
    workflowInvocationId: "approval-invocation",
    planRevision: 1,
    planSha256: planSha256("approved plan"),
    messageEntryId: approvalEntryId,
    decidedAt: "2026-09-01T00:03:00.000Z",
  });
  appendChatWorkflowStage(manager, {
    invocationId: "approval-invocation",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  const resultEntryId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "executor",
    content: [{ type: "text", text: "completed result" }],
    timestamp: 4,
  });

  const projected = projectSessionContext(manager.getEntries());
  assert.deepEqual(projected.messages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  assert.equal(projected.messages[2].content, "已通过执行计划 v1，开始执行。");
  assert.deepEqual(projected.entryIds, [userEntryId, planEntryId, approvalEntryId, resultEntryId]);
});

test("a legacy approval without a native message remains visible as a compatibility event", () => {
  const manager = SessionManager.inMemory("/workspace");
  appendChatWorkflowStage(manager, {
    invocationId: "legacy-approval",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  manager.appendMessage({ role: "user", content: "legacy request", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "planner",
    content: [{ type: "text", text: "legacy plan" }],
    timestamp: 2,
  });
  appendChatWorkflowStage(manager, {
    invocationId: "legacy-approval",
    workflowId: "planning-execution",
    stageId: "review",
    nodeKind: "human",
  });
  appendPlanReviewDecision(manager, {
    schemaVersion: 2,
    workflowId: "planning-execution",
    stageId: "review",
    kind: "approve",
    reviewId: "legacy-approval:1",
    workflowInvocationId: "legacy-approval",
    planRevision: 1,
    planSha256: planSha256("legacy plan"),
    decidedAt: "2026-09-01T00:03:00.000Z",
  });

  const projected = projectSessionContext(manager.getEntries());
  assert.deepEqual(projected.messages.map((message) => message.role), ["user", "assistant", "custom"]);
  assert.equal(projected.messages[2].customType, "chat.plan_review_decision");
  assert.equal(projected.messages[2].content, "已通过执行计划 v1，开始执行。");
});

test("only base64 tool-result images are omitted from the initial payload", () => {
  const entries = [
    userEntry("u1", null, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDRA==" } }]),
    {
      type: "message",
      id: "tr1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "result" },
          { type: "image", data: "QUJDRA==", mimeType: "image/png" },
          { type: "image", source: { type: "url", url: "https://example.com/result.png" } },
        ],
      },
    },
  ];
  const context = projectSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.equal(context.messages[0].content.length, 1);
  assert.equal(context.messages[1].content[1].source.type, "url");
  assert.match(context.messages[1].content[2].text, /1 tool result image omitted.*image\/png.*~4 bytes/);
});

test("session listing scans only the current Project session directory", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-list-"));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const workspace = path.join(base, "workspace");
  const unrelatedDir = path.join(base, "unrelated-sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(unrelatedDir, { recursive: true });
  const chatHome = path.join(base, "home");
  const project = await openProject({
    path: base,
    chatHome,
    id: "session-list",
    name: "Session List",
  });

  const included = SessionManager.create(workspace, project.sessionDir);
  included.appendMessage({ role: "user", content: "included", timestamp: Date.now() });
  included.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "included response" }],
    timestamp: Date.now(),
  });
  const excluded = SessionManager.create(workspace, unrelatedDir);
  excluded.appendMessage({ role: "user", content: "excluded", timestamp: Date.now() });
  excluded.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "excluded response" }],
    timestamp: Date.now(),
  });

  process.chdir(base);
  const sessions = await listChatSessions(undefined, chatHome);
  assert.deepEqual(sessions.map((session) => session.id), [included.getSessionId()]);
  assert.equal(sessions[0].sessionSource, "chat");
  assert.equal(sessions[0].readOnly, false);
});

test("session listing uses the first human or Agent utterance and never exposes Pi's no-message sentinel", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-first-utterance-"));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const chatHome = path.join(base, "home");
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "first-utterance",
    name: "First Utterance",
  });
  const assistantFirst = SessionManager.create(workspace, project.sessionDir);
  appendChatWorkflowStage(assistantFirst, {
    invocationId: "agent-starts",
    workflowId: "future-workflow",
    stageId: "announce",
    agentId: "announcer",
  });
  assistantFirst.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "Agent starts this conversation" }],
    timestamp: Date.now(),
  });
  assistantFirst.flush();
  const metadataOnly = SessionManager.create(workspace, project.sessionDir);
  appendChatWorkflowStage(metadataOnly, {
    invocationId: "metadata-only",
    workflowId: "future-workflow",
    stageId: "queued",
    nodeKind: "task",
  });
  metadataOnly.flush();

  process.chdir(base);
  const sessions = await listChatSessions(project.projectId, chatHome);
  assert.equal(sessions.find((session) => session.id === assistantFirst.getSessionId()).firstMessage,
    "Agent starts this conversation");
  assert.equal(sessions.find((session) => session.id === metadataOnly.getSessionId()).firstMessage, "");
  assert.equal(sessions.some((session) => session.firstMessage === "(no messages)"), false);
});

test("an active legacy review gets a first-utterance fallback and migrates after the Run is terminal", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-active-legacy-session-"));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const chatHome = path.join(base, "home");
  const project = await openProject({ path: workspace, chatHome, id: "active-legacy", name: "Active Legacy" });
  const manager = SessionManager.create(workspace, project.sessionDir);
  manager.appendCustomEntry("chat.workflow_stage", {
    schemaVersion: 1,
    invocationId: "active-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  manager.appendCustomEntry("chat.workflow_agent_input", {
    schemaVersion: 1,
    invocationId: "active-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    userPrompt: "legacy waiting request",
  });
  const planEntryId = manager.appendCustomEntry("chat.workflow_message", {
    schemaVersion: 1,
    invocationId: "active-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text: "legacy waiting plan" }],
      timestamp: 2,
    },
  });
  manager.flush();
  await bindPlanningExecutionRun({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    workflowInvocationId: "active-invocation",
    runId: "run-active",
    sessionId: manager.getSessionId(),
  });
  await publishPlanReviewState({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    review: {
      schemaVersion: 1,
      workflowId: "planning-execution",
      stageId: "review",
      reviewId: "active-review",
      workflowInvocationId: "active-invocation",
      sessionId: manager.getSessionId(),
      planRevision: 1,
      planSha256: planSha256("legacy waiting plan"),
      planEntryId,
      plan: "legacy waiting plan",
      createdAt: new Date().toISOString(),
    },
  });

  process.chdir(base);
  const active = (await listChatSessions(project.projectId, chatHome))
    .find((session) => session.id === manager.getSessionId());
  assert.equal(active.firstMessage, "legacy waiting request");
  assert.equal(active.messageCount, 0);
  assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8").includes("chat.session_migration"), false);

  await setPlanningExecutionPhase({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    workflowInvocationId: "active-invocation",
    sessionId: manager.getSessionId(),
    phase: "completed",
  });
  const migrated = (await listChatSessions(project.projectId, chatHome))
    .find((session) => session.id === manager.getSessionId());
  assert.equal(migrated.firstMessage, "legacy waiting request");
  assert.equal(migrated.messageCount, 2);
  assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8").includes("chat.session_migration"), true);
});

test("session reads restore Workflow Agent configuration and pending Prompt proposals", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-workflow-config-"));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const chatHome = path.join(base, "home");
  const project = await openProject({
    path: base,
    chatHome,
    id: "workflow-config",
    name: "Workflow Config",
  });
  const manager = SessionManager.create(workspace, project.sessionDir);
  manager.appendMessage({ role: "user", content: "configure rules", timestamp: Date.now() });
  setChatWorkflowAgentPromptResources(manager, {
    workflowId: "minimal-pi-coding-agent",
    agentId: "pi-coding-agent",
    promptResources: [{ id: "resource-1", target: { type: "personal" }, selectedBy: "user" }],
    actorAgentId: "rule-curator-agent",
  });
  const proposalId = appendChatPromptResourceProposal(manager, {
    invocationId: "invocation-1",
    sourceWorkflowId: "rule-management",
    sourceAgentId: "rule-curator-agent",
    targetWorkflowId: "planning-execution",
    targetAgentId: "planner",
    promptResources: [{
      id: "resource-2",
      target: { type: "project", projectId: "project-1" },
      selectedBy: "agent",
      reason: "planning rule",
    }],
    summary: "Use a planning rule.",
  });

  process.chdir(base);
  const session = await readChatSession(
    manager.getSessionId(),
    undefined,
    {},
    project.projectId,
    chatHome,
  );
  assert.deepEqual(session.workflowConfigurations, {
    "minimal-pi-coding-agent": {
      "pi-coding-agent": {
        promptResources: [{ id: "resource-1", target: { type: "personal" }, selectedBy: "user" }],
      },
    },
  });
  assert.equal(session.promptResourceProposals[0].id, proposalId);
  assert.equal(session.promptResourceProposals[0].resolution, undefined);
});
