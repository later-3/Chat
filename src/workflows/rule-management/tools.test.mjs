import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getStoredAgentConfigs, resolveChatConfig } from "../../chat-config.ts";
import { getPromptResourceStore } from "../../prompt-resources/store.ts";
import { openProject } from "../../projects/registry.ts";
import { collectChatPromptResourceProposals } from "../prompt-resource-proposal.ts";
import {
  collectLatestChatWorkflowConfigurations,
  setChatWorkflowAgentPromptResources,
} from "../workflow-configuration.ts";
import { appendChatWorkflowAgentInput, appendChatWorkflowStage } from "../workflow-stage.ts";
import { getChatWorkflowDefinition } from "../registry.ts";
import { createRuleManagementTools } from "./agents/rule-curator-agent/tools/index.ts";

function resultJson(result) {
  return JSON.parse(result.content[0].text);
}

async function execute(tools, name, params) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute("call-1", params, undefined, undefined, {});
}

async function setupProject(root, id) {
  const chatHome = path.join(root, "home");
  const projectRoot = path.join(root, id);
  fs.mkdirSync(projectRoot, { recursive: true });
  await openProject({
    path: projectRoot,
    chatHome,
    id,
    name: id,
  });
  return { chatHome, projectId: id, projectRoot };
}

function toolContext(project, manager, userPrompt, invocationId) {
  return {
    ...project,
    cwd: project.projectRoot,
    sessionManager: manager,
    invocationId,
    userPrompt,
    workflowId: "rule-management",
    agentId: "rule-curator-agent",
  };
}

function ruleTools(project, manager, userPrompt, invocationId) {
  return createRuleManagementTools(toolContext(project, manager, userPrompt, invocationId), {
    workflowAgentExists: (workflowId, agentId) => getChatWorkflowDefinition(workflowId)
      ?.agents.some((candidate) => candidate.id === agentId) === true,
    loadStoredAgentConfigs: async (workflowId) => {
      const config = (await resolveChatConfig(project.projectId, project.chatHome)).effective;
      return getStoredAgentConfigs(config, workflowId);
    },
  });
}

async function createResource(store, title) {
  const draft = await store.createDraft({
    kind: "rule",
    title,
    purpose: `Purpose for ${title}`,
    content: `Content for ${title}`,
    tags: ["test"],
    author: { type: "user" },
  });
  return store.commitDraft(draft.id);
}

