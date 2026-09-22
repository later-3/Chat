import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openProject } from "../src/projects/registry.ts";
import { openChatSession } from "../src/chat-session.ts";
import { writeLongAgentRegistry } from "../src/long-agents/storage.ts";
import {
  archiveConversation,
  bindParticipationSession,
  createConversation,
  readConversation,
} from "../src/long-agents/conversations/service.ts";
import { publishConversationSpeech } from "../src/long-agents/conversations/publication.ts";

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

/** Small SSE client: parses `event:`/`id:`/`data:` frames and keeps the body reader open. */
function openSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  const waiters = [];
  let buffer = "";
  let ended = false;
  const settle = () => {
    while (waiters.length > 0 && (frames.length > 0 || ended)) {
      const waiter = waiters.shift();
      waiter(frames.length > 0 ? { frame: frames.shift() } : { done: true });
    }
  };
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let separator;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const name = raw.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
          const data = raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (name === undefined || data === undefined) continue;
          frames.push({ event: name, data: JSON.parse(data) });
        }
        settle();
      }
    } catch {
      // Connection reset after revocation is part of the contract.
    } finally {
      ended = true;
      settle();
    }
  })();
  return {
    next: (timeoutMs = 8_000) => new Promise((resolve, reject) => {
      if (frames.length > 0) return resolve({ frame: frames.shift() });
      if (ended) return resolve({ done: true });
      const timer = setTimeout(() => reject(new Error("SSE frame timed out")), timeoutMs);
      waiters.push((value) => { clearTimeout(timer); resolve(value); });
    }),
    end: async () => { await reader.cancel().catch(() => undefined); },
  };
}

async function appendMessage(home, projectId, sessionId, message) {
  const session = await openChatSession({ chatHome: home, projectId, sessionId });
  session.manager.appendMessage(message);
  session.manager.flush();
  return session.manager.getEntries().at(-1).id;
}

