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

function lastUserText(body) {
  const messages = body.messages ?? [];
  const last = [...messages].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
}

test("group chat is usable in a real browser: two groups, five policies, background task", {
  timeout: 240_000,
  skip: chromeExecutable() === null ? "环境没有可用的 Chrome/Chromium" : false,
}, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-la5-browser-")));
  const home = path.join(root, "home");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-la5-browser-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_BROWSER\n");
  await openProject({ path: workspace, chatHome: home, id: "a", name: "a" });
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

  const modelServer = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // The moderator's own instruction asks it to name the next speaker.
    const text = lastUserText(body).includes("主持") ? "<next>friend2</next>\nMOD_REPLY" : "BROWSER_REPLY";
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish, usage) => JSON.stringify({ id: "chatcmpl-browser", object: "chat.completion.chunk", created: 0, model: "browser-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
    response.write(`data: ${frame({ role: "assistant", content: text }, null)}\n\n`);
    response.write(`data: ${frame({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
  const modelAddress = modelServer.address();
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "browser-local", defaultModel: "browser-model", defaultThinkingLevel: "off", retry: { enabled: false } }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "browser-local": {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: "openai-completions", apiKey: "browser-key",
    models: [{ id: "browser-model", name: "Browser Model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096,
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
  const api = async (suffix, init) => {
    const response = await fetch(`${baseUrl}/api/long-agents/friend/conversations${suffix}`, {
      ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };
  const shell = await fetch(`${baseUrl}/`);
  assert.equal(shell.status, 200, `前端未构建或未提供：HTTP ${String(shell.status)}\n${output}`);
  browser = await launchBrowser();
  const page = await browser.newPage(`${baseUrl}/?view=groups`);
  await page.waitFor("document.readyState === 'complete'", { label: "页面加载", timeoutMs: 30_000 });
  await page.waitFor("document.getElementById('workspace-groups-tab') !== null", { label: "导航栏群聊入口", timeoutMs: 40_000 });
  // The app restores its last Session and switches to chat first; open the group view after it settles.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await page.evaluate("document.getElementById('workspace-groups-tab')?.click()");
  await page.waitFor("document.querySelector('[data-group-chat-root]') !== null", { label: "中央群聊视图", timeoutMs: 20_000 });
  await page.waitFor("document.querySelector('[data-group-project-select]')?.value", { label: "存储 Project 选择器", timeoutMs: 20_000 });
  const targetProjectId = String(await page.evaluate("document.querySelector('[data-group-project-select]')?.value"));
  assert.ok(targetProjectId !== "", output);

  // Two groups in the Project the group view actually shows: G1 has two members (moderator/parallel),
  // G2 proves switching and isolation.
  const g1 = await api("", { method: "POST", body: JSON.stringify({ storageProjectId: targetProjectId, title: "浏览器群一", requestId: "req-browser-1", memberLongAgentIds: ["friend", "friend2"], budget: { maxRounds: 1, maxModelCalls: 50 } }) });
  assert.equal(g1.status, 201, JSON.stringify(g1.body) + output);
  const g1Id = g1.body.id;
  const g2 = await api("", { method: "POST", body: JSON.stringify({ storageProjectId: targetProjectId, title: "浏览器群二", requestId: "req-browser-2", memberLongAgentIds: ["friend"], budget: { maxRounds: 1, maxModelCalls: 50 } }) });
  assert.equal(g2.status, 201, JSON.stringify(g2.body));
  const g2Id = g2.body.id;
  const patched = await api(`/${g1Id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: g1.body.revision, policy: { defaultPolicy: "moderator", moderatorLongAgentId: "friend", roundRobinOrder: ["friend", "friend2"] } }) });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  await api(`/${g1Id}/messages`, { method: "POST", body: JSON.stringify({ clientMessageId: "g1-msg", text: "GROUP_ONE_MSG" }) });
  await api(`/${g2Id}/messages`, { method: "POST", body: JSON.stringify({ clientMessageId: "g2-msg", text: "GROUP_TWO_MSG" }) });
  // A background task for the same member runs concurrently with the group chat.
  const workStart = await api(`/${g1Id}/works`, { method: "POST", body: JSON.stringify({ action: "start", requestId: "browser-work", title: "后台任务一", instruction: "后台研究", longAgentId: "friend" }) });
  assert.equal(workStart.status, 201, JSON.stringify(workStart.body) + output);
  const round = await api(`/${g1Id}/discussions`, { method: "POST", body: JSON.stringify({ policy: "mention", targets: ["friend"] }) });
  assert.equal(round.status, 202, JSON.stringify(round.body));
  await page.evaluate("document.querySelector('[data-group-refresh]')?.click()");

  const openGroup = async (title) => {
    await page.waitFor(`document.body.innerText.includes(${JSON.stringify(title)})`, { label: `群列表含 ${title}` });
    await page.evaluate(`[...document.querySelectorAll('button')].find(b => (b.textContent||'').includes(${JSON.stringify(title)}))?.click()`);
  };
  // Group one: history, live reply, background task status and sending all work.
  await openGroup("浏览器群一");
  await page.waitFor("document.body.innerText.includes('GROUP_ONE_MSG')", { label: "群一公共历史" });
  await page.waitFor("document.body.innerText.includes('BROWSER_REPLY')", { label: "群一实时回复", timeoutMs: 40_000 });
  await page.waitFor("document.body.innerText.includes('后台任务一')", { label: "群一后台任务状态", timeoutMs: 40_000 });
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-group-composer]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'BROWSER_NEW_MESSAGE');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.evaluate("document.querySelector('[data-group-send]')?.click()");
  await page.waitFor("document.body.innerText.includes('BROWSER_NEW_MESSAGE')", { label: "群一发送的消息", timeoutMs: 20_000 });

  // Group two: switching shows only its own public history.
  await openGroup("浏览器群二");
  await page.waitFor("document.body.innerText.includes('GROUP_TWO_MSG')", { label: "群二公共历史" });
  assert.equal(String(await page.evaluate("document.body.innerText")).includes("GROUP_ONE_MSG"), false, "群一消息不能出现在群二");

  // Each policy can be started from the central control and reaches a terminal state.
  await openGroup("浏览器群一");
  // Wait until the central view has actually switched to group one before starting rounds.
  await page.waitFor("document.body.innerText.includes('GROUP_ONE_MSG')", { label: "切回群一", timeoutMs: 20_000 });
  for (const policy of ["round-robin", "parallel", "moderator", "free"]) {
    await page.evaluate(`document.querySelector('[data-group-policy=${JSON.stringify(policy)}]')?.click()`);
    await page.waitFor(`document.querySelector('[data-group-policy=${JSON.stringify(policy)}]')?.getAttribute('aria-pressed') === 'true'`, { label: `策略选中 ${policy}` });
    await page.evaluate("document.querySelector('[data-group-start-round]')?.click()");
    await page.waitFor(`(document.querySelector('[data-group-discussion-status]')?.textContent||'').includes(${JSON.stringify(policy)})`, { label: `策略状态 ${policy}`, timeoutMs: 40_000 });
    await page.waitFor(`(document.querySelector('[data-group-discussion-status]')?.textContent||'').includes('completed')`, { label: `策略完成 ${policy}`, timeoutMs: 60_000 });
  }
  const identityLeak = await page.evaluate("JSON.stringify([...performance.getEntriesByType('resource')].map(e => e.name).filter(n => n.includes('viewerLongAgentId')))");
  assert.equal(identityLeak, "[]");
  // Keep the earlier refresh regression while expanding the multi-group strategy coverage.
  await page.send("Page.reload");
  await page.waitFor("document.getElementById('workspace-groups-tab') !== null", { label: "刷新后导航恢复" });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await page.evaluate("document.getElementById('workspace-groups-tab')?.click()");
  await openGroup("浏览器群一");
  await page.waitFor("document.body.innerText.includes('BROWSER_NEW_MESSAGE') && document.body.innerText.includes('GROUP_ONE_MSG')", {
    label: "刷新后公共历史恢复", timeoutMs: 40_000,
  });
  // The owner-facing full-history entry: after a bound participation Session, each member exposes a
  // read-only history dialog that must actually load the export HTML.
  await page.waitFor("document.querySelector('[data-group-history]') !== null", { label: "成员完整历史入口", timeoutMs: 40_000 });
  await page.waitFor("document.querySelector('[data-group-history-public]') !== null", { label: "群聊完整历史入口", timeoutMs: 20_000 });
  await page.evaluate("document.querySelector('[data-group-history]')?.click()");
  await page.waitFor("document.querySelector('iframe.full-history-frame') !== null", { label: "完整历史对话框打开", timeoutMs: 20_000 });
  await page.close();
});
