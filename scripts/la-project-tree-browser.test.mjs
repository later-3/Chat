import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { fixture } from "../test/long-agents/daily-fixture.mjs";
import { readLongAgentState } from "../src/long-agents/storage.ts";
import { listRemovedChatSessions } from "../src/session-removal.ts";
import { launchBrowser, chromeExecutable } from "./cdp.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");
const WORK_TEXT = "TREE_WORK_OK";
const WRITER_MARK = "你只负责维护";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGINT");
  await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

/** LA→Project→Session 三级导航的真实浏览器验收：绑定项目、项目下新建会话、
 *  会话真实落在项目目录、刷新恢复、绑定/解绑不动会话。 */
test("the LA→Project→Session tree creates project-owned sessions and survives a refresh", {
  timeout: 420_000,
  concurrency: false,
  skip: chromeExecutable() === null ? "环境没有可用的 Chrome/Chromium" : false,
}, async (t) => {
  const cleanups = [];
  const f = await fixture({ after: (register) => cleanups.push(register) });
  const home = f.home;
  // 绑定项目 a（fixture 已登记 a/b，带 RULE_a 规则文件）。
  const { readLongAgentConfiguration, updateLongAgentConfiguration } = await import("../src/long-agents/configuration.ts");
  const config = await readLongAgentConfiguration("friend", home);
  await updateLongAgentConfiguration("friend", {
    schemaVersion: 1, expectedRevision: config.revision, name: config.agent.name, description: config.agent.description,
    enabled: config.agent.enabled, defaultProjectId: config.agent.defaultProjectId,
    boundProjectIds: ["a"],
    definition: {
      schemaVersion: 1, id: config.agent.definition.id, name: config.agent.definition.name, description: config.agent.definition.description,
      ...(config.agent.definition.model === null ? {} : { model: config.agent.definition.model }),
      ...(config.agent.definition.thinkingLevel === null ? {} : { thinkingLevel: config.agent.definition.thinkingLevel }),
      systemPrompt: config.agent.definition.systemPrompt, customInstructions: config.agent.definition.customInstructions,
      tools: config.agent.definition.tools, resources: config.agent.definition.resources,
    },
  }, home);

  // 预创建每日会话，让 Friend 出现在侧栏（与真实使用一致：先有会话再有项目树）。
  const { ensureProjectLongAgent } = await import("../src/long-agents/project-agent.ts");
  const registryAgent = (await (await import("../src/long-agents/storage.ts")).readLongAgentRegistry(home)).agents[0];
  await ensureProjectLongAgent({ chatHome: home, projectId: "friend", agent: registryAgent });
  const writerCalls = [];
  f.setHandler((body) => {
    const isWriter = body.messages.some((message) => message.role === "system"
      && (typeof message.content === "string" ? message.content : JSON.stringify(message.content)).includes(WRITER_MARK));
    if (isWriter) { writerCalls.push(body); return { content: "MEMORY_OK" }; }
    return { content: WORK_TEXT };
  });

  let output = "";
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = await import("node:child_process").then(({ spawn }) => spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env, CHAT_HOME: home,
      WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(home, "runtime", "workflow-data"),
      WORKFLOW_LOCAL_BASE_URL: baseUrl, MEM0_TELEMETRY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  let browser;
  t.after(async () => {
    fs.mkdirSync(path.join(projectRoot, ".data/verification/la-project-tree"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".data/verification/la-project-tree/browser-debug.json"), JSON.stringify({ output: output.slice(-8_000) }, null, 2));
    await browser?.close().catch(() => undefined);
    await stopProcess(server);
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  /** Radix 菜单以 pointerdown 打开，程序化 .click() 不会触发；用真实鼠标事件。 */
  const clickBySelector = async (selector, label = selector) => {
    const point = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    assert.notEqual(point, null, `找不到可见元素：${label}`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    }
  };

  const ready = async () => {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && server.exitCode === null) {
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return true; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`dev server did not start:\n${output.slice(-4_000)}`);
  };
  assert.equal(await ready(), true, output.slice(-2_000));

  browser = await launchBrowser();
  const page = await browser.newPage(`${baseUrl}/`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send("Network.enable");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visibleChat = "document.querySelector('[data-workspace-chat]')?.hidden === false";
  const openFriend = async () => {
    await page.waitFor("document.querySelector('[data-long-agent-open=\"friend\"]') !== null", { label: "Friend 出现在侧栏", timeoutMs: 60_000 });
    await page.evaluate("document.querySelector('[data-long-agent-open=\"friend\"]').click()");
    await page.waitFor(`${visibleChat} && document.querySelector('[data-chat-composer]:not([disabled])') !== null`, { label: "会话可输入", timeoutMs: 60_000 });
  };
  const send = async (text) => {
    await page.evaluate("document.querySelector('[data-chat-composer]').focus(); document.querySelector('[data-chat-composer]').select()");
    await page.send("Input.insertText", { text });
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13 });
    }
    const deadline = Date.now() + 90_000;
    for (;;) {
      await pause(100);
      if (await page.evaluate(`document.querySelector('[data-workspace-chat]')?.innerText.includes(${JSON.stringify(WORK_TEXT)})`)) break;
      if (Date.now() > deadline) {
        const debug = await page.evaluate(`(() => ({ text: document.querySelector('[data-workspace-chat]')?.innerText?.slice(0, 600) ?? null, alert: document.querySelector('[role="alert"]')?.textContent ?? null }))()`);
        const turnPostEvents = page.events.filter((event) => event.method === "Network.responseReceived" && event.params.response.url.includes("/turns"));
        const turnPosts = [];
        for (const event of turnPostEvents) {
          const body = await page.send("Network.getResponseBody", { requestId: event.params.requestId }).catch(() => null);
          turnPosts.push({ url: event.params.response.url.replace(baseUrl, ""), status: event.params.response.status, body: body?.body?.slice(0, 300) ?? null, postData: page.events.find((candidate) => candidate.method === "Network.requestWillBeSent" && candidate.params.requestId === event.params.requestId)?.params.request.postData ?? null });
        }
        const stateNow = await readLongAgentState(home);
        const debugTurns = stateNow.turns.map((entry) => ({ turnId: entry.turnId, status: entry.status, error: entry.error, storageProjectId: entry.storageProjectId ?? null, sessionId: entry.sessionId }));
        throw new Error(`轮次没有完成 ${text}\n${JSON.stringify(debug)}\n${JSON.stringify({ turnPosts, debugTurns })}\n${output.slice(-2_000)}`);
      }
    }
  };

  await ready();
  // 打开 Friend：项目树默认展开，Workspace 首位。
  await openFriend();
  await page.waitFor("document.querySelector('#long-agent-project-tree.is-open') !== null", { label: "项目树默认展开" });
  await page.waitFor("document.querySelector('[data-project-tree-project=\"friend\"]') !== null", { label: "Workspace 项目在列" });

  // 点进绑定项目 a = 真的切换上下文到 a（用户合同）：还没有会话时幂等创建一条归属会话并打开。
  await page.waitFor("document.querySelector('[data-project-tree-project=\"a\"]') !== null", { label: "绑定项目 a 在列", timeoutMs: 30_000 });
  await page.evaluate("document.querySelector('[data-project-tree-project=\"a\"]').click()");
  await page.waitFor("document.querySelector('[data-project-tree-session]') !== null", { label: "项目会话出现在列表" });
  await page.waitFor(`${visibleChat} && document.querySelector('[data-chat-composer]:not([disabled])') !== null`, { label: "项目会话已打开" });
  await page.waitFor("new URL(window.location.href).searchParams.get('projectId') === 'a'", { label: "URL 上下文切到项目 a" });

  // 发一轮：真实执行，Session 文件与轮次都归属项目 a。
  await send("first question in the project");
  const state = await readLongAgentState(home);
  const binding = state.projectSessions.find((entry) => entry.longAgentId === "friend" && entry.projectId === "a");
  assert.notEqual(binding, undefined, "项目归属会话绑定已持久化");
  const projectTurn = state.turns.filter((entry) => entry.sessionId === binding.sessionId);
  assert.ok(projectTurn.length >= 1);
  for (const turn of projectTurn) assert.equal(turn.storageProjectId, "a", "轮次冻结项目 = 会话归属项目");
  // 2026-10-04 存储合同：Agent 归属会话落在其 Agent 根的 per-agent 项目树。
  const alphaSessionDir = await (await import("../src/projects/registry.ts")).resolveProjectContext("a", home, { ownerLongAgentId: "friend" }).then((context) => context.sessionDir);
  assert.ok(fs.readdirSync(alphaSessionDir).some((name) => name.includes(binding.sessionId)), "Session 文件落在 Agent 的项目树");
  assert.equal(await page.evaluate(`document.querySelector('[data-workspace-chat]').innerText.includes(${JSON.stringify(WORK_TEXT)})`), true);

  // 会话动作入口是行内唯一的 “…” 菜单（列表行默认干净）：从菜单进入重命名。
  await clickBySelector(`[data-session-menu="${binding.sessionId}"]`, "会话动作菜单触发器");
  await page.waitFor(`document.querySelector('[data-session-action="rename"]') !== null`, { label: "会话动作菜单" });
  await clickBySelector('[data-session-action="rename"]', "重命名菜单项");
  await page.waitFor(`document.querySelector('[data-project-tree-rename-input="${binding.sessionId}"]') !== null`, { label: "重命名输入框" });
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-project-tree-rename-input="${binding.sessionId}"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '用户改的项目标题');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.waitFor(`document.querySelector('[data-project-tree-session="${binding.sessionId}"]')?.innerText.includes('用户改的项目标题')`, { label: "标题改为用户命名", timeoutMs: 30_000 });
  const { openChatSession: openRenamed } = await import("../src/chat-session.ts");
  const renamedSession = await openRenamed({ projectId: "a", chatHome: home, sessionId: binding.sessionId, ownerLongAgentId: "friend" });
  assert.equal(renamedSession.manager.getSessionName(), "用户改的项目标题", "用户命名写入会话文件");

  // 移除：同一菜单进入，确认后从列表消失、文件进入该 Agent 项目树下的移除区。
  await clickBySelector(`[data-session-menu="${binding.sessionId}"]`, "会话动作菜单触发器");
  await page.waitFor(`document.querySelector('[data-session-action="remove"]') !== null`, { label: "移除动作" });
  await clickBySelector('[data-session-action="remove"]', "移除菜单项");
  await page.waitFor(`document.querySelector('[role=alertdialog]') !== null`, { label: "移除确认" });
  await page.evaluate("Array.from(document.querySelectorAll('[role=alertdialog] button')).at(-1).click()");
  await page.waitFor(`document.querySelector('[data-project-tree-session="${binding.sessionId}"]') === null`, { label: "移除后列表不再显示", timeoutMs: 30_000 });
  const removedDir = path.join(alphaSessionDir, "removed");
  assert.equal(fs.existsSync(removedDir) && fs.readdirSync(removedDir).some((name) => name.includes(binding.sessionId)), true, "会话文件进入其归属项目树的移除区");
  const listed = await listRemovedChatSessions("a", home);
  assert.equal(listed.sessions.some((item) => item.id === binding.sessionId), true, "项目移除区能看到该会话");
  // 移除区：项目树入口打开弹层，会话在列，点“恢复”回到活跃列表。
  await page.evaluate("document.querySelector('[data-project-tree-removed]').click()");
  await page.waitFor(`document.querySelector('[data-session-restore="${binding.sessionId}"]') !== null`, { label: "移除区列出该会话", timeoutMs: 30_000 });
  await page.evaluate(`document.querySelector('[data-session-restore="${binding.sessionId}"]').click()`);
  await page.waitFor(`document.querySelector('[data-project-tree-session="${binding.sessionId}"]') !== null`, { label: "恢复后回到项目列表", timeoutMs: 30_000 });
  await page.evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find((b) => b.getAttribute('aria-label') === 'Close' || b.textContent.trim() === '✕')?.click()");

  // 搜索浮层：按钮触发 → 关键词命中全文 → 预览显示命中证据 → 打开
  await page.evaluate("document.querySelector('[data-project-tree-search]').click()");
  await page.waitFor("document.querySelector('[data-session-search-input]') !== null", { label: "搜索浮层", timeoutMs: 30_000 });
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-session-search-input]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(WORK_TEXT)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(`document.querySelector('[data-session-search-result="${binding.sessionId}"]') !== null`, { label: "搜索结果命中全文", timeoutMs: 30_000 });
  await page.waitFor("document.querySelector('[data-session-search-hit]') !== null", { label: "预览显示命中证据", timeoutMs: 15_000 });
  await clickBySelector("[data-session-search-open]", "打开搜索结果");
  await page.waitFor(`document.querySelector('[data-workspace-chat]').innerText.includes(${JSON.stringify(WORK_TEXT)})`, { label: "从搜索打开会话", timeoutMs: 30_000 });

  // 批量操作模式：顶部开关 → 行首勾选 → 底部操作条一次移除
  await page.evaluate("document.querySelector('[data-project-tree-select]').click()");
  await page.waitFor(`document.querySelector('[data-session-select="${binding.sessionId}"]') !== null`, { label: "批量勾选框", timeoutMs: 15_000 });
  await page.evaluate(`document.querySelector('[data-session-select="${binding.sessionId}"]').click()`);
  await page.waitFor("document.querySelector('[data-session-bulk-remove]') !== null && !document.querySelector('[data-session-bulk-remove]').disabled", { label: "批量操作条就绪" });
  await page.evaluate("document.querySelector('[data-session-bulk-remove]').click()");
  await page.waitFor("document.querySelector('[role=alertdialog]') !== null", { label: "批量移除确认" });
  await page.evaluate("Array.from(document.querySelectorAll('[role=alertdialog] button')).at(-1).click()");
  await page.waitFor(`document.querySelector('[data-project-tree-session="${binding.sessionId}"]') === null`, { label: "批量移除后列表不再显示", timeoutMs: 30_000 });
  // 恢复，保证后续刷新验收仍然可用。
  const { restoreRemovedChatSession } = await import("../src/session-removal.ts");
  await restoreRemovedChatSession("a", binding.sessionId, home);

  // 刷新恢复：URL 打开的是项目 a 的会话，树必须默认跟随该项目并直接列出它
  // （回归：曾经树停在 Workspace，看起来像"项目下没有会话"）。
  await page.send("Page.reload");
  await ready();
  await page.waitFor("document.querySelector('#long-agent-project-tree') !== null", { label: "刷新后项目树", timeoutMs: 60_000 });
  await page.waitFor(`document.querySelector('[data-project-tree-session="${binding.sessionId}"]') !== null`, { label: "树默认跟随当前会话的项目并列出它", timeoutMs: 60_000 });
  await page.evaluate("document.querySelector('[data-project-tree-session]').click()");
  await page.waitFor(`document.querySelector('[data-workspace-chat]').innerText.includes(${JSON.stringify(WORK_TEXT)})`, { label: "项目会话历史可见" });

  // 绑定/解绑的后端契约由配置 API 回归覆盖；此处经 API 变更后验证 UI 视图随数据而变。
  const { readLongAgentConfiguration: readLaConfig, updateLongAgentConfiguration: updateLaConfig } = await import("../src/long-agents/configuration.ts");
  const bindViaApi = async (ids) => {
    const config = await readLaConfig("friend", home);
    await updateLaConfig("friend", {
      schemaVersion: 1, expectedRevision: config.revision, name: config.agent.name, description: config.agent.description,
      enabled: config.agent.enabled, defaultProjectId: config.agent.defaultProjectId,
      boundProjectIds: ids,
      definition: {
        schemaVersion: 1, id: config.agent.definition.id, name: config.agent.definition.name, description: config.agent.definition.description,
        ...(config.agent.definition.model === null ? {} : { model: config.agent.definition.model }),
        ...(config.agent.definition.thinkingLevel === null ? {} : { thinkingLevel: config.agent.definition.thinkingLevel }),
        systemPrompt: { mode: "replace", text: "Stable Friend" },
        customInstructions: [], tools: config.agent.definition.tools, resources: config.agent.definition.resources,
      },
    }, home);
    await page.send("Page.reload"); await ready(); await openFriend();
    await page.waitFor("document.querySelector('[data-project-tree-project=\"a\"]') !== null", { label: "项目树刷新", timeoutMs: 30_000 });
  };
  await bindViaApi(["a", "b"]);
  await page.waitFor("document.querySelector('[data-project-tree-project=\"b\"]') !== null", { label: "新绑定项目出现在树里" });
  assert.equal(await page.evaluate("document.querySelector('[data-workspace-chat]').innerText.includes(" + JSON.stringify(WORK_TEXT) + ")"), true, "绑定/解绑流不丢项目会话历史");
  await bindViaApi(["a"]);
  await page.waitFor("document.querySelector('[data-project-tree-project=\"b\"]') === null", { label: "解绑后从树里消失" });
  const after = await readLongAgentState(home);
  assert.ok(after.projectSessions.some((entry) => entry.sessionId === binding.sessionId), "解绑不删除项目会话");
  const { readProjectRegistry } = await import("../src/projects/registry.ts");
  assert.ok((await readProjectRegistry(home)).projects.some((project) => project.projectId === "a"), "解绑不删除项目登记");
});
