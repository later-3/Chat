import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ensureAgentHomeProject, openProject } from "../src/projects/registry.ts";
import { writeLongAgentRegistry } from "../src/long-agents/storage.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close((error) => error ? reject(error) : resolve(address.port)); });
  });
}
async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGINT");
  await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

const plannerOutput = (title, sourceSessionId, entryId) => [
  '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->',
  `<!-- chat-topic-draft {"title":"${title}","purpose":"定位并沉淀","integrationSummary":"整合摘要","frozenProjectContext":null,"initialMemory":[{"storageProjectId":"friend","sessionId":"${sourceSessionId}","entryId":"${entryId}","content":"来源记忆"}]} -->`,
].join("\n");

test("topic creation over the REAL Workflow runtime: collect -> revise -> approve -> exactly one node", { timeout: 300_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-topic-create-")));
  const home = path.join(root, "home");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-topic-create-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE\n");
  await openProject({ path: workspace, chatHome: home, id: "collab", name: "collab" });
  await ensureAgentHomeProject("friend", "Friend", home);
  const snapshotDir = path.join(home, "runtime/long-agents/friend");
  fs.mkdirSync(snapshotDir, { recursive: true });
  const hash = `sha256:${"a".repeat(64)}`;
  fs.writeFileSync(path.join(snapshotDir, "agent-group-snapshot.json"), JSON.stringify({ schemaVersion: 1, longAgentId: "friend", agentGroupId: "group-friend", fetchedAt: new Date().toISOString(), snapshot: {
    id: "group-friend", name: "Friend", standingInstructions: "Stable", revision: hash, workspace: { folder: "friend", memoryFileCount: 1 },
    coreMemory: { index: { path: "index.md", content: "i", size: 1, updatedAt: new Date().toISOString(), revision: hash },
      definition: { path: "system/definition.md", content: "d", size: 1, updatedAt: new Date().toISOString(), revision: hash } } } }));
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [{ id: "friend", name: "friend", description: "Stable", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local",
      nanoclawAgentGroupId: "group-friend", defaultProjectId: "friend",
      definition: { schemaVersion: 1, id: "friend", name: "friend", description: "Stable", systemPrompt: { mode: "replace", text: "Stable Friend" },
        customInstructions: [], tools: { mode: "explicit", names: [], exclude: [], addresses: ["system:tool/topic_manage"] },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } } }],
  }, home);

  const collectorTitles = ["主题A", "主题A-修订"];
  let collectorCalls = 0;
  const modelServer = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const textOf = (message) => typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n") : "";
    const systemText = messages.filter((message) => message.role === "system").map(textOf).join("\n");
    if (process.env.TC_DEBUG === "1" && collectorCalls < 1 && !systemText.includes("Stable Friend")) console.log("TC_DEBUG roles=", JSON.stringify(messages.map((m) => m.role)), "system=", JSON.stringify(systemText.slice(0, 200)));
    const toolResultText = messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content ?? "")).join("\n");
    const frame = (delta, finish, usage) => JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
    const text = (content) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${frame({ role: "assistant", content }, null)}\n\n`);
      response.write(`data: ${frame({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })}\n\n`);
      response.end("data: [DONE]\n\n");
    };
    const toolCall = (name, args) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${frame({ role: "assistant", tool_calls: [{ index: 0, id: `call-${String(Math.random()).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null)}\n\n`);
      response.write(`data: ${frame({}, "tool_calls", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })}\n\n`);
      response.end("data: [DONE]\n\n");
    };
    // The creator must call the controlled commit; after the tool result it just reports.
    // Role phrases are matched inside the quoted identity so the collector (which also mentions the
    // creator in prose) is never mistaken for the creator.
    if (systemText.includes("「整理 Agent」")) {
      // The collector MUST first read the trusted source; only then does it emit the draft.
      const sourceMatch = /来源会话（只读）：([0-9A-Za-z._:-]+)/.exec(messages.map(textOf).join("\n"));
      const readTool = messages.some((message) => message.role === "tool");
      if (!readTool) {
        toolCall("topic_manage", { operation: "read_memory", sourceSessionId: sourceMatch === null ? "missing" : sourceMatch[1] });
        return;
      }
      // Use the REAL entry id returned by read_memory, so the draft's provenance must be valid.
      const toolText = messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content ?? "")).join("\n");
      const entryId = /smem-[0-9a-f-]+/.exec(toolText)?.[0] ?? "missing";
      const title = collectorTitles[Math.min(collectorCalls++, collectorTitles.length - 1)];
      text(plannerOutput(title, sourceMatch === null ? "missing" : sourceMatch[1], entryId));
      return;
    }
    if (systemText.includes("「创建 Agent」")) {
      const lastMessage = messages.at(-1);
      if (lastMessage?.role === "tool") { text(`创建结果：${JSON.stringify(lastMessage.content ?? "").slice(0, 500)}`); return; }
      toolCall("topic_manage", { operation: "commit_creation" });
      return;
    }
    text("ack");
  });
  await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const modelAddress = modelServer.address();
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake-local", defaultModel: "fake-model", defaultThinkingLevel: "off", retry: { enabled: false } }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-local": {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: "openai-completions", apiKey: "k",
    models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));

  // A daily session is the trusted creation source.
  const { executeLongAgentTurn } = await import("../src/long-agents/runtime.ts");
  const { readLongAgentState } = await import("../src/long-agents/storage.ts");
  const { writeSessionMemoryEntry } = await import("../src/long-agents/session-memory.ts");
  await executeLongAgentTurn({ chatHome: home, projectId: "friend", longAgentId: "friend", turnId: "seed-1", contextProjectId: null, text: "记录现场：空指针" });
  const dailySession = (await readLongAgentState(home)).dailySessions.find((day) => day.longAgentId === "friend");
  // A real source memory entry: the collector must read THIS and use its address as provenance.
  await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: dailySession.sessionId,
    operation: "write", purpose: "finding", author: "user", content: "空指针来源事实", expectedRevision: 0 });

  let output = "";
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, CHAT_HOME: home, CHAT_NITRO_BUILD_DIR: buildDir, WORKFLOW_TARGET_WORLD: "local",
      WORKFLOW_LOCAL_DATA_DIR: path.join(home, "runtime", "workflow-data"), WORKFLOW_LOCAL_BASE_URL: baseUrl, MEM0_TELEMETRY: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    await stopProcess(server);
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) { ready = true; break; } } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(ready, true, output.slice(-2000));

  const startResponse = await fetch(`${baseUrl}/api/long-agents/friend/topics/integrations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "create-e2e-1", title: "主题A", purpose: "把这个建成主题" }),
  });
  const startBody = await startResponse.text();
  assert.equal(startResponse.status, 202, startBody);
  const started = JSON.parse(startBody);
  const runQuery = `projectId=friend&workflowInvocationId=${encodeURIComponent(started.workflowInvocationId)}`;
  const runStatus = async () => (await (await fetch(`${baseUrl}/runs/${encodeURIComponent(started.runId)}?${runQuery}`)).json());
  const waitForReview = async (revision) => {
    const limit = Date.now() + 120_000;
    while (Date.now() < limit) {
      const status = await runStatus();
      const review = status.review;
      if (review !== undefined && review.planRevision === revision) return { status, review };
      if (["failed", "cancelled"].includes(status.status)) assert.fail(`run ${status.status}: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.fail(`review revision ${revision} never appeared`);
  };

  // T1: the review must appear before ANY target node exists.
  const first = await waitForReview(1);
  const requests = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/creations?sourceSessionId=${dailySession.sessionId}`)).json();
  assert.equal(requests.creations.length, 1);
  assert.equal(requests.creations[0].runId, started.runId);
  assert.equal(requests.creations[0].review.planRevision, 1, "review is recoverable from durable Run bindings");
  const compatibilityStatus = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/integrations/${started.requestId}`)).json();
  assert.equal(compatibilityStatus.kind, "workflow");
  assert.equal(compatibilityStatus.runId, started.runId);
  assert.equal(compatibilityStatus.review.reviewId, requests.creations[0].review.reviewId);
  const replayResponse = await fetch(`${baseUrl}/api/long-agents/friend/topics/integrations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, requestId: "create-e2e-1", title: "主题A", purpose: "把这个建成主题" }),
  });
  assert.equal(replayResponse.status, 202);
  assert.equal((await replayResponse.json()).runId, started.runId, "legacy retries reuse the review Run");
  assert.equal((await readLongAgentState(home)).works.length, 0, "new legacy POST never starts an unreviewed background work");
  const beforeApproval = await (await fetch(`${baseUrl}/api/long-agents/friend/topics`)).json();
  assert.equal(beforeApproval.topics.length, 0, "no target topic before approval");

  const decide = (decision) => fetch(`${baseUrl}/runs/${encodeURIComponent(started.runId)}/review`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "friend", decision }),
  });
  const reference = (review) => ({ reviewId: review.reviewId, workflowInvocationId: review.workflowInvocationId, planRevision: review.planRevision, planSha256: review.planSha256 });

  // T2: one revision, then approve the NEW revision; an old-revision approval must be rejected.
  const revise = await decide({ kind: "request_revision", feedback: "请把范围收窄到空指针窗口。", ...reference(first.review) });
  assert.ok([200, 202].includes(revise.status), await revise.text());
  const second = await waitForReview(2);
  const stale = await decide({ kind: "approve", ...reference(first.review) });
  assert.notEqual(stale.status, 200, "an approval of the superseded revision must be rejected");
  const approve = await decide({ kind: "approve", ...reference(second.review) });
  assert.ok([200, 202].includes(approve.status), await approve.text());

  const limit = Date.now() + 120_000;
  let final;
  while (Date.now() < limit) {
    final = await runStatus();
    if (["completed", "failed", "cancelled"].includes(final.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(final.status, "completed", `FINAL=${JSON.stringify(final).slice(0, 900)}`);
  const graph = await (await fetch(`${baseUrl}/api/long-agents/friend/topics`)).json();
  assert.equal(graph.topics.length, 1, JSON.stringify(graph));
  assert.equal(graph.topics[0].nodes.length, 1, "exactly one node for the approved request");
  assert.equal(graph.topics[0].nodes[0].title, "主题A-修订", "the created node matches the APPROVED revision");

  // A retry of the same approval must not create a second node.
  const retry = await decide({ kind: "approve", ...reference(second.review) });
  assert.ok([200, 202].includes(retry.status));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await (await fetch(`${baseUrl}/api/long-agents/friend/topics`)).json();
  assert.equal(after.topics[0].nodes.length, 1, "no duplicate node on approval retry");
});
