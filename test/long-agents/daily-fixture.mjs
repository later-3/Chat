import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ensureAgentHomeProject, openProject } from "../../src/projects/registry.ts";
import { writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
export async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-p3-daily-")));
  const home = path.join(root, "home");
  const requests = [];
  let handler = () => ({ content: "ack" });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const delta = await handler(body, res);
    if (delta === undefined) return;
    if (delta.error) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: delta.error } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (change, finish) => ({ id: `p3-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "daily-model",
      choices: [{ index: 0, delta: change, finish_reason: finish }] });
    res.write(`data: ${JSON.stringify(frame({ role: "assistant", ...delta }, null))}\n\n`);
    res.write(`data: ${JSON.stringify({ ...frame({}, delta.tool_calls ? "tool_calls" : "stop"), usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await ensureAgentHomeProject("friend", "Friend", home);
  fs.writeFileSync(path.join(home, "agent/settings.json"), JSON.stringify({ defaultProvider: "p3-local", defaultModel: "daily-model", retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 } }));
  fs.writeFileSync(path.join(home, "agent/models.json"), JSON.stringify({ providers: { "p3-local": {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-test",
    models: [{ id: "daily-model", name: "Local daily", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeLongAgentRegistry({ schemaVersion: 1, instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [{ id: "friend", name: "Friend", description: "Stable", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local", nanoclawAgentGroupId: "group", defaultProjectId: "friend",
      definition: { schemaVersion: 1, id: "friend", name: "Friend", description: "Stable", systemPrompt: { mode: "replace", text: "Stable Friend" }, customInstructions: [],
        tools: { mode: "explicit", names: ["read", "write"], exclude: [], addresses: [] }, resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } } }],
  }, home);
  const snapshotDir = path.join(home, "runtime/long-agents/friend"); fs.mkdirSync(snapshotDir, { recursive: true });
  const hash = `sha256:${"a".repeat(64)}`;
  fs.writeFileSync(path.join(snapshotDir, "agent-group-snapshot.json"), JSON.stringify({ schemaVersion: 1, longAgentId: "friend", agentGroupId: "group", fetchedAt: "2026-09-19T00:00:00Z", snapshot: {
    id: "group", name: "Friend", standingInstructions: "Stable identity", revision: hash, workspace: { folder: "friend", memoryFileCount: 2 }, coreMemory: {
      index: { path: "index.md", content: "index", size: 5, updatedAt: "2026-09-19T00:00:00Z", revision: hash },
      definition: { path: "system/definition.md", content: "definition", size: 10, updatedAt: "2026-09-19T00:00:00Z", revision: hash },
    },
  } }));
  const projects = [];
  for (const id of ["a", "b"]) { const dir = path.join(root, id); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "AGENTS.md"), `RULE_${id}`); projects.push(await openProject({ path: dir, chatHome: home, id, name: id })); }
  return { root, home, requests, projects, setHandler: (value) => { handler = value; },
    input: (id, contextProjectId = null) => ({ chatHome: home, projectId: "friend", longAgentId: "friend", turnId: id, text: id, contextProjectId }) };
}
