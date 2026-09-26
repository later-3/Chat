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

/** Parse the integration work instruction the server composes for a 建题/fork request. */
function integrationPlan(userText) {
  const requestId = /\brequestId=([A-Za-z0-9:_-]+)/.exec(userText)?.[1];
  const topicId = /\btopicId=([A-Za-z0-9:_-]+)/.exec(userText)?.[1];
  const title = (/目标节点标题：(.+)/.exec(userText)?.[1] ?? "").trim();
  const purpose = (/目的：(.+)/.exec(userText)?.[1] ?? "").trim();
  const parentsRaw = /父边（必须原样传给 create_node\.parents）：(\[[^\n]*\])/.exec(userText)?.[1];
  const sourceSessionId = /(?:来源日常会话（只读）：|父节点会话（整合来源，只读）：)(\S+)/.exec(userText)?.[1];
  return { requestId, topicId, title, purpose, sourceSessionId,
    parents: parentsRaw === undefined ? null : JSON.parse(parentsRaw) };
}

test("topic mode is usable in a real browser: enter a node, see structured execution, edit memory with a CAS conflict, toggle, fork/supplement from the parent anchor and recover on refresh", {
  timeout: 420_000,
  skip: chromeExecutable() === null ? "环境没有可用的 Chrome/Chromium" : false,
}, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-topics-browser-")));
  const home = path.join(root, "home");
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-topics-browser-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "RULE_BROWSER\n");
  // A file the work round really reads, so the node conversation carries a REAL tool call + result.
  const readableFile = path.join(workspace, "source.txt");
  fs.writeFileSync(readableFile, "BROWSER_TOOL_RESULT");
  await openProject({ path: workspace, chatHome: home, id: "a", name: "a" });
  const snapshotDir = path.join(home, "runtime/long-agents/friend");
  fs.mkdirSync(snapshotDir, { recursive: true });
  const hash = `sha256:${"a".repeat(64)}`;
  fs.writeFileSync(path.join(snapshotDir, "agent-group-snapshot.json"), JSON.stringify({ schemaVersion: 1, longAgentId: "friend", agentGroupId: "group-friend", fetchedAt: new Date().toISOString(), snapshot: {
    id: "group-friend", name: "Friend", standingInstructions: "Stable identity", revision: hash, workspace: { folder: "friend", memoryFileCount: 2 },
    coreMemory: { index: { path: "index.md", content: "index", size: 5, updatedAt: new Date().toISOString(), revision: hash },
      definition: { path: "system/definition.md", content: "definition", size: 10, updatedAt: new Date().toISOString(), revision: hash } } } }));
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [{ id: "local", name: "Local", gatewayBaseUrl: "http://127.0.0.1:1" }],
    agents: [{ id: "friend", name: "friend", description: "Stable", enabled: true, timeZone: "Asia/Shanghai", instanceId: "local",
      nanoclawAgentGroupId: "group-friend", defaultProjectId: "friend",
      definition: { schemaVersion: 1, id: "friend", name: "friend", description: "Stable",
        systemPrompt: { mode: "replace", text: "Stable Friend" }, customInstructions: [],
        tools: { mode: "explicit", names: ["read"], exclude: [], addresses: ["system:tool/topic_manage", "system:tool/workflow_call"] },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } } }],
  }, home);

  function writeText(response, text) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish, usage) => JSON.stringify({ id: "chatcmpl-browser", object: "chat.completion.chunk", created: 0, model: "browser-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
    response.write(`data: ${frame({ role: "assistant", content: text }, null)}\n\n`);
    response.write(`data: ${frame({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })}\n\n`);
    response.end("data: [DONE]\n\n");
  }
  function writeToolCalls(response, toolCalls) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-browser-tool", object: "chat.completion.chunk", created: 0, model: "browser-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-browser-tool", object: "chat.completion.chunk", created: 0, model: "browser-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  }
  const toolCall = (name, args) => [{ index: 0, id: `browser-${name}-${Math.random().toString(36).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
  let rememberWaiting = false;
  let sawImageInput = false;
  const modelCalls = [];
  const modelServer = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "image_url"))) sawImageInput = true;
    const systemText = messages.filter((message) => message.role === "system").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")).join("\n");
    const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool.function?.name) : [];
    const hasToolResult = messages.some((message) => message.role === "tool");
    const toolResultCount = messages.filter((message) => message.role === "tool").length;
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    // The integration instruction may arrive as a content ARRAY; flatten only its text blocks so real
    // newlines survive (JSON.stringify would escape them and break the line-anchored parsing).
    const userText = typeof lastUser?.content === "string" ? lastUser.content
      : Array.isArray(lastUser?.content) ? lastUser.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
        : "";
    modelCalls.push({ userText: userText.slice(0, 200), system: systemText.slice(0, 120), tools });
    // A controlled slow writer lets the browser prove the answer is visible before memory finishes.
    if (systemText.includes("只负责维护") && JSON.stringify(messages).includes("UI_WAIT_REMEMBER")) {
      rememberWaiting = true;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "slow-writer", object: "chat.completion.chunk", model: "browser-model", choices: [{ index: 0, delta: { role: "assistant", content: "MEMORY_STILL_RUNNING" }, finish_reason: null }] })}\n\n`);
      return; // The user's real Stop action must abort this stream.
    }
    if (systemText.includes("Stable Friend") && userText.includes("帮我把这个问题建成一个主题会话")) {
      const lastUserIndex = messages.findLastIndex(message => message.role === "user");
      if (messages.slice(lastUserIndex + 1).some(message => message.role === "tool")) { writeText(response, "已发起整理，请审核主题上下文。"); return; }
      writeToolCalls(response, toolCall("topic_manage", { operation: "request_topic", title: "日常发起主题", purpose: "继续排查" }));
      return;
    }
    // (0) The review-gated creation Workflow: the collector reads the trusted source then emits ONLY the
    // planner metadata + the structured draft; the creator calls the controlled commit tool.
    if (systemText.includes("「整理 Agent」")) {
      const allText = messages.map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")).join("\n");
      const sourceMatch = /来源会话（只读）：([0-9A-Za-z._:-]+)/.exec(allText);
      if (!messages.some((message) => message.role === "tool")) {
        writeToolCalls(response, toolCall("topic_manage", { operation: "read_memory", sourceSessionId: sourceMatch === null ? "missing" : sourceMatch[1] }));
        return;
      }
      const entryId = /smem-[0-9a-f-]+/.exec(messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content ?? "")).join("\n"))?.[0] ?? "missing";
      const title = allText.includes("第二次修改") ? "日常主题第二版修改" : allText.includes("第一次修改") ? "日常主题第一版修改" : /建议标题：([^；。\n]+)/.exec(allText)?.[1]?.trim() ?? "浏览器主题";
      writeText(response, [
        '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->',
        `<!-- chat-topic-draft {"title":"${title}","purpose":"浏览器验收","integrationSummary":"整合摘要","frozenProjectContext":null,"initialMemory":[{"storageProjectId":"friend","sessionId":"${sourceMatch === null ? "missing" : sourceMatch[1]}","entryId":"${entryId}","content":"来源记忆"}]} -->`,
      ].join("\n"));
      return;
    }
    if (systemText.includes("「创建 Agent」")) {
      if (messages.at(-1)?.role === "tool") { writeText(response, "已按批准版本创建。"); return; }
      writeToolCalls(response, toolCall("topic_manage", { operation: "commit_creation" }));
      return;
    }
    // (a) The 建题/fork integration work: really call topic_manage so a node is produced (or fails).
    if (userText.includes("这是一次「整合建题」后台工作")) {
      const plan = integrationPlan(userText);
      if (toolResultCount === 0) { writeToolCalls(response, toolCall("topic_manage", { operation: "read_memory", sourceSessionId: plan.sourceSessionId })); return; }
      if (plan.parents === null) {
        if (toolResultCount === 1) { writeToolCalls(response, toolCall("topic_manage", { operation: "create_topic", requestId: plan.requestId, title: plan.title, purpose: plan.purpose })); return; }
        if (toolResultCount === 2) { writeToolCalls(response, toolCall("topic_manage", { operation: "create_node", topicId: plan.topicId, requestId: plan.requestId, title: plan.title, integrationSummary: "浏览器整合摘要" })); return; }
      } else if (toolResultCount === 1) {
        writeToolCalls(response, toolCall("topic_manage", { operation: "create_node", topicId: plan.topicId, requestId: plan.requestId, title: plan.title, integrationSummary: "浏览器分叉摘要", parents: plan.parents }));
        return;
      }
      writeText(response, `已建节点「${plan.title ?? ""}」`);
      return;
    }
    // (b) The session-memory writer must actually call session_memory so a real memory entry exists.
    if (systemText.includes("只负责维护") && tools.includes("session_memory") && !hasToolResult) {
      writeToolCalls(response, toolCall("session_memory", { operation: "write", purpose: "finding", author: "agent", content: "BROWSER_MEMORY", expectedRevision: 0 }));
      return;
    }
    if (systemText.includes("只负责维护")) { writeText(response, "MEMORY_RECEIPT_ONLY"); return; }
    // (c) A normal work round really calls a tool, so the node conversation has structured execution content.
    if (tools.includes("read") && !hasToolResult) {
      writeToolCalls(response, toolCall("read", { path: readableFile }));
      return;
    }
    writeText(response, "BROWSER_TOPIC_REPLY");
  });
  await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
  const modelAddress = modelServer.address();
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "browser-local", defaultModel: "browser-model", defaultThinkingLevel: "off", retry: { enabled: false } }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "browser-local": {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: "openai-completions", apiKey: "browser-key",
    models: [{ id: "browser-model", name: "Browser Model", reasoning: false, input: ["text", "image"], contextWindow: 128_000, maxTokens: 4_096,
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
    // Local faux-model diagnostics are intentionally retained with the screenshots for this run.
    fs.mkdirSync(path.join(projectRoot, ".data/verification/topic-mode/closeout"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".data/verification/topic-mode/closeout/browser-debug.json"), JSON.stringify({ modelCalls, output }, null, 2));
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
  const shell = await fetch(`${baseUrl}/`);
  assert.equal(shell.status, 200, `前端未构建：HTTP ${String(shell.status)}\n${output}`);

  // ---- Server-side setup: a daily session (needed by the integration origin), then the topic tree. ----
  const { createTopic, createTopicNodeWithSession } = await import("../src/long-agents/topics.ts");
  const { acceptLongAgentTurn, drainLongAgentTurns } = await import("../src/long-agents/turn-queue.ts");
  const { readLongAgentState } = await import("../src/long-agents/storage.ts");
  const { readSessionMemory, writeSessionMemoryEntry } = await import("../src/long-agents/session-memory.ts");
  await acceptLongAgentTurn({ chatHome: home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
    turnId: "browser-daily-1", text: "今天先聊一句", source: "chat-web" });
  await drainLongAgentTurns(home, "friend");
  const daily = (await readLongAgentState(home)).dailySessions.find((day) => day.longAgentId === "friend");
  assert.notEqual(daily, undefined, "a daily session exists for the integration origin");
  const sourceMemory = (await writeSessionMemoryEntry({ chatHome: home, longAgentId: "friend", sessionId: daily.sessionId,
    operation: "write", purpose: "finding", author: "agent", content: "BROWSER_SOURCE_MEMORY", expectedRevision: (await readSessionMemory(home, "friend", daily.sessionId)).revision })).entries.at(-1);

  const topic = (await createTopic({ chatHome: home, longAgentId: "friend", title: "浏览器主题", purpose: "浏览器验收", requestId: "browser-topic-1", expectedRevision: 0 })).topic;
  // The root carries a frozen project and a real provenance source, both shown read-only in the node detail.
  const rootNode = (await createTopicNodeWithSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "browser-topic-1",
    title: "根节点", createdBy: "agent", frozenProjectContext: "a",
    sources: [{ source: { storageProjectId: "friend", sessionId: daily.sessionId, entryId: sourceMemory.entryId }, content: "根节点初始记忆" }] })).node;
  const parentNode = (await createTopicNodeWithSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "browser-parent-1", title: "父节点", createdBy: "agent",
    parents: [{ parentNodeId: rootNode.nodeId }] })).node;
  const targetMemory = (await createTopicNodeWithSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "browser-target-m", title: "目标节点M", createdBy: "agent",
    parents: [{ parentNodeId: rootNode.nodeId }] })).node;
  const targetRelay = (await createTopicNodeWithSession({ chatHome: home, longAgentId: "friend", topicId: topic.topicId, requestId: "browser-target-r", title: "目标节点R", createdBy: "agent",
    parents: [{ parentNodeId: rootNode.nodeId }] })).node;
  for (const target of [rootNode, parentNode]) {
    await acceptLongAgentTurn({ chatHome: home, longAgentId: "friend", requireInteractionRevision: false, projectId: "friend",
      turnId: `browser-round-${target.nodeId}`, text: "为什么空指针", source: "chat-web", topicNode: { topicId: topic.topicId, nodeId: target.nodeId } });
    await drainLongAgentTurns(home, "friend", target.sessionId);
  }
  const parentAnchors = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/${topic.topicId}/nodes/${parentNode.nodeId}/anchors`)).json();
  assert.ok(parentAnchors.anchors.length >= 1, `parent node needs a settled anchor\n${JSON.stringify(parentAnchors)}`);

  // ---- A fresh direct topic link must not be hijacked by default-Friend session selection. ----
  browser = await launchBrowser();
  const page = await browser.newPage(`${baseUrl}/?view=topics&topicAgent=friend&topicId=${topic.topicId}&nodeId=${rootNode.nodeId}`);
  // New acceptance scenarios use hit-tested pointer events and keyboard input, not DOM click().
  const click = async (selector) => {
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, { label: selector, timeoutMs: 60_000 });
    await page.waitFor(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
      el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2));
    })()`, { label: `可点击 ${selector}`, timeoutMs: 20_000 }).catch(async error => {
      await screenshot('covered-control');
      console.error(await page.evaluate("document.body.innerText"));
      throw error;
    });
    const point = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(); const x = r.x + r.width/2, y = r.y + r.height/2;
      if (!el.contains(document.elementFromPoint(x,y))) throw new Error('Control is covered: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  const type = async (selector, text) => {
    await click(selector);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await page.send("Input.insertText", { text });
  };
  const screenshot = async name => {
    const dir = path.join(projectRoot, ".data/verification/topic-mode/closeout"); fs.mkdirSync(dir, { recursive: true });
    const capture = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(capture.data, "base64"));
  };
  const closeAux = async () => {
    if (await page.evaluate("document.querySelector('[data-topic-aux]') !== null")) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.waitFor("document.querySelector('[data-topic-aux]') === null", { label: '收起会话资料' });
    }
  };
  const openAux = async () => {
    if (!(await page.evaluate("document.querySelector('[data-topic-aux]') !== null"))) await click('[data-topic-aux-open]');
  };
  const sendInSession = async (text) => {
    await page.evaluate(`(() => {
      const ta = document.querySelector('[data-topic-session] textarea');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // Click the shared composer's Send button (works regardless of the mobile Enter shortcut).
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('[data-topic-session] button')].find((b) => (b.textContent ?? '').trim() === 'Send' && !b.disabled)
        ?? [...document.querySelectorAll('[data-topic-session] button')].find((b) => !b.disabled && b.querySelector('svg') && b.closest('form'));
      button?.click();
    })()`);
  };
  await page.waitFor("document.readyState === 'complete'", { label: "页面加载", timeoutMs: 30_000 });
  await page.waitFor("document.getElementById('workspace-topics-tab') !== null", { label: "导航栏主题入口", timeoutMs: 40_000 });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(await page.evaluate("new URLSearchParams(window.location.search).get('view')"), "topics", "fresh topic deep link remains on the requested surface without clicking the rail again");
  await page.waitFor("document.querySelector('[data-topics-view-root]') !== null", { label: "主题视图", timeoutMs: 30_000 });
  await page.waitFor("document.querySelector('[data-topics-friend-select]')?.value", { label: "Friend 选择器", timeoutMs: 20_000 });
  await page.waitFor(`document.querySelector('[data-topic-id=${JSON.stringify(topic.topicId)}]') !== null`, { label: "主题列表", timeoutMs: 20_000 });

  // 1) Open an existing topic and enter an existing node; the root's conversation is structured.
  await page.evaluate(`document.querySelector('[data-topic-id=${JSON.stringify(topic.topicId)}]')?.click()`);
  await page.waitFor(`document.querySelector('[data-topic-node-id=${JSON.stringify(rootNode.nodeId)}]') !== null`, { label: "节点列表", timeoutMs: 20_000 });
  await page.waitFor("document.querySelector('[data-topic-session]') !== null", { label: "节点对话区自动进入", timeoutMs: 20_000 });
  // Server fact: the node conversation really carries a structured tool call AND its result.
  const rootMessages = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/${topic.topicId}/nodes/${rootNode.nodeId}/messages`)).json();
  assert.equal(rootMessages.context.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.toolName === "read")), true, "a real tool call is preserved");
  assert.equal(rootMessages.context.messages.some((message) => message.role === "toolResult" && message.content.some((block) => block.type === "text" && block.text.includes("BROWSER_TOOL_RESULT"))), true, "the tool result is preserved");
  // The tool result renders in the SHARED MessageView, inline under its tool call (expanded on demand).
  // The shared ChatWindow collapses a round's process; expand it to see the real tool call, then the
  // tool result (MessageView renders the result inline under the call only when expanded).
  await page.waitFor("[...document.querySelectorAll('[data-topic-session]')].some((root) => root.innerText.includes('tool calls'))", { label: "工具过程折叠块", timeoutMs: 30_000 });
  await page.evaluate(`(() => {
    const toggle = [...document.querySelectorAll('[data-topic-session] *')].find((el) => el.textContent?.trim() === 'Process details');
    (toggle?.closest('button') ?? toggle)?.click();
  })()`);
  await page.waitFor("[...document.querySelectorAll('[data-topic-session] button')].some((button) => button.textContent.includes('read'))", { label: "工具调用块", timeoutMs: 20_000 });
  await page.evaluate("[...document.querySelectorAll('[data-topic-session] button')].find((button) => button.textContent.includes('read'))?.click()");
  await page.waitFor("document.querySelector('[data-topic-session]')?.innerText.includes('BROWSER_TOOL_RESULT')", { label: "结构化工具结果（展开）", timeoutMs: 20_000 });
  // 2) Initial sources and the frozen project are shown read-only.
  await openAux();
  assert.equal(String(await page.evaluate("document.querySelector('[data-topic-frozen-project]')?.textContent ?? ''")).includes("a"), true, "frozen project shown");
  assert.equal(String(await page.evaluate("document.querySelector('[data-topic-initial-sources]')?.textContent ?? ''")).includes(sourceMemory.entryId), true, "initial source shown");

  // 3) Send a node message and see the structured execution come back.
  await closeAux();
  await sendInSession('UI_TOPIC_MESSAGE');
  await page.waitFor("document.querySelector('[data-topic-session]')?.innerText.includes('UI_TOPIC_MESSAGE') && document.querySelector('[data-topic-session]')?.innerText.includes('BROWSER_TOPIC_REPLY')", { label: "节点对话发送", timeoutMs: 90_000 });

  // 4) Memory edit with a real CAS conflict: bump the server revision behind the loaded UI, then save.
  await openAux();
  await page.waitFor("document.querySelector('[data-session-memory-edit]') !== null", { label: "记忆条目", timeoutMs: 60_000 });
  const memoryBefore = await (await fetch(`${baseUrl}/api/long-agents/friend/sessions/${rootNode.sessionId}/memory`)).json();
  await fetch(`${baseUrl}/api/long-agents/friend/sessions/${rootNode.sessionId}/memory`, { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "write", purpose: "finding", content: "SERVER_SIDE_BUMP", expectedRevision: memoryBefore.revision }) });
  await page.evaluate("document.querySelector('[data-session-memory-edit]')?.click()");
  await page.waitFor("document.querySelector('[data-session-memory-content]') !== null", { label: "记忆编辑器", timeoutMs: 10_000 });
  await page.evaluate(`(() => {
    const area = document.querySelector('[data-session-memory-content]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, 'UI_EDITED_MEMORY');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.evaluate("document.querySelector('[data-session-memory-save]')?.click()");
  await page.waitFor("document.querySelector('[data-session-memory-conflict]') !== null", { label: "记忆 CAS 冲突", timeoutMs: 20_000 });

  // 5) Refresh, re-enter the node and edit the memory for real (content + purpose).
  await page.send("Page.reload");
  await page.waitFor("document.readyState === 'complete'", { label: "刷新加载", timeoutMs: 30_000 });
  await page.waitFor("document.querySelector('[data-topics-view-root]') !== null", { label: "刷新后主题视图", timeoutMs: 30_000 });
  await page.waitFor(`document.querySelector('[data-topic-id=${JSON.stringify(topic.topicId)}]') !== null`, { label: "刷新后主题列表", timeoutMs: 30_000 });
  await page.evaluate(`document.querySelector('[data-topic-id=${JSON.stringify(topic.topicId)}]')?.click()`);
  await page.waitFor(`document.querySelector('[data-topic-node-id=${JSON.stringify(rootNode.nodeId)}]') !== null`, { label: "刷新后节点列表", timeoutMs: 20_000 });
  await page.evaluate(`document.querySelector('[data-topic-node-id=${JSON.stringify(rootNode.nodeId)}]')?.click()`);
  await openAux();
  await page.waitFor("document.querySelector('[data-session-memory-edit]') !== null", { label: "刷新后记忆条目", timeoutMs: 30_000 });
  await page.evaluate("document.querySelector('[data-session-memory-edit]')?.click()");
  await page.waitFor("document.querySelector('[data-session-memory-content]') !== null", { label: "刷新后记忆编辑器", timeoutMs: 10_000 });
  await page.evaluate(`(() => {
    const area = document.querySelector('[data-session-memory-content]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, 'UI_EDITED_MEMORY');
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const select = document.querySelector('[data-session-memory-purpose]');
    const selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    selectSetter.call(select, 'experience');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.evaluate("document.querySelector('[data-session-memory-save]')?.click()");
  await page.waitFor("document.body.innerText.includes('UI_EDITED_MEMORY')", { label: "编辑后的记忆", timeoutMs: 40_000 });
  // Server fact: the superseding entry really has the new content and purpose.
  const memoryAfterEdit = await (await fetch(`${baseUrl}/api/long-agents/friend/sessions/${rootNode.sessionId}/memory`)).json();
  assert.equal(memoryAfterEdit.entries.some((entry) => entry.content === "UI_EDITED_MEMORY" && entry.purpose === "experience" && entry.status === "active"), true, JSON.stringify(memoryAfterEdit.entries));

  // 6) Toggle the node's session-memory switch; poll the SERVER fact (the write is asynchronous).
  const nodeMemoryState = async () => (await (await fetch(`${baseUrl}/api/long-agents/friend/topics/${topic.topicId}`)).json())
    .nodes.find((node) => node.nodeId === rootNode.nodeId).sessionMemory;
  const waitForMemoryState = async (expected, label) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await nodeMemoryState() === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.fail(`${label}: session memory never became ${expected}`);
  };
  await page.evaluate("document.querySelector('[data-topic-memory-toggle]')?.click()");
  await waitForMemoryState("off", "toggling memory off");
  await page.evaluate("document.querySelector('[data-topic-memory-toggle]')?.click()");
  await waitForMemoryState("on", "toggling memory on");
  await page.waitFor("document.body.innerText.includes('UI_EDITED_MEMORY')", { label: "切换记忆后重载", timeoutMs: 30_000 });

  // 7) R4 memory supplement: pick the PARENT (not the current child) and one of the PARENT's anchors.
  const supplement = async (targetNode, content) => {
    await closeAux();
    await page.evaluate(`document.querySelector('[data-topic-node-id=${JSON.stringify(targetNode.nodeId)}]')?.click()`);
    await openAux();
    await page.waitFor("document.querySelector('[data-topic-supplement-parent]') !== null", { label: "补充整合父节点选择", timeoutMs: 20_000 });
    await page.evaluate(`(() => {
      const select = document.querySelector('[data-topic-supplement-parent]');
      const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      set.call(select, ${JSON.stringify(parentNode.nodeId)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(`(document.querySelector('[data-topic-supplement-anchor]')?.options?.length ?? 0) > 1`, { label: "父节点锚点列表", timeoutMs: 20_000 });
    await page.evaluate(`(() => {
      const select = document.querySelector('[data-topic-supplement-anchor]');
      const option = [...select.options].find((candidate) => candidate.value !== '');
      const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      set.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.querySelector('[data-topic-supplement-content]');
      const inputSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      inputSet.call(input, ${JSON.stringify(content)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.evaluate("document.querySelector('[data-topic-supplement-confirm]')?.click()");
  };
  const selectProduct = (kind) => page.evaluate(`(() => {
    const product = document.querySelector('[data-topic-supplement-product]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    set.call(product, ${JSON.stringify(kind)}); product.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.waitFor("document.querySelector('[data-topic-supplement-product]') !== null", { label: "补充整合产物选择", timeoutMs: 20_000 });
  await selectProduct("memory");
  await supplement(targetMemory, "UI_SUPPLEMENT_MEMORY");
  await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const detail = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/${topic.topicId}`)).json();
      if (detail.edges.some((edge) => edge.parentNodeId === parentNode.nodeId && edge.childNodeId === targetMemory.nodeId)) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.fail("memory supplement did not create its parent edge");
  })();

  // 8) R4 relay supplement: it must run a real round, show the relay badge and complete.
  await selectProduct("relay");
  await supplement(targetRelay, "UI_SUPPLEMENT_RELAY");
  await page.waitFor("document.body.innerText.includes('UI_SUPPLEMENT_RELAY')", { label: "代传补充整合", timeoutMs: 90_000 });
  // The relay round really completed and really appended exactly one relayed message.
  const relayMessages = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/${topic.topicId}/nodes/${targetRelay.nodeId}/messages`)).json();
  assert.equal(relayMessages.context.messages.filter((message) => message.role === "user" && message.chatTopicRelay !== undefined).length, 1, "exactly one relayed native message");
  assert.equal(relayMessages.context.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall")), true, "the relay round was a real structured round");
  const relayDetail = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/${topic.topicId}`)).json();
  assert.equal(relayDetail.edges.some((edge) => edge.parentNodeId === parentNode.nodeId && edge.childNodeId === targetRelay.nodeId), true, "the relay supplement created its parent edge");
  // The relayed message renders with the independent relay badge.
  await page.evaluate(`document.querySelector('[data-topic-node-id=${JSON.stringify(targetRelay.nodeId)}]')?.click()`);
  await page.waitFor("document.querySelector('[data-topic-session]')?.innerText.includes('UI_SUPPLEMENT_RELAY')", { label: "代传消息可见", timeoutMs: 30_000 });

  await closeAux();
  // 9) Fork from a parent anchor: choose the anchor on the root, submit, wait for the child, and
  //    continue the conversation inside it. Everything is checked against the SERVER.
  await page.evaluate(`document.querySelector('[data-topic-node-id=${JSON.stringify(rootNode.nodeId)}]')?.click()`);
  await openAux();
  await page.waitFor("document.querySelector('[data-topic-fork-anchor]') !== null", { label: "可分叉锚点", timeoutMs: 30_000 });
  const forkedAnchorId = await page.evaluate("document.querySelector('[data-topic-fork-anchor]')?.getAttribute('data-topic-fork-anchor')");
  const forkTitle = `UI分叉${Date.now()}`;
  await page.evaluate("document.querySelector('[data-topic-fork-anchor]')?.click()");
  await page.waitFor("document.querySelector('[data-topic-fork-title]') !== null", { label: "分叉表单", timeoutMs: 10_000 });
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-topic-fork-title]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(forkTitle)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.evaluate("document.querySelector('[data-topic-fork-submit]')?.click()");
  // Fork runs the SAME review-gated Workflow; approve it before the child exists.
  await page.waitFor("document.querySelector('[data-topic-creation-review] [data-plan-review-approve]') !== null", { label: "分叉审核卡片", timeoutMs: 90_000 });
  await page.evaluate("document.querySelector('[data-plan-review-approve]')?.click()");
  const forkDetail = await (async () => {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const detail = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/${topic.topicId}`)).json();
      const child = detail.nodes.find((node) => node.title === forkTitle);
      if (child !== undefined) return { detail, child };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.fail("UI fork did not produce a server-side child node");
  })();
  const forkEdge = forkDetail.detail.edges.find((edge) => edge.childNodeId === forkDetail.child.nodeId && edge.parentNodeId === rootNode.nodeId);
  assert.ok(forkEdge, "the fork created its parent edge");
  assert.equal(forkEdge.anchorEntryId, forkedAnchorId, "the fork edge freezes the anchor the user chose");
  await page.waitFor(`document.querySelector('[data-topic-node-id=${JSON.stringify(forkDetail.child.nodeId)}]') !== null`, { label: "分叉子节点出现在 UI", timeoutMs: 30_000 });
  await page.evaluate(`document.querySelector('[data-topic-node-id=${JSON.stringify(forkDetail.child.nodeId)}]')?.click()`);
  await page.waitFor("document.querySelector('[data-topic-session] textarea') !== null", { label: "子节点对话", timeoutMs: 20_000 });
  await sendInSession('UI_FORK_CHILD_MESSAGE');
  await page.waitFor("document.querySelector('[data-topic-session]')?.innerText.includes('UI_FORK_CHILD_MESSAGE') && document.querySelector('[data-topic-session]')?.innerText.includes('BROWSER_TOPIC_REPLY')", { label: "子节点继续对话", timeoutMs: 90_000 });

  // 9) 建题 from the UI: the integration status must be trackable to a real, server-side node.
  await page.evaluate("document.querySelector('[data-topics-root] details')?.setAttribute('open', 'open')");
  await page.waitFor("document.querySelector('[data-topic-create-title]') !== null", { label: "建题表单", timeoutMs: 10_000 });
  const createdTitle = `UI主题${Date.now()}`;
  await page.evaluate(`(() => {
    const title = document.querySelector('[data-topic-create-title]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(title, ${JSON.stringify(createdTitle)});
    title.dispatchEvent(new Event('input', { bubbles: true }));
    const purpose = document.querySelector('[data-topic-create-purpose]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(purpose, 'UI 验收');
    purpose.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.evaluate("document.querySelector('[data-topic-create-submit]')?.click()");
  // The new entry runs the review-gated Workflow: the panel shows the shared review card, and the node
  // is created only after approval.
  await page.waitFor("document.querySelector('[data-topic-creation-review] [data-plan-review-approve]') !== null", { label: "创建审核卡片", timeoutMs: 90_000 });
  const reviewPlanText = String(await page.evaluate("document.querySelector('[data-topic-creation-review]')?.innerText || ''"));
  assert.equal(reviewPlanText.includes(createdTitle), true, "the review shows the topic context, not just a title");
  await page.evaluate("document.querySelector('[data-plan-review-approve]')?.click()");
  await (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const graph = await (await fetch(`${baseUrl}/api/long-agents/friend/topics`)).json();
      if (graph.topics.some((candidate) => candidate.title === createdTitle)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.fail("批准后没有服务端主题产物");
  })();
  await page.waitFor(`document.querySelector('[data-topic-id]') !== null && document.body.innerText.includes(${JSON.stringify(createdTitle)})`, { label: "建题结果出现在 UI", timeoutMs: 30_000 });
  // The panel opened the created node as a real session.
  await page.waitFor("document.querySelector('[data-topic-session] textarea') !== null", { label: "进入新建会话", timeoutMs: 30_000 });

  // 10) Refresh recovery: messages, memory, edges, relay badge and the initial sources all come back.
  await page.send("Page.reload");
  await page.waitFor("document.readyState === 'complete'", { label: "刷新加载", timeoutMs: 30_000 });
  await page.waitFor("document.querySelector('[data-topics-view-root]') !== null", { label: "刷新后主题视图", timeoutMs: 30_000 });
  await page.evaluate(`document.querySelector('[data-topic-id=${JSON.stringify(topic.topicId)}]')?.click()`);
  await page.waitFor(`document.querySelector('[data-topic-node-id=${JSON.stringify(rootNode.nodeId)}]') !== null`, { label: "刷新后节点列表", timeoutMs: 20_000 });
  await page.evaluate(`document.querySelector('[data-topic-node-id=${JSON.stringify(rootNode.nodeId)}]')?.click()`);
  await page.waitFor("document.querySelector('[data-topic-session]')?.innerText.includes('UI_TOPIC_MESSAGE')", { label: "刷新后消息恢复", timeoutMs: 40_000 });
  await openAux();
  await page.waitFor("document.body.innerText.includes('UI_EDITED_MEMORY')", { label: "刷新后记忆恢复", timeoutMs: 30_000 });
  assert.equal(String(await page.evaluate("document.querySelector('[data-topic-frozen-project]')?.textContent ?? ''")).includes("a"), true, "frozen project recovered on refresh");
  await page.evaluate(`document.querySelector('[data-topic-node-id=${JSON.stringify(targetRelay.nodeId)}]')?.click()`);
  await page.waitFor("document.querySelector('[data-topic-session]')?.innerText.includes('UI_SUPPLEMENT_RELAY')", { label: "刷新后代传消息恢复", timeoutMs: 30_000 });
  // The forked child and its conversation survive the refresh too.
  await page.waitFor(`document.querySelector('[data-topic-node-id=${JSON.stringify(forkDetail.child.nodeId)}]') !== null`, { label: "刷新后分叉子节点", timeoutMs: 20_000 });
  await page.evaluate(`document.querySelector('[data-topic-node-id=${JSON.stringify(forkDetail.child.nodeId)}]')?.click()`);
  await page.waitFor("document.querySelector('[data-topic-session]')?.innerText.includes('UI_FORK_CHILD_MESSAGE')", { label: "刷新后子节点对话恢复", timeoutMs: 30_000 });
  assert.equal(String(await page.evaluate("document.body.innerText")).includes("BROWSER_TOPIC_REPLY"), true, `${output}`);

  // T1/T2: the user starts in DAILY CHAT and can operate the review without extracting IDs from tools.
  await page.send("Page.navigate", { url: `${baseUrl}/?session=${daily.sessionId}&projectId=friend` });
  await page.waitFor("document.querySelector('textarea') !== null", { label: "日常聊天输入" });
  await type('textarea', '帮我把这个问题建成一个主题会话');
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13 });
  try {
    await page.waitFor("document.querySelector('[data-topic-creation-open][data-creation-status=running]') !== null", { label: "日常会话里的审核入口", timeoutMs: 30_000 });
  } catch (error) {
    await screenshot('daily-failure');
    console.error(await page.evaluate("JSON.stringify({url:location.href,text:document.body.innerText})"));
    console.error(JSON.stringify(await (await fetch(`${baseUrl}/api/long-agents/friend/topics/creations`)).json()));
    throw error;
  }
  const naturalRequestId = await page.evaluate("document.querySelector('[data-topic-creation-open][data-creation-status=running]').dataset.topicCreationOpen");
  await click(`[data-topic-creation-open="${naturalRequestId}"]`);
  await page.waitFor("document.querySelector('[data-plan-review-approve]') !== null", { label: "日常创建审核", timeoutMs: 90_000 });
  const naturalRunId = await page.evaluate("document.querySelector('[data-creation-run]').dataset.creationRun");
  for (const [feedback, revision] of [['第一次修改：范围收窄到订单页', 2], ['第二次修改：补上验证步骤', 3]]) {
    await type('[data-topic-creation-review] textarea', feedback);
    await click('[data-plan-review-revise]');
    await page.waitFor(`document.querySelector('[data-topic-creation-review]')?.innerText.includes('Revision ${revision}')`, { label: `审核修订 ${revision}`, timeoutMs: 90_000 });
  }
  await screenshot('review-revision-3');
  await page.send('Page.reload');
  await page.waitFor(`document.querySelector('[data-topic-creation-open="${naturalRequestId}"]') !== null`, { label: "审核刷新后仍可找回" });
  await click(`[data-topic-creation-open="${naturalRequestId}"]`);
  await page.waitFor("document.querySelector('[data-plan-review-approve]') !== null", { label: "恢复审核卡片" });
  assert.equal(await page.evaluate("document.querySelector('[data-creation-run]').dataset.creationRun"), naturalRunId);
  assert.equal(await page.evaluate("document.querySelector('[data-topic-creation-review]').innerText.includes('Revision 3')"), true);
  // Disconnect while waiting for approval, then recover the SAME reference with GET only.
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.waitFor("document.querySelector('[data-topic-creation-review]')?.innerText.includes('Connection unavailable')", { label: "审核断线提示" });
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.waitFor("!document.querySelector('[data-topic-creation-review]')?.innerText.includes('Connection unavailable')", { label: "审核重连" });
  assert.equal(await page.evaluate("document.querySelector('[data-creation-run]').dataset.creationRun"), naturalRunId);
  await click('[data-plan-review-approve]');
  await page.waitFor("document.querySelector('[data-topic-creation-enter]') !== null", { label: "批准后进入会话", timeoutMs: 90_000 });
  const creations = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/creations?sourceSessionId=${daily.sessionId}`)).json();
  const naturalCreation = creations.creations.find(item => item.requestId === naturalRequestId);
  assert.equal(naturalCreation.node.title, '日常主题第二版修改');
  assert.equal(creations.creations.filter(item => item.requestId === naturalRequestId).length, 1);
  await click('[data-topic-creation-enter]');
  await page.waitFor("document.querySelector('[data-topic-session] textarea') !== null", { label: "从日常创建进入节点会话" });

  // T4/T7: show the answer while writer is held open, reconnect, and stop via the real shared composer.
  await type('[data-topic-session] textarea', 'UI_WAIT_REMEMBER');
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13 });
  await page.waitFor("document.querySelector('[data-round-phase=remember]') !== null && document.querySelector('[data-topic-session]').innerText.includes('BROWSER_TOPIC_REPLY')", { label: "答案先出且记忆阶段可见", timeoutMs: 90_000 });
  assert.equal(rememberWaiting, true);
  await screenshot('answer-and-memory-running');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send('Page.reload');
  await page.waitFor("document.querySelector('[data-round-phase=remember]') !== null", { label: "运行中刷新恢复记忆阶段", timeoutMs: 30_000 });
  await click('[data-topic-session] [data-chat-stop]');
  await page.waitFor("document.querySelector('[data-run-status]')?.innerText.includes('Stopped')", { label: "真实停止确认", timeoutMs: 30_000 });
  const turns = (await readLongAgentState(home)).turns.filter(turn => turn.sessionId === naturalCreation.node.sessionId);
  assert.equal(turns.length, 1, "refresh/reconnect never resubmits the message");
  assert.equal(turns[0].status, 'cancelled');
  const cancelledAnchors = await (await fetch(`${baseUrl}/api/long-agents/friend/topics/${naturalCreation.node.topicId}/nodes/${naturalCreation.node.nodeId}/anchors`)).json();
  assert.equal(cancelledAnchors.anchors.length, 0);
  await screenshot('conversation-after-stop');

  // T3: the same composer uploads an image to a capability-enabled model and persists its native block.
  const capability = await (await fetch(`${baseUrl}/api/long-agents/friend/capabilities`)).json();
  assert.equal(capability.images, true);
  const imagePath = path.join(root, 'sample.png');
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXhUAAAAASUVORK5CYII=', 'base64'));
  const { root: documentRoot } = await page.send('DOM.getDocument');
  const { nodeId: fileInput } = await page.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '[data-topic-session] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: fileInput, files: [imagePath] });
  await type('[data-topic-session] textarea', 'UI_IMAGE_MESSAGE');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13 });
  await page.waitFor("document.querySelector('[data-topic-session]')?.innerText.includes('UI_IMAGE_MESSAGE') && document.querySelector('[data-chat-stop]') === null", { label: '带图节点轮次完成', timeoutMs: 60_000 });
  assert.equal(await page.evaluate("[...document.querySelectorAll('[data-topic-session] p')].some(el => el.textContent.includes('BROWSER_TOPIC_REPLY') && el.getBoundingClientRect().height > 0)"), true, 'the work answer remains visible; memory receipt is process detail');
  assert.equal(sawImageInput, true, 'image reaches the actual model HTTP request');
  const imageHistory = await (await fetch(`${baseUrl}/api/sessions/${naturalCreation.node.sessionId}?projectId=friend`)).json();
  assert.equal(imageHistory.context.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'image')), true);

  // Cancel a separate unapproved creation in the UI and verify no target was created.
  if (await page.evaluate("document.querySelector('[data-topic-navigation-toggle]')?.getBoundingClientRect().height > 0")) await click('[data-topic-navigation-toggle]');
  await click('[data-topics-root] details > summary');
  await type('[data-topic-create-title]', '待取消主题');
  await type('[data-topic-create-purpose]', '测试取消');
  await click('[data-topic-create-submit]');
  await page.waitFor("document.querySelector('[data-plan-review-approve]') !== null", { label: "待取消审核", timeoutMs: 90_000 });
  const cancelledRun = await page.evaluate("document.querySelector('[data-creation-run]').dataset.creationRun");
  await click('[data-topic-creation-cancel]');
  await page.waitFor("document.querySelector('[data-topic-creation-review]')?.innerText.includes('Cancelled')", { label: "创建已取消" });
  const cancelledRequest = (await (await fetch(`${baseUrl}/api/long-agents/friend/topics/creations`)).json()).creations.find(item => item.runId === cancelledRun);
  assert.equal(cancelledRequest.status, 'cancelled'); assert.equal(cancelledRequest.node, null);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  // T8: representative viewports — the node session's input must stay visible and actually hit-testable,
  // and the page must not gain a horizontal scrollbar.
  for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const usable = await page.evaluate(`(() => {
      const textarea = document.querySelector('[data-topic-session] textarea');
      if (textarea === null) return 'missing';
      const rect = textarea.getBoundingClientRect();
      const inside = rect.width > 40 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
      const noHorizontalScroll = document.documentElement.scrollWidth <= window.innerWidth + 1;
      // Real keyboard focus proves the control is usable even when a mobile overlay sits over the point.
      textarea.focus();
      const focusable = document.activeElement === textarea && !textarea.disabled && !textarea.readOnly;
      return inside && focusable && noHorizontalScroll ? 'ok' : JSON.stringify({ inside, focusable, noHorizontalScroll, rect: { top: rect.top, bottom: rect.bottom, h: rect.height }, vh: window.innerHeight });
    })()`);
    assert.equal(usable, "ok", `viewport ${width}x${height}: input not usable (${usable})`);
    await screenshot(`chat-${width}`);
    await page.send("Emulation.clearDeviceMetricsOverride");
  }
  // Emulate browser zoom on a 1440×900 display: reduce the CSS layout viewport AND increase density.
  // CSS `zoom` alone leaves media queries unchanged and does not model browser zoom.
  for (const zoom of [1.5, 2]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: Math.round(1440 / zoom), height: Math.round(900 / zoom), deviceScaleFactor: zoom, mobile: false });
    await new Promise(resolve => setTimeout(resolve, 400));
    await screenshot(`chat-zoom-${zoom}`);
    const zoomState = await page.evaluate(`(() => {
      const el = document.querySelector('[data-topic-session] textarea'); const r = el.getBoundingClientRect();
      const session = document.querySelector('[data-topic-session]')?.getBoundingClientRect();
      return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), vh: innerHeight, vw: innerWidth,
        scrollY: window.scrollY, scrollH: document.documentElement.scrollHeight,
        session: session ? { top: Math.round(session.top), bottom: Math.round(session.bottom), h: Math.round(session.height) } : null });
    })()`);
    assert.equal(await page.evaluate(`(() => {
      const el = document.querySelector('[data-topic-session] textarea'); const r = el.getBoundingClientRect();
      return r.width > 40 && r.top >= 0 && r.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
    })()`), true, `zoom ${zoom}: composer must remain visible ${zoomState}`);
  }
  await page.send("Emulation.clearDeviceMetricsOverride");
  await page.close();
});
