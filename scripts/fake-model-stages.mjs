/**
 * Shared fake-model stage routing.
 *
 * A Workflow's LAST node is the session-memory writer, and its request carries the SAME round history as
 * the work turn. A fake model that routes on historical markers (a user message, a tool result, a marker
 * anywhere in the conversation) therefore hijacks the writer and lets it wait on a gate meant for the work
 * agent — leaving a dangling HTTP response and a Run that never settles.
 *
 * Every fake model must route on the CURRENT agent/stage, not on history. These helpers are the one place
 * that decides "is this request the memory writer?".
 */
export const SESSION_MEMORY_WRITER_MARK = "你只负责维护";

/** True when the request's SYSTEM prompt belongs to the session-memory writer agent. */
export function isSessionMemoryWriterRequest(messages) {
  return messages
    .filter((message) => message.role === "system")
    .some((message) => (typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content)).includes(SESSION_MEMORY_WRITER_MARK));
}

/** A plain assistant answer. */
export function writeAssistantText(response, content, completionId = "chatcmpl-stage", model = "fake-stage-model") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({
    id: completionId, object: "chat.completion.chunk", created: 0, model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: completionId, object: "chat.completion.chunk", created: 0, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

/**
 * A fake-model failure must END the request: an unhandled throw inside the handler leaves HTTP dangling,
 * and the test then fails on a timeout far away from the real cause.
 */
export function writeAssistantError(response, message) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(500, { "Content-Type": "application/json" })
    .end(JSON.stringify({ error: { message: `fake model failed: ${message}` } }));
}
