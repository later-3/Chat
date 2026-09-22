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
import { launchBrowser, chromeExecutable } from "./cdp.mjs";

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

async function stopProcess(process, signal = "SIGINT") {
  if (process === undefined || process.exitCode !== null) return;
  process.kill(signal);
  await new Promise((resolve) => process.once("exit", resolve));
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

test("group state survives a real process kill: running is interrupted, queued resumes", { timeout: 240_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la5-restart-")));
  const home = path.join(root, "home");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-la5-restart-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_RESTART\n");
  await openProject({ path: workspace, chatHome: home, id: "a", name: "a" });
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [{
      id: "friend", name: "friend", description: "Stable", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local",
      nanoclawAgentGroupId: "group-friend", defaultProjectId: "friend",
      definition: {
        schemaVersion: 1, id: "friend", name: "friend", description: "Stable",
        systemPrompt: { mode: "replace", text: "Stable Friend" }, customInstructions: [],
        tools: { mode: "explicit", names: [], exclude: [], addresses: [] },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] },
      },
    }],
  }, home);

  // The first model call is held open so a `running` attempt is really in flight when the process dies.
  let calls = 0;
  const held = [];
  const modelServer = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    for await (const _chunk of request) { /* drain */ }
    const index = calls++;
    if (index === 0) { held.push(response); return; }
    const text = `RECOVERED_RESULT_${String(index)}`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish, usage) => JSON.stringify({ id: `chatcmpl-restart-${String(index)}`, object: "chat.completion.chunk", created: 0, model: "restart-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
    response.write(`data: ${frame({ role: "assistant", content: text }, null)}\n\n`);
    response.write(`data: ${frame({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
  const modelAddress = modelServer.address();
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "restart-local", defaultModel: "restart-model", defaultThinkingLevel: "off", retry: { enabled: false } }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "restart-local": {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: "openai-completions", apiKey: "restart-key",
    models: [{ id: "restart-model", name: "Restart Model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const startServer = () => {
    const child = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: projectRoot,
      env: {
        ...process.env, CHAT_HOME: home, CHAT_NITRO_BUILD_DIR: buildDir,
        WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(home, "runtime", "workflow-data"),
        WORKFLOW_LOCAL_BASE_URL: baseUrl, MEM0_TELEMETRY: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    return child;
  };
  const waitReady = async () => {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return true; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  t.after(async () => {
    await browser?.close().catch(() => undefined);
    if (server !== undefined) await stopProcess(server, "SIGKILL").catch(() => undefined);
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  let browser;
  let server = startServer();
  assert.equal(await waitReady(), true, output);
  const api = (suffix, init) => jsonFetch(`${baseUrl}/api/long-agents/friend/conversations${suffix}`, init);
  // The central group view defaults to the first user Project, so create the group there to make the
  // real UI assertion below deterministic.
  const projectsPayload = await (await fetch(`${baseUrl}/api/projects`)).json();
  const targetProjectId = projectsPayload.projects
    .filter((project) => (project.kind ?? "project") === "project")
    .sort((left, right) => String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt)))[0].projectId;
  const created = await api("", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageProjectId: targetProjectId, title: "重启群", requestId: "req-restart", memberLongAgentIds: ["friend"] }) });
  assert.equal(created.status, 201, JSON.stringify(created.body) + output);
  const conversationId = created.body.id;

  // A mention round starts and blocks in the held model call, so the attempt becomes `running`.
  const started = await api(`/${conversationId}/discussions`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: "mention", targets: ["friend"] }) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const waitForRunning = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const detail = await api(`/${conversationId}`);
      const attempt = detail.body.discussions?.flatMap((discussion) => discussion.attempts ?? []).find((entry) => entry.status === "running");
      if (attempt !== undefined) return attempt;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`attempt never reached running\n${output}`);
  };
  await waitForRunning();

  // Queue an independent background task while the round is stuck; it must survive and resume.
  const work = await api(`/${conversationId}/works`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", requestId: "restart-work", title: "重启后任务", instruction: "继续研究", longAgentId: "friend" }) });
  assert.equal(work.status, 201, JSON.stringify(work.body) + output);

  // Real crash: SIGKILL the Backend while the model call is in flight.
  await stopProcess(server, "SIGKILL");
  server = undefined;

  // Restart with the same Chat Home. Startup recovery marks `running` interrupted and resumes the queue.
  server = startServer();
  assert.equal(await waitReady(), true, output);
  const waitForRecovery = async () => {
    const deadline = Date.now() + 60_000;
    let last = null;
    while (Date.now() < deadline) {
      const detail = await api(`/${conversationId}`);
      const works = await api(`/${conversationId}/works`);
      last = { detail: detail.body, works: works.body };
      const entry = detail.body.discussions?.flatMap((discussion) => discussion.attempts ?? []).find((attempt) => attempt.speakerLongAgentId === "friend");
      const resumed = works.body.works?.find((item) => item.title === "重启后任务");
      if (entry?.status === "interrupted" && resumed?.status === "completed") return last;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail(`recovery did not converge: ${JSON.stringify(last)}\n${output}`);
  };
  const recovered = await waitForRecovery();
  const attempt = recovered.detail.discussions.flatMap((discussion) => discussion.attempts).find((entry) => entry.speakerLongAgentId === "friend");
  assert.equal(attempt.status, "interrupted");
  assert.equal(attempt.publicationId, null, "an interrupted attempt is never replayed or published");
  const discussion = recovered.detail.discussions.find((item) => item.attempts.some((entry) => entry.attemptId === attempt.attemptId));
  assert.equal(discussion.status, "interrupted");
  const resumedWork = recovered.works.works.find((item) => item.title === "重启后任务");
  assert.equal(resumedWork.status, "completed");
  assert.equal(typeof resumedWork.publicationId, "string");
  const messages = await api(`/${conversationId}/messages`);
  assert.equal(messages.body.messages.some((message) => message.text === "RECOVERED_RESULT_1"), true, JSON.stringify(messages.body));
  assert.equal(calls, 2, "the interrupted call is not replayed; only the resumed task called the model");
  // The real UI must show the same terminal states: the discussion is interrupted and the resumed
  // background task is completed, without a replay of the killed attempt.
  if (chromeExecutable() !== null) {
    browser = await launchBrowser();
    const page = await browser.newPage(`${baseUrl}/?view=groups`);
    await page.waitFor("document.readyState === 'complete'", { label: "页面加载", timeoutMs: 30_000 });
    await page.waitFor("document.getElementById('workspace-groups-tab') !== null", { label: "群聊入口", timeoutMs: 40_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await page.evaluate("document.getElementById('workspace-groups-tab')?.click()");
    await page.waitFor("document.querySelector('[data-group-chat-root]') !== null", { label: "中央群聊", timeoutMs: 20_000 });
    await page.waitFor("document.body.innerText.includes('重启群')", { label: "群列表含重启群", timeoutMs: 30_000 });
    await page.evaluate("[...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('重启群'))?.click()");
    await page.waitFor("(document.querySelector('[data-group-discussion-status]')?.textContent||'').includes('interrupted')", { label: "讨论 interrupted 终态", timeoutMs: 40_000 });
    await page.waitFor("(document.querySelector('[data-group-work-status]')?.textContent||'').includes('completed')", { label: "任务 completed 终态", timeoutMs: 40_000 });
    await page.waitFor("document.body.innerText.includes('重启后任务')", { label: "任务标题", timeoutMs: 20_000 });
    await page.close();
  }
  // The held response from the crashed process is dead; release it so the server can close cleanly.
  for (const response of held) response.destroy();
});