function assistantMessage(text) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    api: "test",
    content: [{ type: "text", text }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

test("Rule Agent reads native Pi Entry IDs and persists only active-branch conversation sources", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-rule-tools-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = await setupProject(root, "context-project");
  const manager = SessionManager.inMemory(project.projectRoot);
  appendChatWorkflowStage(manager, {
    invocationId: "discussion-1",
    workflowId: "minimal-pi-coding-agent",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  const userEntryId = manager.appendMessage({
    role: "user",
    content: "移动端还要处理底部安全区。",
    timestamp: 1,
  });
  const assistantEntryId = manager.appendMessage(assistantMessage("把安全区作为Chat前端规则。"));
  manager.branch(userEntryId);
  const abandonedEntryId = manager.appendMessage(assistantMessage("这条回复位于已放弃的分支。"));
  manager.branch(assistantEntryId);

  appendChatWorkflowStage(manager, {
    invocationId: "capture-1",
    workflowId: "rule-management",
    stageId: "manage",
    agentId: "rule-curator-agent",
  });
  const currentUserEntryId = manager.appendMessage({
    role: "user",
    content: "把刚才关于移动端安全区的讨论整理成规则。",
    timestamp: 3,
  });
  appendChatWorkflowAgentInput(manager, {
    invocationId: "capture-1",
    workflowId: "rule-management",
    stageId: "manage",
    agentId: "rule-curator-agent",
    inputEntryIds: [currentUserEntryId],
  });
  const currentAssistantEntryId = manager.appendMessage(assistantMessage("正在读取Session上下文。"));
  const tools = ruleTools(
    project,
    manager,
    "把刚才关于移动端安全区的讨论整理成规则。",
    "capture-1",
  );

  const context = resultJson(await execute(tools, "session_context_read", { limit: 20 }));
  assert.equal(context.sessionId, manager.getSessionId());
  assert.deepEqual(context.entries.map((entry) => entry.entryId), [userEntryId, assistantEntryId, currentUserEntryId]);
  assert.equal(context.entries[0].workflow.invocationId, "discussion-1");
  assert.equal(context.entries[2].currentRequest, true);
  assert.equal(context.entries[2].text, "把刚才关于移动端安全区的讨论整理成规则。");
  assert.equal(context.entries.some((entry) => entry.entryId === currentAssistantEntryId), false);

  const created = resultJson(await execute(tools, "prompt_resource_create_draft", {
    kind: "rule",
    title: "Chat移动端安全区",
    purpose: "避免PWA底部操作被系统区域遮挡",
    content: "移动端固定操作区必须适配系统安全区。",
    tags: ["frontend", "mobile"],
    context: "用户与Agent在当前Session讨论了Chat PWA底部安全区。",
    entryIds: [userEntryId, assistantEntryId],
  }));
  assert.deepEqual(created.draft.sources[0].entryIds, [userEntryId, assistantEntryId]);

  await assert.rejects(execute(tools, "prompt_resource_create_draft", {
    kind: "rule",
    title: "Invalid source",
    purpose: "Reject invalid source entries",
    content: "Do not persist invalid source entries.",
    context: "Invalid source test.",
    entryIds: [abandonedEntryId, currentAssistantEntryId],
  }), /当前Session活动分支的可引用上下文/);
});

test("Rule Agent commits only the Draft ID confirmed in the current turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-rule-tools-confirm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = await setupProject(root, "confirm-project");
  const manager = SessionManager.inMemory(project.projectRoot);
  const sourceEntryId = manager.appendMessage({
    role: "user",
    content: "Keep module and storage boundaries explicit.",
    timestamp: 1,
  });
  const createTools = ruleTools(project, manager, "创建两条规则草稿", "invocation-1");
  const create = (title) => execute(createTools, "prompt_resource_create_draft", {
    kind: "rule",
    title,
    purpose: "Protect module boundaries",
    content: "Keep every public interface narrow.",
    tags: ["architecture"],
    context: "The current Session identified an oversized module.",
    entryIds: [sourceEntryId],
  }).then(resultJson);
  const first = await create("Keep boundaries explicit");
  const second = await create("Keep storage explicit");
  const store = await getPromptResourceStore({ type: "project", projectId: project.projectId }, project.chatHome);
  assert.equal((await store.listDrafts()).length, 2);

  const firstConfirmationTools = ruleTools(
    project,
    manager,
    first.confirmationPhrase,
    "invocation-2",
  );
  await assert.rejects(execute(firstConfirmationTools, "prompt_resource_commit_draft", {
    target: { type: "project", projectId: project.projectId },
    draftId: second.draft.id,
    userConfirmation: second.confirmationPhrase,
  }), /当前用户消息必须包含/);
  assert.equal(await store.get(second.draft.id), undefined);

  const committed = resultJson(await execute(firstConfirmationTools, "prompt_resource_commit_draft", {
    target: { type: "project", projectId: project.projectId },
    draftId: first.draft.id,
    userConfirmation: first.confirmationPhrase,
  }));
  assert.equal(committed.resource.revision, 1);
  assert.equal(committed.resource.target.projectId, project.projectId);
  assert.equal(committed.resource.sources[0].projectId, project.projectId);
  assert.equal(committed.resource.sources[0].sessionId, manager.getSessionId());
});

test("Rule Agent proposal preserves manual choices and replaces prior Agent choices after confirmation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-rule-tools-apply-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = await setupProject(root, "apply-project");
  const manager = SessionManager.inMemory(project.projectRoot);
  const target = { type: "project", projectId: project.projectId };
  const store = await getPromptResourceStore(target, project.chatHome);
  const manual = await createResource(store, "Manual rule");
  const oldAgent = await createResource(store, "Old Agent rule");
  const recommended = await createResource(store, "Recommended rule");
  setChatWorkflowAgentPromptResources(manager, {
    workflowId: "minimal-pi-coding-agent",
    agentId: "pi-coding-agent",
    promptResources: [
      { id: manual.id, target, selectedBy: "user" },
      { id: oldAgent.id, target, selectedBy: "agent", reason: "old recommendation" },
    ],
    actorAgentId: "rule-curator-agent",
  });

  const proposalTools = ruleTools(project, manager, "提出建议", "invocation-2");
  const proposed = resultJson(await execute(proposalTools, "prompt_resource_propose_for_agent", {
    targetWorkflowId: "minimal-pi-coding-agent",
    targetAgentId: "pi-coding-agent",
    resources: [{ target, resourceId: recommended.id, reason: "matches the next coding task" }],
    summary: "Use the recommended coding rule.",
  }));
  assert.equal(proposed.status, "pending");
  assert.equal(collectChatPromptResourceProposals(manager.getEntries())[0].resolution, undefined);
  assert.equal(collectLatestChatWorkflowConfigurations(manager.getEntries())
    ["minimal-pi-coding-agent"]["pi-coding-agent"].promptResources[1].id, oldAgent.id);

  const applyTools = ruleTools(
    project,
    manager,
    proposed.confirmationPhrase,
    "invocation-3",
  );
  const applied = resultJson(await execute(applyTools, "prompt_resource_apply_proposal", {
    proposalId: proposed.proposalId,
    userConfirmation: proposed.confirmationPhrase,
  }));
  assert.equal(applied.status, "applied");
  const selected = collectLatestChatWorkflowConfigurations(manager.getEntries())
    ["minimal-pi-coding-agent"]["pi-coding-agent"].promptResources;
  assert.deepEqual(selected, [
    { id: manual.id, target, selectedBy: "user" },
    { id: recommended.id, target, selectedBy: "agent", reason: "matches the next coding task" },
  ]);
  assert.equal(collectChatPromptResourceProposals(manager.getEntries())[0].resolution.status, "applied");
});

