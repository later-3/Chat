import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportChatSessionHtml } from "./session-export.ts";
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
  assert.deepEqual(sessionData.chatWorkflowStageEntryIds, [markerId, executeMarkerId]);
  assert.deepEqual(sessionData.chatWorkflowStages.map(({ entryId, stageId, agentId, nodeKind, schemaVersion }) => ({
    entryId, stageId, agentId, nodeKind, schemaVersion,
  })), [
    { entryId: markerId, stageId: "plan", agentId: "planner", nodeKind: "agent", schemaVersion: 2 },
    { entryId: executeMarkerId, stageId: "execute", agentId: "pi-coding-agent", nodeKind: "agent", schemaVersion: 2 },
  ]);
  assert.equal(sessionData.chatWorkflowMessages.length, 0);
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
