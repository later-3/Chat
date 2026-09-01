import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_AGENT } from "./agents/memory-agent/index.ts";
import {
  MEMORY_MANAGEMENT_TOOL_NAMES,
  createMemoryManagementTools,
} from "./agents/memory-agent/tools/index.ts";
import { createMemorySearchTool } from "../../tools/builtins/memory-search/index.ts";
import { createMemoryRecordTool } from "../../tools/builtins/memory-record/index.ts";

const MEMORY_TOOL_NAMES = [...MEMORY_MANAGEMENT_TOOL_NAMES, "memory_search", "memory_record"];

function record(overrides = {}) {
  return {
    id: "memory-personal",
    text: "Later偏好简洁的Agent架构。",
    kind: "preference",
    scope: "personal",
    projectId: null,
    groupId: "group-1",
    metadata: {},
    sourceSessionId: null,
    sourceProjectId: null,
    sourceEntryIds: [],
    sourceWorkflowInvocationId: null,
    status: "active",
    version: 1,
    mem0Id: "mem0-personal",
    indexStatus: "indexed",
    indexError: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test("Memory Agent combines public search/record with private management tools", () => {
  assert.equal(MEMORY_AGENT.id, "memory-agent");
  assert.equal(MEMORY_AGENT.systemPrompt.mode, "replace");
  assert.match(MEMORY_AGENT.systemPrompt.text, /Memory Skill/);
  assert.deepEqual(MEMORY_AGENT.tools, {
    mode: "explicit",
    names: MEMORY_MANAGEMENT_TOOL_NAMES,
    exclude: [],
    addresses: ["system:tool/memory_search", "system:tool/memory_record"],
  });
  assert.deepEqual(MEMORY_AGENT.resources, {
    mode: "explicit",
    skillPaths: [],
    extensionPaths: [],
    pluginSources: [],
  });
});

test("Memory tools preserve provenance and support Personal, current and cross-Project targets", async () => {
  const personalMemory = record();
  const projectMemory = record({
    id: "memory-project",
    text: "Chat使用Mem0。",
    kind: "decision",
    scope: "project",
    projectId: "chat",
    mem0Id: "mem0-project",
  });
  const calls = [];
  const manager = {
    createMany: async (targets, input) => {
      calls.push(["createMany", targets, input]);
      return targets.map((target) => ({ target, memory: target.type === "personal" ? personalMemory : projectMemory }));
    },
    search: async (input) => {
      calls.push(["search", input]);
      return [{ memory: projectMemory, score: 0.9 }, { memory: personalMemory, score: 0.8 }];
    },
    list: async (target, input) => {
      calls.push(["list", target, input]);
      return { items: [projectMemory], total: 1, limit: 50, offset: 0 };
    },
    get: async ({ memoryId }) => memoryId === personalMemory.id ? personalMemory : projectMemory,
    update: async (_address, input) => record({ ...projectMemory, ...input, version: 2 }),
    delete: async ({ memoryId }) => ({ id: memoryId, deleted: true, indexCleanup: "completed" }),
  };
  const context = {
    manager,
    purpose: "execution",
    projectId: "chat",
    chatHome: "/tmp/chat-home",
    cwd: "/tmp/project",
    sessionManager: {},
    sessionId: "session-1",
    workflowId: "memory",
    workflowInvocationId: "invocation-1",
    stageId: "manage",
    agentId: "memory-agent",
    toolAddress: "system:tool/memory_test",
    toolVersion: "system:memory-test@1",
  };
  const tools = [
    ...createMemoryManagementTools(context),
    createMemorySearchTool({ ...context, toolAddress: "system:tool/memory_search" }),
    createMemoryRecordTool({ ...context, toolAddress: "system:tool/memory_record" }),
  ];
  assert.deepEqual(tools.map((tool) => tool.name), MEMORY_TOOL_NAMES);

  await toolByName(tools, "memory_record").execute("call-add", {
    text: "Chat使用Mem0。",
    kind: "decision",
    targets: [{ type: "project", projectId: "content-lab" }, { type: "personal" }],
  });
  assert.deepEqual(calls[0], ["createMany", [
    { type: "project", projectId: "content-lab" },
    { type: "personal" },
  ], {
    text: "Chat使用Mem0。",
    kind: "decision",
    metadata: { managedBy: "memory-agent" },
    source: {
      projectId: "chat",
      sessionId: "session-1",
      workflowId: "memory",
      workflowInvocationId: "invocation-1",
      stageId: "manage",
      agentId: "memory-agent",
      toolCallId: "call-add",
      toolAddress: "system:tool/memory_record",
      toolVersion: "system:memory-test@1",
    },
  }]);

  const searchResult = await toolByName(tools, "memory_search").execute("call-search", {
    query: "架构",
    topK: 5,
  });
  assert.deepEqual(calls[1][1].targets, [
    { type: "personal" },
    { type: "project", projectId: "chat" },
  ]);
  assert.deepEqual(calls[1][1].source, {
    projectId: "chat",
    sessionId: "session-1",
    workflowId: "memory",
    workflowInvocationId: "invocation-1",
    stageId: "manage",
    agentId: "memory-agent",
    toolCallId: "call-search",
    toolAddress: "system:tool/memory_search",
    toolVersion: "system:memory-test@1",
  });
  assert.deepEqual(searchResult.details.map((item) => item.id), ["memory-project", "memory-personal"]);

  await toolByName(tools, "memory_list").execute("call-list", {});
  assert.deepEqual(calls[2], ["list", { type: "project", projectId: "chat" }, { status: "active" }]);
});

test("Memory update and delete require the version returned by a previous read", async () => {
  const current = record({ version: 3 });
  const manager = {
    get: async () => current,
    update: async () => record({ version: 4 }),
    delete: async ({ memoryId }) => ({ id: memoryId, deleted: true, indexCleanup: "completed" }),
  };
  const tools = createMemoryManagementTools({
    manager,
    projectId: "chat",
    sessionId: "session-1",
    workflowId: "memory",
    workflowInvocationId: "invocation-1",
    stageId: "manage",
    agentId: "memory-agent",
  });

  await assert.rejects(
    toolByName(tools, "memory_update").execute("call-update", {
      memoryId: current.id,
      target: { type: "personal" },
      expectedVersion: 2,
      text: "new text",
    }),
    /changed from version 2 to 3/,
  );
  await assert.rejects(
    toolByName(tools, "memory_delete").execute("call-delete", {
      memoryId: current.id,
      target: { type: "personal" },
      expectedVersion: 2,
    }),
    /changed from version 2 to 3/,
  );
});