test("conversation stream over real HTTP: incremental delivery, revocation close, cursor reconnect", { timeout: 120_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la5-stream-")));
  const home = path.join(root, "home");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-la5-http-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_HTTP\n");
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

  const conversation = await createConversation({
    chatHome: home, storageProjectId: "a", title: "HTTP 群", requestId: "req-http-stream",
    memberLongAgentIds: ["friend", "friend2"],
  });
  const author = await bindParticipationSession({ chatHome: home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const viewer = await bindParticipationSession({ chatHome: home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend2" });

  const entryOne = await appendMessage(home, "a", author.sessionId, { role: "assistant", content: "HTTP_BLOCK_ONE" });
  const current = await readConversation(home, "a", conversation.id);
  await publishConversationSpeech({
    chatHome: home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", attemptId: "http-1",
    participationEpoch: author.participationEpoch, authorizationRevision: current.authorizationRevision,
    sourceSessionId: author.sessionId, sourceEntryId: entryOne, text: "HTTP_BLOCK_ONE",
  });
  const publicRoot = await openChatSession({ chatHome: home, projectId: "a", sessionId: conversation.publicSessionId });
  publicRoot.manager.appendMessage({ role: "user", content: "USER_MESSAGE_ONE" });
  publicRoot.manager.flush();

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
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ready = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && server.exitCode === null) {
      try {
        if ((await fetch(`${baseUrl}/api/health`)).ok) return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  assert.equal(await ready(), true, output);

  const streamUrl = (after) =>
    `${baseUrl}/api/long-agents/friend/conversations/${conversation.id}/stream?after=${String(after)}`;

  // 1) Connect: the first tick returns the authorized full snapshot so the client has a stable cursor.
  const controller = new AbortController();
  const response = await fetch(streamUrl(-1), { signal: controller.signal });
  assert.equal(response.status, 200, output);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const sse = openSse(response);
  const initial = await sse.next();
  assert.equal(initial.frame.event, "reset");
  assert.equal(initial.frame.data.messages.some((message) => message.text === "HTTP_BLOCK_ONE"), true);
  assert.equal(initial.frame.data.messages.some((message) => message.text === "USER_MESSAGE_ONE"), true);
  let cursor = initial.frame.data.cursor;

  // 2) A user message appended after the connection opened is delivered incrementally.
  await appendMessage(home, "a", conversation.publicSessionId, { role: "user", content: "USER_MESSAGE_TWO" });
  const userFrame = await sse.next();
  assert.equal(userFrame.frame.event, "message");
  assert.equal(userFrame.frame.data.message.text, "USER_MESSAGE_TWO");
  assert.ok(userFrame.frame.data.cursor > cursor);
  cursor = userFrame.frame.data.cursor;

  // 3) A publication created while connected also arrives over the same cursor.
  const entryTwo = await appendMessage(home, "a", author.sessionId, { role: "assistant", content: "HTTP_BLOCK_TWO" });
  const latest = await readConversation(home, "a", conversation.id);
  await publishConversationSpeech({
    chatHome: home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", attemptId: "http-2",
    participationEpoch: author.participationEpoch, authorizationRevision: latest.authorizationRevision,
    sourceSessionId: author.sessionId, sourceEntryId: entryTwo, text: "HTTP_BLOCK_TWO",
  });
  const publishedFrame = await sse.next();
  assert.equal(publishedFrame.frame.event, "message");
  assert.equal(publishedFrame.frame.data.message.text, "HTTP_BLOCK_TWO");
  assert.equal(publishedFrame.frame.data.message.publicationId !== null, true);
  cursor = publishedFrame.frame.data.cursor;

  // 4) There is no request-supplied identity: an attempt to name a member (or any other reader) is
  // refused outright, so a group Agent cannot omit or supply an id to reach the owner projection.
  const spoof = await fetch(`${streamUrl(cursor)}&viewerLongAgentId=friend2`);
  assert.equal(spoof.status, 400, await spoof.text());
  const spoofOther = await fetch(`${baseUrl}/api/long-agents/friend2/conversations/${conversation.id}/stream?after=0&viewerLongAgentId=friend`);
  assert.equal(spoofOther.status, 400, await spoofOther.text());

  // 5) Reconnect with the last cursor: only the missing message is backfilled, nothing is duplicated.
  await appendMessage(home, "a", conversation.publicSessionId, { role: "user", content: "USER_MESSAGE_THREE" });
  const reconnectController = new AbortController();
  const reconnect = await fetch(streamUrl(cursor), { signal: reconnectController.signal });
  assert.equal(reconnect.status, 200, output);
  const reSse = openSse(reconnect);
  const backfill = await reSse.next();
  assert.equal(backfill.frame.event, "message");
  assert.equal(backfill.frame.data.message.text, "USER_MESSAGE_THREE");
  const nothingNew = await reSse.next(1_000).catch(() => ({ done: true }));
  assert.equal(nothingNew.done, true, "a reconnect from the last cursor does not repeat delivered messages");
  // The still-open first connection receives the same new message through its own cursor.
  const mirrored = await sse.next();
  assert.equal(mirrored.frame.event, "message");
  assert.equal(mirrored.frame.data.message.text, "USER_MESSAGE_THREE");

  // 6) Archiving the group closes every open owner connection with `revoked` and no further data.
  await archiveConversation({ chatHome: home, storageProjectId: "a", conversationId: conversation.id, expectedRevision: (await readConversation(home, "a", conversation.id)).revision });
  const revoked = await sse.next();
  assert.equal(revoked.frame.event, "revoked");
  assert.equal((await sse.next()).done, true, "the stream is closed after authorization is withdrawn");
  const revokedAgain = await reSse.next(2_000).catch(() => ({ done: true }));
  assert.equal(revokedAgain.done, true, "the second open connection is closed too");
  controller.abort();
  reconnectController.abort();

  // 7) An unauthorized reconnect is refused before any data is served.
  const refused = await fetch(streamUrl(cursor));
  assert.equal(refused.status, 403, await refused.text());

  await reSse.end();
  await sse.end();
});
