import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { subscribeAgentSessionLog } from "../workflows/agent-session-log.ts";
import { collectChatToolExecutions } from "./execution-record.ts";

test("Tool lifecycle persists one Chat execution fact outside model context", async () => {
  const manager = SessionManager.inMemory("/tmp/chat-tool-trace");
  let listener;
  const session = {
    getAllTools: () => [{
      name: "memory_search",
      sourceInfo: { path: "<sdk:memory_search>", source: "sdk", scope: "temporary", origin: "top-level" },
    }],
    subscribe: (next) => {
      listener = next;
      return () => { listener = undefined; };
    },
  };
  const observer = subscribeAgentSessionLog(session, "planner", {
    workflowId: "planning-execution",
    stageId: "plan",
    nodeKind: "agent",
    agentId: "planner",
  }, {
    sessionManager: manager,
    projectId: "chat",
    workflowInvocationId: "invocation-1",
    toolResources: [{
      name: "memory_search",
      address: "system:tool/memory_search",
      version: "system:memory-search@1",
    }],
  });

  listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "memory_search", args: { query: "偏好" } });
  listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "memory_search", result: {}, isError: false });

  const records = collectChatToolExecutions(manager.getEntries());
  assert.equal(records.length, 1);
  assert.deepEqual({
    toolCallId: records[0].toolCallId,
    toolAddress: records[0].toolAddress,
    toolVersion: records[0].toolVersion,
    workflowInvocationId: records[0].workflowInvocationId,
    status: records[0].status,
  }, {
    toolCallId: "call-1",
    toolAddress: "system:tool/memory_search",
    toolVersion: "system:memory-search@1",
    workflowInvocationId: "invocation-1",
    status: "completed",
  });
  assert.deepEqual(manager.buildSessionContext().messages, []);
  await observer.finish(false);
});
