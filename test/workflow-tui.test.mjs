import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatApi, serverUrl } from "../cli/src/api.ts";
import { parseTranscript } from "../cli/src/contract.ts";
import { ChatTerminalView } from "../cli/src/tui.ts";
import { VirtualTerminal } from "../pi/packages/tui/test/virtual-terminal.ts";
import { WorkflowTerminal } from "../cli/src/controller.ts";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("CLI connects directly, decodes split NDJSON and rejects redirects", async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie });
    if (req.url.startsWith("/runs/")) {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const bytes = Buffer.from('{"text":"中文"}\n{"last":true}');
      res.write(bytes.subarray(0, 11)); setTimeout(() => res.end(bytes.subarray(11)), 5);
    } else if (req.url === "/redirect") { res.writeHead(302, { location: "/leak" }); res.end(); }
    else { res.writeHead(401); res.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const api = new ChatApi(url);
  const events = []; await api.events("run", new AbortController().signal, (event) => events.push(event));
  assert.deepEqual(events, [{ text: "中文" }, { last: true }]);
  assert.equal(seen.at(-1).cookie, undefined);
  await assert.rejects(api.json("/redirect")); assert.ok(!seen.some((r) => r.url === "/leak"));
  await assert.rejects(api.json("/expired"), /401/);
  for (const invalid of ["http://remote.example", "https://user:secret@host", "https://host/path", "file:///tmp/a"]) assert.throws(() => serverUrl(invalid));

});

test("native Pi UI renders Chinese history and handles selectors, editing and terminal resize", async () => {
  const terminal = new VirtualTerminal(100, 30);
  const view = new ChatTerminalView(terminal);
  view.start();
  try {
    view.history([{ id: "u", parentId: null, timestamp: "now", type: "message", message: { role: "user", content: "你好，Workflow" } },
      { id: "a", parentId: "u", timestamp: "now", type: "message", message: { role: "assistant", content: [{ type: "text", text: "这是完整历史" }] } }]);
    view.status("daily · idle");
    await terminal.waitForRender();
    assert.match(terminal.getViewport().join("\n"), /这是完整历史/);
    const selected = view.select("选择 Workflow", [{ id: "one", label: "第一个" }, { id: "two", label: "第二个" }]);
    await terminal.waitForRender(); terminal.sendInput("\x1b[B"); terminal.sendInput("\r");
    assert.equal(await selected, "two");
    let input; view.editor.onSubmit = (text) => { input = text; };
    terminal.sendInput("终端输入"); terminal.sendInput("\r"); assert.equal(input, "终端输入");
    assert.equal(view.editor.getText(), "");
    terminal.resize(42, 16); await terminal.waitForRender();
    assert.match(terminal.getViewport().join("\n"), /daily/);
    view.draft("尚未发送"); view.history([]); assert.equal(view.editor.getText(), "尚未发送");
    const cancelled = view.select("取消", [{ id: "one", label: "one" }]); terminal.sendInput("\x1b"); assert.equal(await cancelled, undefined);
  } finally { view.stop(); }
});

test("versioned transcript rejects malformed native messages before rendering", () => {
  const base = { schemaVersion: 1, projectId: "p", sessionId: "s", name: "name", leafId: null, revision: "r", workflowId: null, nextCursor: null, activeRun: null, entries: [] };
  assert.equal(parseTranscript(base).sessionId, "s");
  assert.throws(() => parseTranscript({ ...base, schemaVersion: 2 }), /版本/);
  assert.throws(() => parseTranscript({ ...base, entries: [{ id: "e", parentId: null, timestamp: "now", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: [] }] } }] }));
});

test("native edit rendering uses the server diff without inspecting the client's file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chat-cli-edit-"));
  const file = join(dir, "local.txt"); await writeFile(file, "LOCAL_PRIVATE_CONTEXT\nold\n");
  const original = fsPromises.readFile; let reads = 0;
  t.mock.method(fsPromises, "readFile", (...args) => { if (args[0] === file) reads++; return original(...args); });
  syncBuiltinESMExports();
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); });
  const terminal = new VirtualTerminal(100, 30); const view = new ChatTerminalView(terminal); view.start();
  try {
    view.event({ type: "agent_event", event: { type: "tool_execution_start", toolCallId: "edit-call", toolName: "edit", args: { path: file, oldText: "old", newText: "new" } } });
    await terminal.waitForRender();
    assert.equal(reads, 0);
    view.event({ type: "agent_event", event: { type: "message_end", message: { role: "toolResult", toolCallId: "edit-call", toolName: "edit", isError: false, content: [{ type: "text", text: "Updated on server" }], details: { diff: "-1 old\n+1 REMOTE_RESULT", firstChangedLine: 1 } } } });
    await terminal.waitForRender();
    const screen = terminal.getViewport().join("\n");
    assert.match(screen, /REMOTE_RESULT/); assert.doesNotMatch(screen, /LOCAL_PRIVATE_CONTEXT/);
    assert.equal(reads, 0);
  } finally { view.stop(); }
});

test("controller discovers a user Project, recovers a lost acceptance and reports terminal failure without resubmitting", async (t) => {
  let submissions = 0;
  let active = null;
  let revision = "1";
  const run = { runId: "run", workflowInvocationId: "invocation", projectId: "recent", workflowId: "workflow", phase: "executing" };
  const server = createServer(async (req, res) => {
    const send = (data) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
    if (req.url === "/api/workflows") send({ workflows: [{ id: "workflow", name: "Workflow" }] });
    else if (req.url === "/api/projects") send({ projects: [
      { projectId: "shared", kind: "share", available: true, lastOpenedAt: "2026-09-19" },
      { projectId: "old", kind: "project", available: true, lastOpenedAt: "2026-09-17" },
      { projectId: "recent", kind: "project", available: true, lastOpenedAt: "2026-09-18" },
    ] });
    else if (req.url.startsWith("/api/chat-config")) send({ defaultWorkflowId: "workflow" });
    else if (req.url === "/runs" && req.method === "POST") {
      submissions++; active = run; req.socket.destroy();
    } else if (req.url.includes("/transcript?")) send({ schemaVersion: 1, projectId: "recent", sessionId: "session", name: "Fixture", leafId: null, workflowId: "workflow", revision, nextCursor: null, entries: [], activeRun: active });
    else if (req.url.includes("/events?")) { res.setHeader("Content-Type", "application/x-ndjson"); res.end("invalid\n"); }
    else if (req.url.startsWith("/runs/run?")) send({ runId: "run", status: "failed", error: "fixture model failure" });
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = new ChatApi(`http://127.0.0.1:${server.address().port}`);
  const notices = []; let draft;
  const view = { history() {}, status() {}, notice: (value) => notices.push(value), draft: (value) => { draft = value; }, event() {}, select: async () => undefined };
  const client = new WorkflowTerminal(api, view, undefined, "session");
  t.after(() => client.stop());
  await client.initialize(); assert.equal(client.projectId, "recent");
  await assert.rejects(client.submit("lost acceptance")); assert.equal(draft, "lost acceptance");
  await client.refresh(); assert.equal(client.snapshot.activeRun.runId, "run");
  await assert.rejects(client.submit("must not overlap"), /仍在运行/);
  active = null; revision = "2";
  await client.refresh(); assert.ok(notices.some((s) => s.includes("fixture model failure")));
  assert.equal(submissions, 1);
  const unavailable = new WorkflowTerminal(api, view, "missing");
  await assert.rejects(unavailable.initialize(), /不可用/);
  unavailable.stop();
});
