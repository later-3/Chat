import assert from "node:assert/strict";
import test from "node:test";
import { ChatProductClient } from "../src/chat-client.ts";

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

test("Product Session creation carries the first prompt title instead of a host placeholder", async () => {
  const requests: Array<{ url: URL; body: unknown }> = [];
  const session = {
    schemaVersion: "chat-product-api.v1",
    sessionId: "psn_history1",
    status: "active",
    title: "设计统一会话",
    revision: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  } as const;
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (input, init) => {
    requests.push({
      url: new URL(String(input)),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ session }), { status: 201 });
  });
  assert.deepEqual(await client.createSession(`cmd_${"a".repeat(48)}`, session.title), session);
  assert.equal(requests[0]?.url.pathname, "/api/sessions");
  assert.deepEqual(requests[0]?.body, {
    commandId: `cmd_${"a".repeat(48)}`,
    payload: { title: "设计统一会话" },
  });
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
