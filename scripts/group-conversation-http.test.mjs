import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openProject } from "../src/projects/registry.ts";
import { writeLongAgentRegistry } from "../src/long-agents/storage.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

/** Minimal OpenAI-completions SSE model so a group turn really runs through Pi. */
function startModelServer(replies) {
  let call = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    for await (const _chunk of request) { /* drain */ }
    const text = replies[Math.min(call, replies.length - 1)];
    call += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish, usage) => JSON.stringify({
      id: `chatcmpl-group-${String(call)}`, object: "chat.completion.chunk", created: 0, model: "group-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    });
    response.write(`data: ${frame({ role: "assistant", content: text }, null)}\n\n`);
    response.write(`data: ${frame({}, "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  return server;
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

test("group conversation over real HTTP: management, durable round, public projection", { timeout: 180_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la5-group-")));
  const home = path.join(root, "home");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-la5-group-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_GROUP\n");
  await openProject({ path: workspace, chatHome: home, id: "a", name: "a" });
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: ["friend", "friend2"].map((id) => ({
      id, name: id, description: "Stable", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local",
      nanoclawAgentGroupId: `group-${id}`, defaultProjectId: id,
      definition: {
        schemaVersion: 1, id, name: id, description: "Stable",
        systemPrompt: { mode: "replace", text: "Stable Friend" }, customInstructions: [],
        tools: { mode: "explicit", names: [], exclude: [], addresses: [] },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] },
      },
    })),
  }, home);

  const modelServer = startModelServer(["GROUP_FRIEND_REPLY", "B_ANSWER", "A_FINAL"]);
  await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
  const modelAddress = modelServer.address();
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "group-local", defaultModel: "group-model", defaultThinkingLevel: "off" }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "group-local": {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: "openai-completions", apiKey: "group-key",
    models: [{ id: "group-model", name: "Group Model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));

  let output = "";
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CHAT_HOME: home,
      CHAT_NITRO_BUILD_DIR: buildDir,
      WORKFLOW_TARGET_WORLD: "local",
      WORKFLOW_LOCAL_DATA_DIR: path.join(home, "runtime", "workflow-data"),
      WORKFLOW_LOCAL_BASE_URL: baseUrl,
      MEM0_TELEMETRY: "false",
    },
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
  const ready = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && server.exitCode === null) {
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return true; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  assert.equal(await ready(), true, output);
  const api = (suffix, init) => jsonFetch(`${baseUrl}/api/long-agents/friend/conversations${suffix}`, init);

  // S1: create a group with the owner API, then send the user message idempotently.
  const created = await api("", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageProjectId: "a", title: "HTTP 研究小组", requestId: "req-group-http", memberLongAgentIds: ["friend", "friend2"] }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body) + output);
  const conversationId = created.body.id;
  const firstMessage = await api(`/${conversationId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientMessageId: "m-1", text: "请 @friend 介绍一下结论" }),
  });
  assert.equal(firstMessage.status, 201, JSON.stringify(firstMessage.body));
  const duplicate = await api(`/${conversationId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientMessageId: "m-1", text: "请 @friend 介绍一下结论" }),
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.created, false, "a retried user message is not appended twice");

  // Address a member explicitly; an unknown field is refused (no identity can be smuggled in).
  const spoof = await api(`/${conversationId}/discussions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: "mention", targets: ["friend"], viewerLongAgentId: "friend2" }),
  });
  assert.equal(spoof.status, 400, JSON.stringify(spoof.body));
  const started = await api(`/${conversationId}/discussions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: "mention", targets: ["friend"] }),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body) + output);
  assert.equal(typeof started.body.runId, "string");

  // The durable round runs through Pi and commits a publication to the public root.
  const waitForRound = async () => {
    const deadline = Date.now() + 60_000;
    let last = null;
    while (Date.now() < deadline) {
      const detail = await api(`/${conversationId}`);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      last = detail.body;
      const discussion = detail.body.discussions?.find((item) => item.discussionId === started.body.discussionId);
      if (discussion !== undefined && ["completed", "failed", "stopped", "interrupted"].includes(discussion.status)) return detail.body;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail(`group round did not finish; last=${JSON.stringify(last)}\n${output}`);
  };
  const detail = await waitForRound();
  const discussion = detail.discussions.find((item) => item.discussionId === started.body.discussionId);
  assert.equal(discussion.status, "completed", JSON.stringify(discussion));
  assert.equal(discussion.attempts[0].status, "published");
  assert.equal(discussion.modelCalls >= 1, true, "the round counted its real model call");

  const messages = await api(`/${conversationId}/messages`);
  assert.equal(messages.status, 200);
  assert.equal(messages.body.messages.some((message) => message.text === "GROUP_FRIEND_REPLY"), true, JSON.stringify(messages.body));
  assert.equal(messages.body.messages.some((message) => message.text === "请 @friend 介绍一下结论"), true);

  // S7: A asks B; B runs independently, then A returns the conclusion to the group.
  const consult = await api(`/${conversationId}/consult`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromLongAgentId: "friend", toLongAgentId: "friend2", question: "请给出结论" }),
  });
  assert.equal(consult.status, 202, JSON.stringify(consult.body) + output);
  const waitForConsult = async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const body = (await api(`/${conversationId}`)).body;
      const item = body.discussions?.find((entry) => entry.discussionId === consult.body.discussionId);
      if (item !== undefined && ["completed", "failed", "stopped", "interrupted"].includes(item.status)) return item;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail(`consultation did not finish\n${output}`);
  };
  const consultDiscussion = await waitForConsult();
  assert.equal(consultDiscussion.status, "completed", JSON.stringify(consultDiscussion));
  assert.deepEqual(consultDiscussion.attempts.map((attempt) => attempt.speakerLongAgentId), ["friend2", "friend"]);
  assert.equal(consultDiscussion.attempts[1].causationId, consultDiscussion.attempts[0].attemptId);
  const afterConsult = await api(`/${conversationId}/messages`);
  assert.equal(afterConsult.body.messages.some((message) => message.text === "B_ANSWER"), true);
  assert.equal(afterConsult.body.messages.some((message) => message.text === "A_FINAL"), true);

  // S8: a group background task runs independently and publishes an authorized result reference.
  const workStart = await api(`/${conversationId}/works`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", requestId: "work-http-1", title: "后台研究", instruction: "研究并给出结论", longAgentId: "friend", originEntryId: firstMessage.body.message.entryId }),
  });
  assert.equal(workStart.status, 201, JSON.stringify(workStart.body) + output);
  const waitForWork = async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const body = (await api(`/${conversationId}/works`)).body;
      const work = body.works?.find((entry) => entry.workId === workStart.body.work.workId);
      if (work !== undefined && ["completed", "failed", "cancelled"].includes(work.status)) return work;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail(`group work did not finish\n${output}`);
  };
  const work = await waitForWork();
  assert.equal(work.status, "completed", JSON.stringify(work));
  assert.equal(typeof work.publicationId, "string");

  // A live owner stream sees the same authorized public order from a stable cursor.
  const stream = await fetch(`${baseUrl}/api/long-agents/friend/conversations/${conversationId}/stream?after=-1`);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstFrame = null;
  while (firstFrame === null) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const separator = buffer.indexOf("\n\n");
    if (separator >= 0) {
      const raw = buffer.slice(0, separator);
      const data = raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data !== undefined) firstFrame = JSON.parse(data);
    }
  }
  assert.equal(firstFrame.type, "reset");
  assert.equal(firstFrame.messages.some((message) => message.text === "GROUP_FRIEND_REPLY"), true);
  await reader.cancel().catch(() => undefined);

  // S9: CAS configuration, member revocation and archive.
  const conflicted = await api(`/${conversationId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 999, title: "改名" }),
  });
  assert.equal(conflicted.status, 409);
  const beforePatch = await api(`/${conversationId}`);
  const renamed = await api(`/${conversationId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: beforePatch.body.revision, title: "HTTP 研究小组（已改名）" }),
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const revoked = await api(`/${conversationId}/members`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "revoke", expectedRevision: renamed.body.revision, longAgentId: "friend2" }),
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.members.find((member) => member.longAgentId === "friend2").active, false);
  const archived = await api(`/${conversationId}/archive`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: revoked.body.revision }),
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.lifecycle, "archived");
  const refusedRound = await api(`/${conversationId}/discussions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: "mention", targets: ["friend"] }),
  });
  assert.equal(refusedRound.status, 409, JSON.stringify(refusedRound.body));
  const refusedStream = await fetch(`${baseUrl}/api/long-agents/friend/conversations/${conversationId}/stream?after=-1`);
  assert.equal(refusedStream.status, 403, await refusedStream.text());
});
