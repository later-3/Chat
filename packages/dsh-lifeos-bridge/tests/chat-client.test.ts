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
