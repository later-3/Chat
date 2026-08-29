import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportChatSessionHtml } from "./session-export.ts";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowMessage,
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
  const workflowMessageId = appendChatWorkflowMessage(manager, {
    invocationId: "history-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    message: {
      role: "assistant",
      provider: "test",
      model: "planner-model",
      api: "test",
      content: [{ type: "text", text: "internal plan" }],
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
    },
  });
  const agentInputId = appendChatWorkflowAgentInput(manager, {
    invocationId: "history-invocation",
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
    userPrompt: "history fixture",
    upstream: {
      stageId: "plan",
      agentId: "planner",
      output: "internal plan",
    },
  });
  manager.appendMessage({ role: "user", content: "history fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "history response" }],
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
  assert.match(exported.html, /Model thinking/);
  assert.match(exported.html, /Tool call and output/);
  assert.match(exported.html, /Agent output/);
  assert.match(exported.html, /activeStageContent/);
  const scripts = [...exported.html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const mainScript = scripts.at(-1)?.[1];
  assert.ok(mainScript);
  assert.doesNotThrow(() => new Function(mainScript));
  const sessionData = exportedSessionData(exported.html);
  assert.deepEqual(sessionData.chatWorkflowStageEntryIds, [markerId]);
  assert.deepEqual(sessionData.chatWorkflowStages, [{
    entryId: markerId,
    schemaVersion: 1,
    invocationId: "history-invocation",
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  }]);
  assert.equal(sessionData.chatWorkflowMessages.length, 1);
  assert.equal(sessionData.chatWorkflowMessages[0].entryId, workflowMessageId);
  assert.equal(sessionData.chatWorkflowMessages[0].message.content[0].text, "internal plan");
  assert.equal(sessionData.chatWorkflowAgentInputs.length, 2);
  const plannerInput = sessionData.chatWorkflowAgentInputs.find((input) => input.agentId === "planner");
  assert.equal(plannerInput.entryId, `derived-${agentInputId}`);
  assert.equal(plannerInput.userPrompt, "history fixture");
  assert.equal(plannerInput.upstream, undefined);
  const executorInput = sessionData.chatWorkflowAgentInputs.find(
    (input) => input.agentId === "pi-coding-agent",
  );
  assert.equal(executorInput.entryId, agentInputId);
  assert.equal(executorInput.userPrompt, "history fixture");
  assert.equal(executorInput.upstream.output, "internal plan");
});