test("Rule Agent dismisses a rejected proposal without changing Agent configuration", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-rule-tools-dismiss-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = await setupProject(root, "dismiss-project");
  const manager = SessionManager.inMemory(project.projectRoot);
  const target = { type: "project", projectId: project.projectId };
  const store = await getPromptResourceStore(target, project.chatHome);
  const resource = await createResource(store, "Rejected rule");
  const proposalTools = ruleTools(project, manager, "提出建议", "invocation-3");
  const proposed = resultJson(await execute(proposalTools, "prompt_resource_propose_for_agent", {
    targetWorkflowId: "minimal-pi-coding-agent",
    targetAgentId: "pi-coding-agent",
    resources: [{ target, resourceId: resource.id, reason: "candidate" }],
    summary: "Candidate rule.",
  }));

  const wrongTools = ruleTools(project, manager, "不要这个建议", "invocation-4");
  await assert.rejects(execute(wrongTools, "prompt_resource_dismiss_proposal", {
    proposalId: proposed.proposalId,
    userRejection: proposed.rejectionPhrase,
  }), /当前用户消息必须包含/);
  const dismissTools = ruleTools(
    project,
    manager,
    proposed.rejectionPhrase,
    "invocation-5",
  );
  const dismissed = resultJson(await execute(dismissTools, "prompt_resource_dismiss_proposal", {
    proposalId: proposed.proposalId,
    userRejection: proposed.rejectionPhrase,
  }));

  assert.equal(dismissed.status, "dismissed");
  assert.equal(collectChatPromptResourceProposals(manager.getEntries())[0].resolution.status, "dismissed");
  assert.deepEqual(collectLatestChatWorkflowConfigurations(manager.getEntries()), {});
});
