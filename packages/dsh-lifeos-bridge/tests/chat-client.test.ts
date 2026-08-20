import assert from "node:assert/strict";
import test from "node:test";
import { ChatProductClient } from "../src/chat-client.ts";
import { promptSelectionRequestSchema, workflowSelectionSchema } from "../src/contracts.ts";

const finalMessage = {
  schemaVersion: "chat-product-api.v1",
  messageId: "msg_final1",
  sessionId: "psn_history1",
  sessionSequence: 20_001,
  role: "assistant",
  content: { format: "markdown", text: "长会话中的正式回复" },
  sourceRunId: "run_history1",
  sha256: "a".repeat(64),
  createdAt: "2026-08-16T00:00:00.000Z",
} as const;

test("final message lookup uses the public exact query without scanning history", async () => {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Response(JSON.stringify({ message: finalMessage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), fetchImpl);
  assert.deepEqual(
    await client.getMessage(finalMessage.sessionId, finalMessage.messageId),
    finalMessage,
  );
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0]?.pathname,
    `/api/sessions/${finalMessage.sessionId}/messages/${finalMessage.messageId}`,
  );
  assert.equal(urls[0]?.search, "");
});

test("session records consume the public Product Session and opaque Message cursor queries", async () => {
  const urls: URL[] = [];
  const session = {
    schemaVersion: "chat-product-api.v1",
    sessionId: finalMessage.sessionId,
    status: "active",
    title: "历史记录",
    revision: 2,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  } as const;
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return url.pathname.endsWith("/messages")
      ? new Response(JSON.stringify({ items: [finalMessage], nextCursor: "opaque-next" }), {
          status: 200,
        })
      : new Response(JSON.stringify({ session }), { status: 200 });
  });
  assert.deepEqual(await client.getSession(session.sessionId), session);
  assert.deepEqual(await client.getMessages(session.sessionId, "opaque-current", 50), {
    items: [finalMessage],
    nextCursor: "opaque-next",
  });
  assert.equal(urls[0]?.pathname, `/api/sessions/${session.sessionId}`);
  assert.equal(urls[0]?.search, "");
  assert.equal(urls[1]?.pathname, `/api/sessions/${session.sessionId}/messages`);
  assert.equal(urls[1]?.searchParams.get("cursor"), "opaque-current");
  assert.equal(urls[1]?.searchParams.get("limit"), "50");
});

test("Prompt Studio forwards workspace, scope filters, and semantic preview contracts", async () => {
  const requests: Array<{ url: URL; method: string; body?: unknown }> = [];
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    });
    if (url.pathname === "/api/prompt-workspaces") {
      return new Response(
        JSON.stringify({
          schemaVersion: "chat-prompt-studio-api.v1",
          items: [
            { schemaVersion: "chat-prompt-studio-api.v1", rootId: "root_chat", title: "Chat" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.pathname === "/api/prompt-fragments") {
      return new Response(
        JSON.stringify({ schemaVersion: "chat-prompt-studio-api.v1", items: [] }),
        { status: 200 },
      );
    }
    if (url.pathname === "/api/prompt-configuration-previews") {
      return new Response(
        JSON.stringify({
          schemaVersion: "chat-prompt-studio-api.v1",
          profileVersion: "direct-agent-prompt-profile.v1",
          compilerVersion: "direct-agent-prompt-compiler.v1",
          regions: [],
          systemPromptAppend: "",
          messageContext: "配置正文",
          sha256: "a".repeat(64),
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        schemaVersion: "chat-prompt-studio-api.v1",
        profileVersion: "direct-agent-prompt-profile.v1",
        compilerVersion: "direct-agent-prompt-compiler.v1",
        regions: [],
        systemPromptAppend: "",
        userPrompt: "# 当前输入\n测试",
        sha256: "a".repeat(64),
      }),
      { status: 200 },
    );
  });

  assert.equal((await client.getPromptWorkspaces()).items[0]?.rootId, "root_chat");
  await client.listPromptFragments({
    limit: 100,
    scopeKind: "workspace",
    workspaceRootId: "root_chat",
  });
  const selection = {
    schemaVersion: "prompt-turn-selection-input.v1" as const,
    workspaceRootId: "root_chat",
    regions: [],
  };
  assert.equal(
    (await client.previewPromptAssembly({ text: "测试", selection })).userPrompt,
    "# 当前输入\n测试",
  );
  assert.equal((await client.previewPromptConfiguration({ selection })).messageContext, "配置正文");

  assert.equal(requests[1]?.url.searchParams.get("scopeKind"), "workspace");
  assert.equal(requests[1]?.url.searchParams.get("workspaceRootId"), "root_chat");
  assert.deepEqual(requests[2], {
    url: new URL("http://127.0.0.1:1/api/prompt-assembly-previews"),
    method: "POST",
    body: { text: "测试", selection },
  });
  assert.deepEqual(requests[3], {
    url: new URL("http://127.0.0.1:1/api/prompt-configuration-previews"),
    method: "POST",
    body: { selection },
  });
});

test("submitMessage sends Prompt selection only for the Direct workflow", async () => {
  const bodies: unknown[] = [];
  const submittedMessage = {
    schemaVersion: "chat-product-api.v1",
    messageId: "msg_promptuser1",
    sessionId: "psn_prompt1",
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "测试" },
    sha256: "b".repeat(64),
    createdAt: "2026-08-20T00:00:00.000Z",
  } as const;
  const submittedRun = {
    schemaVersion: "chat-product-api.v1",
    productRunId: "run_prompt1",
    sessionId: "psn_prompt1",
    sourceMessageId: "msg_promptuser1",
    runKind: "direct_agent",
    status: "running",
    phase: "executing",
    allowedActions: [],
    revision: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  } as const;
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ message: submittedMessage, run: submittedRun }), {
      status: 201,
    });
  });
  const direct = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "c".repeat(64),
    title: "执行 Agent",
    blueprintKey: "direct",
  });
  const planning = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemplanningv2",
    definitionSha256: "d".repeat(64),
    title: "默认规划",
    blueprintKey: "planning",
  });
  const selection = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1",
    workspaceRootId: "root_chat",
    regions: [],
  });

  await client.submitMessage(
    "psn_prompt1",
    `cmd_${"a".repeat(48)}`,
    "测试",
    undefined,
    direct,
    undefined,
    selection,
  );
  await client.submitMessage(
    "psn_prompt1",
    `cmd_${"e".repeat(48)}`,
    "测试",
    undefined,
    planning,
    undefined,
    selection,
  );
  assert.deepEqual(
    (bodies[0] as { payload?: { promptSelection?: unknown } }).payload?.promptSelection,
    selection,
  );
  assert.equal(
    (bodies[1] as { payload?: { promptSelection?: unknown } }).payload?.promptSelection,
    undefined,
  );
});
