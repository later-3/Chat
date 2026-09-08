import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { debugHome, ports } from "./debug-environment.mjs";

/** Deterministic local protocol fixture, not an LLM. Never forwards a request externally. */
export function debugModelReply(input) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const userIndex = messages.findLastIndex(message => message.role === "user");
  const current = messages.slice(userIndex);
  const wantsSkill = JSON.stringify(current[0]?.content ?? "").includes("DEBUG_READ_SKILL");
  if (wantsSkill && !current.some(message => message.role === "tool")) {
    if (!input.tools?.some(tool => tool.function?.name === "read")) return { content: "DEBUG_READ_UNAVAILABLE: enable the read Tool." };
    return { tool_calls: [{ index: 0, id: "debug-read-skill", type: "function", function: {
      name: "read", arguments: JSON.stringify({ path: join(debugHome, "workspaces/debug-lab/.chat/skills/debug-trace/SKILL.md") }),
    } }] };
  }
  if (wantsSkill) return { content: JSON.stringify(current).includes("DEBUG_SKILL_LOADED") ? "DEBUG_SKILL_LOADED" : "DEBUG_READ_FAILED" };
  return { content: "DEBUG_OK — local fixture completed; no external model was called." };
}

export function createDebugModelServer() {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const delta = debugModelReply(input);
      // Log shape/count only; system prompts, credentials and private messages stay out of this log.
      console.log(`[debug-model] model=${input.model} messages=${input.messages?.length ?? 0} result=${delta.tool_calls ? "read" : "text"}`);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (delta, finishReason) => `data: ${JSON.stringify({ id: "debug-completion", object: "chat.completion.chunk",
        created: 0, model: "debug-model", choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(finishReason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
      })}\n\n`;
      response.write(frame({ role: "assistant", ...delta }, null));
      response.end(frame({}, delta.tool_calls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDebugModelServer();
  server.listen(ports.model, "127.0.0.1", () => console.log(`Debug model http://127.0.0.1:${ports.model}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
