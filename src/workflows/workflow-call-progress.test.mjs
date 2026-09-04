import assert from "node:assert/strict";
import test from "node:test";
import { forwardWorkflowCallProgress } from "./workflow-call-progress.ts";

test("Workflow Call progress forwards only safe child lifecycle summaries", async () => {
  const events = [
    {
      type: "stage_start",
      stage: { workflowId: "child", stageId: "execute", nodeKind: "agent", agentId: "worker" },
    },
    {
      type: "agent_event",
      stage: { workflowId: "child", stageId: "execute", nodeKind: "agent", agentId: "worker" },
      event: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "secret child output" }] },
      },
    },
    {
      type: "agent_event",
      stage: { workflowId: "child", stageId: "execute", nodeKind: "agent", agentId: "worker" },
      event: {
        type: "tool_execution_start",
        toolCallId: "child-tool-call",
        toolName: "bash",
        args: { command: "secret command" },
      },
    },
  ];
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      controller.close();
    },
  });
  const progress = [];
  const forwarder = forwardWorkflowCallProgress({
    readable,
    base: {
      callId: "call-1",
      workflowId: "child",
      workflowInvocationId: "child-invocation",
      sessionId: "child-session",
      runId: "child-run",
      startedAt: new Date(Date.now() - 10).toISOString(),
    },
    onProgress: (value) => progress.push(value),
  });

  await forwarder.stop();

  assert.deepEqual(progress.map(({ phase, stageId, agentId, childToolName }) => ({
    phase,
    stageId,
    agentId,
    ...(childToolName === undefined ? {} : { childToolName }),
  })), [
    { phase: "workflow_stage", stageId: "execute", agentId: "worker" },
    { phase: "child_tool", stageId: "execute", agentId: "worker", childToolName: "bash" },
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /secret child output|secret command/);
});
