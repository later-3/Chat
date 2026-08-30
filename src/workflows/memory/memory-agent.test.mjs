import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_AGENT } from "./agents/memory-agent/index.ts";
import { MEMORY_TOOL_NAMES, createMemoryTools } from "./agents/memory-agent/tools/index.ts";

function record(overrides = {}) {
  return {
    id: "memory-global",
    text: "Later偏好简洁的Agent架构。",
    kind: "preference",
    scope: "global",
    projectId: null,
    metadata: {},
    sourceSessionId: null,
    sourceEntryIds: [],
    sourceWorkflowInvocationId: null,
    status: "active",
    version: 1,
    mem0Id: "mem0-global",
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

test("Memory Agent is restricted to the six Chat-owned Memory tools", () => {
  assert.equal(MEMORY_AGENT.id, "memory-agent");
  assert.equal(MEMORY_AGENT.systemPrompt.mode, "replace");
  assert.match(MEMORY_AGENT.systemPrompt.text, /Memory Skill/);
  assert.deepEqual(MEMORY_AGENT.tools, {
    mode: "explicit",
    names: MEMORY_TOOL_NAMES,
    exclude: [],
  });
  assert.deepEqual(MEMORY_AGENT.resources, {
    mode: "explicit",
    skillPaths: [],
    extensionPaths: [],
    pluginSources: [],
  });
});

test("Memory tools inject provenance and keep project memories inside the current project", async () => {
  const globalMemory = record();
  const projectMemory = record({
    id: "memory-project",
    text: "Chat使用Mem0。",
    kind: "decision",
    scope: "project",
    projectId: "/workspace/chat",
    mem0Id: "mem0-project",
  });
  const calls = [];
  const service = {
    create: async (input) => {
      calls.push(["create", input]);
      return projectMemory;
    },
    search: async (input) => {
      calls.push(["search", input]);
      return input.scope === "global"
        ? [{ memory: globalMemory, score: 0.8 }]
        : [{ memory: projectMemory, score: 0.9 }];
    },
    list: (input) => {
      calls.push(["list", input]);
      return { items: [globalMemory], total: 1, limit: 50, offset: 0 };
    },
    get: (id) => id === globalMemory.id ? globalMemory : projectMemory,
    update: async (_id, input) => record({ ...projectMemory, ...input, version: 2 }),
    delete: async (id) => ({ id, deleted: true, indexCleanup: "completed" }),
  };
  const tools = createMemoryTools({
    service,
    projectId: "/workspace/chat",
    sessionId: "session-1",
    workflowInvocationId: "invocation-1",
  });
  assert.deepEqual(tools.map((tool) => tool.name), MEMORY_TOOL_NAMES);

  await toolByName(tools, "memory_add").execute("call-add", {
    text: "Chat使用Mem0。",
    kind: "decision",
    scope: "project",
  });
  assert.deepEqual(calls[0], ["create", {
    text: "Chat使用Mem0。",
    kind: "decision",
    scope: "project",
    projectId: "/workspace/chat",
    metadata: { managedBy: "memory-agent" },
    source: { sessionId: "session-1", workflowInvocationId: "invocation-1" },
  }]);

  const searchResult = await toolByName(tools, "memory_search").execute("call-search", {
    query: "架构",
    topK: 5,
  });
  assert.deepEqual(calls.slice(1, 3).map((call) => call[1].scope), ["global", "project"]);
  assert.equal(calls[2][1].projectId, "/workspace/chat");
  assert.deepEqual(searchResult.details.map((item) => item.id), ["memory-project", "memory-global"]);

  await toolByName(tools, "memory_list").execute("call-list", {});
  assert.deepEqual(calls[3], ["list", { scope: "global", status: "active" }]);
});

test("Memory update and delete require the version returned by a previous read", async () => {
  const current = record({ version: 3 });
  const service = {
    get: () => current,
    update: async () => record({ version: 4 }),
    delete: async (id) => ({ id, deleted: true, indexCleanup: "completed" }),
  };
  const tools = createMemoryTools({
    service,
    projectId: "/workspace/chat",
    sessionId: "session-1",
    workflowInvocationId: "invocation-1",
  });

  await assert.rejects(
    toolByName(tools, "memory_update").execute("call-update", {
      memoryId: current.id,
      expectedVersion: 2,
      text: "new text",
    }),
    /changed from version 2 to 3/,
  );
  await assert.rejects(
    toolByName(tools, "memory_delete").execute("call-delete", {
      memoryId: current.id,
      expectedVersion: 2,
    }),
    /changed from version 2 to 3/,
  );
});
