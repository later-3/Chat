import assert from "node:assert/strict";
import test from "node:test";
import { prepareBridgeChatDispatch } from "../src/bridge-chat-dispatch.ts";
import { ChatProductClient } from "../src/chat-client.ts";
import { promptSelectionRequestSchema, workflowSelectionSchema } from "../src/contracts.ts";

const timestamp = "2026-08-20T00:00:00.000Z";
const messageCommandId = `cmd_${"b".repeat(48)}`;
const requestKey = "c".repeat(48);
const direct = workflowSelectionSchema.parse({
  workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
  definitionSha256: "d".repeat(64),
  title: "执行 Agent（逐次提示词审核）",
  blueprintKey: "direct",
});
const promptSelection = promptSelectionRequestSchema.shape.promptSelection.parse({
  schemaVersion: "prompt-turn-selection-input.v1",
  workspaceRootId: "root_chat",
  regions: [],
});

function session(sessionId: string, title: string) {
  return {
    schemaVersion: "chat-product-api.v1" as const,
    sessionId,
    status: "active" as const,
    title,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function submission(sessionId: string) {
  const message = {
    schemaVersion: "chat-product-api.v1" as const,
    messageId: "msg_dispatchuser1",
    sessionId,
    sessionSequence: 1,
    role: "user" as const,
    content: { format: "markdown" as const, text: "验证 Bridge 原始正文" },
    sha256: "e".repeat(64),
    createdAt: timestamp,
  };
  return {
    message,
    run: {
      schemaVersion: "chat-product-api.v1" as const,
      productRunId: "run_dispatch1",
      sessionId,
      sourceMessageId: message.messageId,
      runKind: "direct_agent" as const,
      status: "running" as const,
      phase: "executing" as const,
      allowedActions: [],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

test("Bridge首轮只发送一条Message命令且bodyJson与真实fetch字节一致", async () => {
  const requests: Array<{ path: string; method: string; bodyJson: string }> = [];
  const createdSession = session("psn_dispatchnew1", "验证 Bridge 原始正文");
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (input, init) => {
    assert.equal(typeof init?.body, "string");
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      bodyJson: String(init?.body),
    });
    if (url.pathname === "/api/messages") {
      return new Response(
        JSON.stringify({ session: createdSession, ...submission(createdSession.sessionId) }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify(submission(url.pathname.split("/")[3]!)), {
      status: 201,
    });
  });

  const firstPlan = prepareBridgeChatDispatch({
    requestKey,
    messageCommandId,
    text: "验证 Bridge 原始正文",
    workflowSelection: direct,
    promptSelection,
  });
  assert.equal(firstPlan.productSessionId, null);
  const started = await client.submitFirstMessageFromDispatch(firstPlan.submitMessage);

  assert.deepEqual(
    requests.map(({ path, method }) => ({ path, method })),
    [{ path: "/api/messages", method: "POST" }],
  );
  assert.equal(started.session.sessionId, createdSession.sessionId);
  assert.equal(requests[0]?.bodyJson, firstPlan.submitMessage.bodyJson);
  assert.deepEqual(JSON.parse(firstPlan.submitMessage.bodyJson), {
    commandId: messageCommandId,
    payload: {
      text: "验证 Bridge 原始正文",
      workflowSelection: {
        kind: "published_revision",
        workflowDefinitionRevisionId: direct.workflowDefinitionRevisionId,
        definitionSha256: direct.definitionSha256,
      },
      promptSelection,
    },
  });

  const existingSessionId = "psn_dispatchexisting1";
  const secondPlan = prepareBridgeChatDispatch({
    requestKey: "f".repeat(48),
    productSessionId: existingSessionId,
    messageCommandId: `cmd_${"9".repeat(48)}`,
    text: "第二轮继续",
    workflowSelection: direct,
    promptSelection,
  });
  await client.submitMessageFromDispatch(existingSessionId, secondPlan.submitMessage);

  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.path, `/api/sessions/${existingSessionId}/messages`);
  assert.equal(requests[1]?.bodyJson, secondPlan.submitMessage.bodyJson);
  assert.deepEqual(JSON.parse(requests[1]!.bodyJson), {
    commandId: `cmd_${"9".repeat(48)}`,
    payload: {
      text: "第二轮继续",
      workflowSelection: {
        kind: "published_revision",
        workflowDefinitionRevisionId: direct.workflowDefinitionRevisionId,
        definitionSha256: direct.definitionSha256,
      },
      promptSelection,
    },
  });
});
