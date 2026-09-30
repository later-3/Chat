import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendChatWorkflowStage } from "../src/workflows/workflow-stage.ts";
import { fixture } from "../test/long-agents/daily-fixture.mjs";
import { launchBrowser } from "./cdp.mjs";

/**
 * The prompt-capture switch, through the REAL browser and the REAL accepted request.
 *
 * Proves what unit tests cannot: the toggle a user flips reaches the send, the captures index
 * really gains/keeps records because of it, and the full-history Prompt panel renders the
 * recorded regions from the on-demand payload API.
 */
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");
const WORK_TEXT = "PROMPT_CAPTURE_WORK_OK";

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
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

test("the prompt-capture switch reaches the send, records regions and drives the full-history panel", { concurrency: false, timeout: 180_000 }, async (t) => {
  const cleanups = [];
  const f = await fixture({ after: (register) => cleanups.push(register) });
  const modelHandler = (body) => {
    const user = body.messages.filter((message) => message.role === "user").at(-1);
    const text = typeof user?.content === "string" ? user.content
      : (user?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return { content: `${WORK_TEXT} ${text}` };
  };
  f.setHandler(modelHandler);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const buildDir = fs.mkdtempSync(path.join(projectRoot, ".data/prompt-capture-browser-"));
  const server = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, CHAT_HOME: f.home, CHAT_NITRO_BUILD_DIR: buildDir,
      WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(f.home, "runtime", "workflow-data"),
      WORKFLOW_LOCAL_BASE_URL: baseUrl, MEM0_TELEMETRY: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  let browser;
  let page = null;
  t.after(async () => {
    await browser?.close().catch(() => undefined);
    await stopProcess(server);
    fs.rmSync(buildDir, { recursive: true, force: true });
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`dev server did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  browser = await launchBrowser();
  page = await browser.newPage(`${baseUrl}/`);
  await page.send("Network.enable");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visibleChat = "document.querySelector('[data-workspace-chat]')?.hidden === false";

  try {
    const readyDeadline = Date.now() + 60_000;
    for (;;) {
      const ok = await page.evaluate(`${visibleChat} && document.querySelector('[data-prompt-capture-toggle]') !== null && document.querySelector('[data-chat-composer]:not([disabled])') !== null`).catch(() => false);
      if (ok === true) break;
      if (Date.now() > readyDeadline) throw new Error("当前会话没有进入可输入状态");
      await pause(250);
    }

    const capturesIndex = async (sessionId) => (await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/prompt-captures?projectId=friend`)).json());

    const send = async (text, captureOn) => {
      await page.evaluate("document.querySelector('[data-chat-composer]').focus(); document.querySelector('[data-chat-composer]').select()");
      await page.send("Input.insertText", { text });
      assert.equal(await page.evaluate("document.querySelector('[data-chat-composer]').value"), text);
      for (const type of ["keyDown", "keyUp"]) {
        await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13 });
      }
      let request;
      const sendDeadline = Date.now() + 30_000;
      while (request === undefined) {
        request = page.events.find((event) => {
          if (event.method !== "Network.requestWillBeSent" || event.params.request.method !== "POST") return false;
          if (!/\/api\/long-agents\/[^/]+\/(turns|messages)$/.test(event.params.request.url)) return false;
          try { return JSON.parse(event.params.request.postData ?? "{}").text === text; } catch { return false; }
        });
        if (request === undefined) {
          assert.ok(Date.now() < sendDeadline, `没有接受发送 ${text}`);
          await pause(50);
        }
      }
      const body = JSON.parse(request.params.request.postData);
      assert.equal(body.promptCapture, captureOn ? "on" : undefined, `${text} 的真实请求开关`);
      const turnDeadline = Date.now() + 60_000;
      for (;;) {
        if (page.events.some((event) => event.method === "Network.loadingFinished" && event.params.requestId === request.params.requestId)) break;
        assert.ok(Date.now() < turnDeadline, `接受请求没有完成 ${text}`);
        await pause(50);
      }
      const response = await page.send("Network.getResponseBody", { requestId: request.params.requestId });
      const accepted = JSON.parse(response.body);
      assert.equal(typeof accepted.id, "string", JSON.stringify(accepted));
      for (;;) {
        const snapshot = await (await fetch(`${baseUrl}/api/long-agents/friend/turns/${encodeURIComponent(accepted.id)}`)).json();
        if (["completed", "failed", "cancelled"].includes(snapshot.execution?.status)) {
          assert.equal(snapshot.execution.status, "completed", text);
          break;
        }
        assert.ok(Date.now() < turnDeadline, `轮次没有终结 ${text}`);
        await pause(50);
      }
      await page.waitFor("document.querySelector('[data-chat-stop]') === null", { label: `${text} UI 已终结` });
      return accepted;
    };

    // Keep the memory tail out of scope: this test owns the prompt-capture switch only.
    await page.evaluate("document.querySelector('[data-session-memory-open]').click()");
    await page.waitFor("document.querySelector('[data-session-memory-toggle]') !== null");
    await page.evaluate("(() => { const toggle = document.querySelector('[data-session-memory-toggle]'); if (toggle.checked) toggle.click(); })()");
    await page.waitFor("document.querySelector('[data-session-memory-toggle]').checked === false");
    await page.evaluate("document.querySelector('[data-session-memory-toggle]').closest('[role=dialog]').querySelector('header button').click()");
    await page.waitFor("document.querySelector('[data-session-memory-toggle]') === null");

    const active = await page.evaluate("document.querySelector('[data-prompt-capture-toggle]').classList.contains('is-active') || document.querySelector('[data-prompt-capture-toggle]').getAttribute('aria-pressed') === 'true'");
    assert.equal(active, false, "默认关闭");

    // Off: a full round writes NOTHING.
    const offRound = await send("pc-off", false);
    const indexOff = await capturesIndex(offRound.sessionId);
    assert.equal(indexOff.count, 0, `关闭时不得写入: ${JSON.stringify(indexOff)}`);

    // On: the switch reaches the request and the captures index gains records with regions.
    await page.evaluate("document.querySelector('[data-prompt-capture-toggle]').click()");
    await page.waitFor("document.querySelector('[data-prompt-capture-toggle]').classList.contains('is-active') || document.querySelector('[data-prompt-capture-toggle]').getAttribute('aria-pressed') === 'true'",
      { label: "开关变为开启" });
    const onRound = await send("pc-on", true);
    assert.equal(onRound.sessionId, offRound.sessionId);
    const indexOn = await capturesIndex(onRound.sessionId);
    assert.ok(indexOn.count >= 1, `开启后必须有记录: ${JSON.stringify(indexOn)}`);
    const first = indexOn.records[0];
    assert.equal(first.regions.parsed, true);
    assert.ok(first.regions.systemPromptChars > 0, "系统提示必须被抓到");
    assert.ok(first.agent.agentId.length > 0, "每条记录必须带Agent身份");
    const countAfterOn = indexOn.count;

    // Refresh keeps the switch on (per-session preference).
    await page.send("Page.reload");
    await page.waitFor("document.querySelector('[data-prompt-capture-toggle]') !== null && document.querySelector('[data-chat-composer]:not([disabled])') !== null", { label: "刷新后可输入", timeoutMs: 60_000 });
    assert.equal(await page.evaluate("document.querySelector('[data-prompt-capture-toggle]').classList.contains('is-active') || document.querySelector('[data-prompt-capture-toggle]').getAttribute('aria-pressed') === 'true'"), true, "刷新保留开启状态");

    // A later native daily summary must stay outside the earlier memory Agent, in
    // both the main conversation and the standalone reader. Only seed the idle fixture.
    const detail = await (await fetch(`${baseUrl}/api/sessions/${onRound.sessionId}?projectId=friend&view=chat`)).json();
    assert.ok(path.resolve(detail.filePath).startsWith(path.resolve(f.home) + path.sep));
    const native = SessionManager.open(detail.filePath, path.dirname(detail.filePath));
    appendChatWorkflowStage(native, { invocationId: "history-fixture", workflowId: "minimal-pi-coding-agent", stageId: "remember", agentId: "session-memory-writer" });
    const appendAssistant = text => native.appendMessage({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(),
      api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    appendAssistant("MEMORY_RECEIPT_FIXTURE");
    native.appendCustomMessageEntry("chat.daily-summary.v1", "internal summary fixture", false, {date:"2026-09-29"});
    appendAssistant(JSON.stringify({did:["DAILY_ACTIVITY_FIXTURE"], reflections:[], handoff:""}));
    await page.send("Page.reload");
    await page.waitFor("document.querySelector('[data-session-activity=\"daily-summary\"]') !== null", { label: "日终维护独立展示", timeoutMs: 20_000 });

    // The full-history Prompt panel renders the recorded regions from the payload API.
    const historyButton = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(candidate =>
        /完整历史|Full history/i.test(candidate.getAttribute('aria-label') ?? '') && !candidate.disabled);
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    assert.equal(historyButton, true, "完整历史入口存在");
    await page.waitFor("document.querySelector('[data-prompt-captures-view]') !== null", { label: "完整历史对话框打开" });
    // The first successful HTML response must leave loading without a tab/theme change.
    await page.waitFor("document.querySelector('iframe.full-history-frame')?.srcdoc.includes('session-data') === true", { label: "完整历史首次响应直接显示", timeoutMs: 20_000 });
    // Check the child document, not just the existence of an empty iframe.
    let historyReady = false;
    let historyDiagnostic;
    let historySessionId;
    const historyDeadline = Date.now() + 20_000;
    while (!historyReady && Date.now() < historyDeadline) {
      const { frameTree } = await page.send("Page.getFrameTree");
      historyDiagnostic = frameTree.childFrames?.map(child => child.frame.url);
      const frame = frameTree.childFrames?.find(child => child.frame.url === "about:srcdoc")?.frame;
      let executionContextId;
      if (frame) ({ executionContextId } = await page.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "history-readiness-test" }));
      else if (!historySessionId) {
        // Chrome may isolate the sandbox in another renderer process. It is then
        // a separate CDP target, absent from the parent Page.getFrameTree.
        const { targetInfos } = await page.send("Target.getTargets");
        const target = targetInfos.find(info => info.type === "iframe" && info.url === "about:srcdoc");
        if (target) ({ sessionId: historySessionId } = await page.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
      }
      if (executionContextId || historySessionId) {
        const result = await page.send("Runtime.evaluate", { ...(executionContextId ? { contextId: executionContextId } : {}), returnByValue: true,
          expression: `(() => { const activity = document.querySelector('[data-chat-session-activity="daily-summary"]');
            return { tree:document.querySelector('#tree-container')?.children.length ?? 0,
              conversation:document.querySelector('#messages')?.textContent.includes('pc-on') ?? false,
              maintenance:activity?.textContent.includes('DAILY_ACTIVITY_FIXTURE') ?? false,
              writer:!!activity?.closest('[data-agent-id="session-memory-writer"]') }; })()` }, historySessionId);
        historyDiagnostic = result.result?.value ?? result.exceptionDetails;
        historyReady = historyDiagnostic?.tree > 0 && historyDiagnostic?.conversation === true
          && historyDiagnostic?.maintenance === true && historyDiagnostic?.writer === false;
      }
      if (!historyReady) await pause(100);
    }
    assert.equal(historyReady, true, `完整历史首帧包含实际消息和分支树：${JSON.stringify(historyDiagnostic)}`);
    if (historySessionId) await page.send("Target.detachFromTarget", { sessionId: historySessionId });
    await page.evaluate("document.querySelector('[data-prompt-captures-view]').click()");
    await page.waitFor("document.querySelector('[data-prompt-captures-panel]') !== null", { label: "Prompt 请求面板渲染" });
    await page.waitFor(`document.querySelectorAll('[data-prompt-capture-record]').length >= ${countAfterOn}`, { label: "面板列出全部记录" });
    // Expanding one record loads its payload on demand and shows the region blocks.
    await page.evaluate("document.querySelector('[data-prompt-capture-row-toggle]').click()");
    await page.waitFor("document.querySelector('[data-prompt-capture-system]') !== null", { label: "区域负载按需加载并渲染系统提示" });
    const panelText = await page.evaluate("document.querySelector('[data-prompt-captures-panel]').innerText");
    // The capture is the REQUEST, so it holds this turn's user message and the injected instruction,
    // plus the system prompt; the assistant answer only appears as history in the NEXT request.
    assert.ok(panelText.includes("pc-on"), `面板展示记录的请求内容: ${panelText.slice(0, 400)}`);
    assert.ok(panelText.toLowerCase().includes("system prompt"), `面板展示系统提示区域: ${panelText.slice(0, 400)}`);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
});
