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

async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGINT");
  await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

test("LA6 A: each Friend keeps its own collaboration project in the real browser", {
  timeout: 240_000,
  skip: chromeExecutable() === null ? "环境没有可用的 Chrome/Chromium" : false,
}, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la6-a-browser-")));
  const home = path.join(root, "home");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-la6-a-browser-"));
  const projectP = path.join(root, "project-p");
  const projectQ = path.join(root, "project-q");
  fs.mkdirSync(projectP, { recursive: true });
  fs.writeFileSync(path.join(projectP, "AGENTS.md"), "RULE_PROJ_P\n");
  fs.writeFileSync(path.join(projectP, "P_ONLY.md"), "P only\n");
  fs.mkdirSync(projectQ, { recursive: true });
  fs.writeFileSync(path.join(projectQ, "AGENTS.md"), "RULE_PROJ_Q\n");
  fs.writeFileSync(path.join(projectQ, "Q_ONLY.md"), "Q only\n");
  await openProject({ path: projectP, chatHome: home, id: "proj-p", name: "Project P" });
  await openProject({ path: projectQ, chatHome: home, id: "proj-q", name: "Project Q" });
  const first = {
    id: "friend", name: "friend", description: "Stable", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local",
    nanoclawAgentGroupId: "group-friend", defaultProjectId: "friend",
    definition: {
      schemaVersion: 1, id: "friend", name: "friend", description: "Stable",
      systemPrompt: { mode: "replace", text: "Stable Friend" }, customInstructions: [],
      tools: { mode: "explicit", names: [], exclude: [], addresses: [] },
      resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] },
    },
  };
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [first, {
      ...first, id: "friend2", name: "friend2", nanoclawAgentGroupId: "group-friend2", defaultProjectId: "friend2",
      definition: { ...first.definition, id: "friend2", name: "friend2" },
    }],
  }, home);

  // A frozen Agent Group snapshot keeps the turn offline from NanoClaw (same shape as the test fixture).
  const hash = `sha256:${"a".repeat(64)}`;
  for (const id of ["friend", "friend2"]) {
    const snapshotDir = path.join(home, "runtime", "long-agents", id);
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, "agent-group-snapshot.json"), JSON.stringify({
      schemaVersion: 1, longAgentId: id, agentGroupId: `group-${id}`, fetchedAt: "2026-09-21T00:00:00Z",
      snapshot: {
        id: `group-${id}`, name: id, standingInstructions: "Stable identity", revision: hash,
        workspace: { folder: id, memoryFileCount: 0 },
        coreMemory: {
          index: { path: "index.md", content: "index", size: 5, updatedAt: "2026-09-21T00:00:00Z", revision: hash },
          definition: { path: "system/definition.md", content: "definition", size: 10, updatedAt: "2026-09-21T00:00:00Z", revision: hash },
        },
      },
    }));
  }

  const modelRequests = [];
  const modelServer = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish, usage) => JSON.stringify({ id: "chatcmpl-la6a", object: "chat.completion.chunk", created: 0, model: "la6a-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
    response.write(`data: ${frame({ role: "assistant", content: "ACK" }, null)}\n\n`);
    response.write(`data: ${frame({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
  const modelAddress = modelServer.address();
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "la6a-local", defaultModel: "la6a-model", defaultThinkingLevel: "off", retry: { enabled: false } }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "la6a-local": {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: "openai-completions", apiKey: "la6a-key",
    models: [{ id: "la6a-model", name: "LA6A Model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));

  let output = "";
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env, CHAT_HOME: home, CHAT_NITRO_BUILD_DIR: buildDir,
      WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(home, "runtime", "workflow-data"),
      WORKFLOW_LOCAL_BASE_URL: baseUrl, MEM0_TELEMETRY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  let browser;
  t.after(async () => {
    await browser?.close().catch(() => undefined);
    await stopProcess(server);
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ready = async () => {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && server.exitCode === null) {
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return true; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  assert.equal(await ready(), true, output);
  const json = async (path, init) => {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };
  const setProject = (agentId, projectId, expectedRevision) => json(`/api/long-agents/${agentId}/interaction-project`, { method: "PUT", body: JSON.stringify({ projectId, expectedRevision }) });

  const unsetTurn = await json("/api/long-agents/friend2/turns", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, requestId: "la6a-unset", text: "hello without project", interactionRevision: 0 }),
  });
  assert.equal(unsetTurn.status, 202, "an unset association must accept revision zero: " + JSON.stringify(unsetTurn.body));

  // A/P -> B/Q: each Friend has its own association.
  assert.equal((await setProject("friend", "proj-p", 0)).status, 200, output);
  assert.equal((await setProject("friend2", "proj-q", 0)).status, 200);

  // Create the Friend's private session through the real contract, then land directly on its chat.
  const turn = await json("/api/long-agents/friend/turns", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, requestId: "la6a-turn", text: "hello", interactionRevision: 1 }),
  });
  assert.equal(turn.status, 202, JSON.stringify(turn.body) + output);
  const friendSessionId = turn.body.sessionId;
  const deadline = Date.now() + 30_000;
  while (!modelRequests.some(request => JSON.stringify(request).includes("RULE_PROJ_P")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(modelRequests.length > 0, `the turn never reached the model\n${output}`);
  const friendRequest = JSON.stringify(modelRequests.find(request => JSON.stringify(request).includes("RULE_PROJ_P")));
  assert.equal(friendRequest.includes("RULE_PROJ_P"), true, "the model request used the associated project P");
  assert.equal(friendRequest.includes("RULE_PROJ_Q"), false);

  // Product private-chat entries must not bypass the association by omitting the revision.
  const bypassTurns = await json("/api/long-agents/friend/turns", { method: "POST", body: JSON.stringify({ schemaVersion: 1, requestId: "la6a-bypass", text: "hi", contextProjectId: "proj-q" }) });
  assert.equal(bypassTurns.status, 409, "turns without interactionRevision must not bypass the association");
  const bypassMessages = await json("/api/long-agents/friend/messages", { method: "POST", body: JSON.stringify({ projectId: "friend", text: "hi", contextProjectId: "proj-q" }) });
  assert.equal(bypassMessages.status, 409, "the legacy messages entry must not bypass the association either");

  // friend2's private session: needed to navigate A -> B -> A in the real UI.
  const friend2Turn = await json("/api/long-agents/friend2/turns", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, requestId: "la6a-friend2", text: "hello", interactionRevision: 1 }),
  });
  assert.equal(friend2Turn.status, 202, JSON.stringify(friend2Turn.body));
  const friend2SessionId = friend2Turn.body.sessionId;

  browser = await launchBrowser();
  const friendUrl = `${baseUrl}/?session=${encodeURIComponent(friendSessionId)}&projectId=friend`;
  const friend2Url = `${baseUrl}/?session=${encodeURIComponent(friend2SessionId)}&projectId=friend2`;
  const page = await browser.newPage(friendUrl);
  await page.waitFor("document.readyState === 'complete'", { label: "页面加载", timeoutMs: 30_000 });
  const waitFriend = async (projectId, expectedFile, unexpectedFile, titleToken) => {
    await page.waitFor(`document.querySelector('[data-friend-project-select]')?.value === ${JSON.stringify(projectId)}`, { label: `Friend 关联项目 ${projectId}`, timeoutMs: 40_000 });
    await page.waitFor(`document.title.includes(${JSON.stringify(titleToken)})`, { label: `标题同步 ${titleToken}`, timeoutMs: 20_000 });
    // The file browser must fetch the associated project directory, not the global project.
    await page.waitFor(`[...performance.getEntriesByType('resource')].some(e => e.name.includes('/api/files') && e.name.includes(${JSON.stringify(expectedFile)}))`, { label: `文件浏览器 ${expectedFile}`, timeoutMs: 30_000 });
    if (unexpectedFile !== undefined) {
      const files = String(await page.evaluate("JSON.stringify([...performance.getEntriesByType('resource')].map(e => e.name).filter(n => n.includes('/api/files')))"));
      assert.equal(files.includes(unexpectedFile), false, `the file browser must not read ${unexpectedFile}`);
    }
  };
  await waitFriend("proj-p", "project-p", "project-q", "project-p");

  // Real UI navigation A -> B: friend2 shows its own association, title and file browser.
  await page.evaluate(`location.href = ${JSON.stringify(friend2Url)}`);
  await page.waitFor("document.readyState === 'complete'", { label: "切到 Friend2", timeoutMs: 30_000 });
  await waitFriend("proj-q", "project-q", undefined, "project-q");

  // ...and back to A: it still restores P (A/P <- B/Q -> A/P).
  await page.evaluate(`location.href = ${JSON.stringify(friendUrl)}`);
  await page.waitFor("document.readyState === 'complete'", { label: "切回 Friend", timeoutMs: 30_000 });
  await waitFriend("proj-p", "project-p", undefined, "project-p");
  assert.equal((await json("/api/long-agents/friend2/interaction-project", { method: "GET" })).body.effective.projectId, "proj-q", "switching Friends did not change friend2");

  // Change the association from the UI; the global workspace selection must not move.
  await page.evaluate(`(() => {
    const select = document.querySelector('[data-friend-project-select]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'proj-q');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor("document.querySelector('[data-friend-project-select]')?.value === 'proj-q'", { label: "切换为项目 Q", timeoutMs: 20_000 });
  const stored = await json("/api/long-agents/friend/interaction-project", { method: "GET" });
  assert.equal(stored.body.effective.projectId, "proj-q");
  assert.equal(stored.body.revision, 2);

  // Refresh restores the association, and the other Friend is unaffected.
  await page.evaluate("location.reload()");
  await page.waitFor("document.readyState === 'complete'", { label: "刷新完成", timeoutMs: 20_000 });
  await page.waitFor("document.querySelector('[data-friend-project-select]')?.value === 'proj-q'", { label: "刷新后项目 Q", timeoutMs: 40_000 });
  assert.equal((await json("/api/long-agents/friend2/interaction-project", { method: "GET" })).body.effective.projectId, "proj-q");
  await setProject("friend2", "proj-p", 1);
  assert.equal((await json("/api/long-agents/friend/interaction-project", { method: "GET" })).body.effective.projectId, "proj-q", "writing friend2 never changes friend");

  // SPA interleaving: switch Friends in the same AppShell while an earlier association response is
  // still in flight; the stale response must not overwrite the current Friend.
  await page.evaluate(`location.href = ${JSON.stringify(friendUrl)}`);
  await page.waitFor("document.readyState === 'complete'", { label: "回到 Friend 准备 SPA", timeoutMs: 30_000 });
  await page.waitFor("document.querySelector('[data-friend-project-select]')?.value === 'proj-q'", { label: "SPA 起始关联 Q", timeoutMs: 40_000 });
  await page.evaluate(`(() => {
    const original = window.fetch;
    window.__la6Friend2Resolved = false;
    window.fetch = async (...args) => {
      const url = String(args[0]);
      if (url.includes('/friend2/interaction-project')) {
        const response = await original(...args);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        window.__la6Friend2Resolved = true;
        return response;
      }
      return original(...args);
    };
  })()`);
  const spaGo = (url) => page.evaluate(`(() => {
    window.history.pushState(null, "", ${JSON.stringify(url)});
    window.dispatchEvent(new PopStateEvent("popstate"));
  })()`);
  await spaGo(friend2Url); // starts a slow friend2 association load
  await new Promise((resolve) => setTimeout(resolve, 200));
  await spaGo(friendUrl); // quickly back to friend (fast response)
  await page.waitFor("document.querySelector('[data-friend-project-select]')?.value === 'proj-q'", { label: "SPA 快速切回后仍为 Q", timeoutMs: 20_000 });
  await page.waitFor("window.__la6Friend2Resolved === true", { label: "慢响应最终到达", timeoutMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(String(await page.evaluate("document.querySelector('[data-friend-project-select]')?.value")), "proj-q", "a stale friend2 response must not overwrite the current Friend");
  assert.equal(String(await page.evaluate("document.title")), "project-q - Chat", "title keeps the current Friend's association");
  assert.equal(String(await page.evaluate("document.querySelector('[data-friend-project-cwd]')?.textContent")).endsWith("project-q"), true);
  assert.equal((await json("/api/long-agents/friend/interaction-project", { method: "GET" })).body.effective.projectId, "proj-q");

  // A pending save belongs to the old Friend; it must not leave the next Friend disabled.
  await page.evaluate(`(() => {
    const original = window.fetch;
    window.__la6SavePending = false;
    window.__la6ReleaseSave = null;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes('/friend/interaction-project') && args[1]?.method === 'PUT' && !window.__la6SavePending) {
        window.__la6SavePending = true;
        await new Promise(resolve => { window.__la6ReleaseSave = resolve; });
      }
      return response;
    };
    const select = document.querySelector('[data-friend-project-select]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'proj-q');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor("window.__la6SavePending === true", { label: "旧 Friend 保存响应挂起", timeoutMs: 10_000 });
  await spaGo(friend2Url);
  await page.waitFor("document.querySelector('[data-friend-project-select]')?.value === 'proj-p'", { label: "保存途中切换 Friend", timeoutMs: 20_000 });
  assert.equal(await page.evaluate("document.querySelector('[data-friend-project-select]').disabled"), false, "an earlier Friend's pending save must not disable this Friend");
  await page.evaluate("window.__la6ReleaseSave()");
  await spaGo(friendUrl);
  await page.waitFor("document.querySelector('[data-friend-project-select]')?.value === 'proj-q'", { label: "回到保存后的 Friend", timeoutMs: 20_000 });

  // Explicit clear and a stale revision from a second page.
  await page.evaluate(`(() => {
    const select = document.querySelector('[data-friend-project-select]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, '');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor("document.querySelector('[data-friend-project-select]')?.value === ''", { label: "显式无项目", timeoutMs: 20_000 });
  const stale = await setProject("friend", "proj-p", 1);
  assert.equal(stale.status, 409, "a stale revision is an explicit conflict");
  const identityLeak = await page.evaluate("JSON.stringify([...performance.getEntriesByType('resource')].map(e => e.name).filter(n => n.includes('viewerLongAgentId')))");
  assert.equal(identityLeak, "[]");
  await page.close();
});
