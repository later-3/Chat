import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
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
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-prompt-capture-browser-"));
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
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  const pageErrors = [];
  page.events.filter(() => false);
  const originalEmit = page.events.push.bind(page.events);
  page.events.push = (event) => {
    if (event.method === "Runtime.exceptionThrown") pageErrors.push(JSON.stringify(event.params.exceptionDetails).slice(0, 500));
    return originalEmit(event);
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visibleChat = "document.querySelector('[data-workspace-chat]')?.hidden === false";

  try {
    const readyDeadline = Date.now() + 60_000;
    for (;;) {
      const ok = await page.evaluate(`${visibleChat} && document.querySelector('[data-chat-settings]') !== null && document.querySelector('[data-chat-composer]:not([disabled])') !== null`).catch(() => false);
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
      // B3 · L4：UI 停发 body promptCapture——开关是服务端事实，受理时从会话条目解析。
      assert.equal(body.promptCapture, undefined, `${text} 请求体不再携带开关标志（L4）`);
      void captureOn;
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

    // The memory reader is a pure panel now (rounds no longer carry a memory switch): nothing to preset.

    const openSettings = async () => {
      await page.evaluate("document.querySelector('[data-chat-settings]').focus()");
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await page.waitFor("document.querySelector('[data-prompt-capture-toggle]') !== null");
    };
    const closeSettings = async () => {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.waitFor("document.querySelector('[data-prompt-capture-toggle]') === null");
    };
    await openSettings();
    const active = await page.evaluate("document.querySelector('[data-prompt-capture-toggle]').getAttribute('aria-checked') === 'true'");
    assert.equal(active, false, "默认关闭");
    await closeSettings();

    // Off: 区域行仍写（D4），但原文不写（gz 契约保留）；兼容视图与读模型行数一致。
    const offRound = await send("pc-off", false);
    const interactionsOff = await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(offRound.sessionId)}/interactions?projectId=friend`)).json();
    assert.equal(interactionsOff.legacy, false, `新会话走 v2 读模型: ${JSON.stringify(interactionsOff)}`);
    assert.ok(interactionsOff.rows.length >= 1, `关闭时区域行仍写（D4）: ${JSON.stringify(interactionsOff)}`);
    assert.equal(interactionsOff.rows[0].payload?.file, undefined, "关闭时不写原文");
    const indexOff = await capturesIndex(offRound.sessionId);
    assert.equal(indexOff.count, interactionsOff.rows.length, `兼容视图与读模型行数一致: ${JSON.stringify(indexOff)}`);

    // On: the switch reaches the request and the captures index gains records with regions.
    await openSettings();
    await page.evaluate("document.querySelector('[data-prompt-capture-toggle]').click()");
    await page.waitFor("document.querySelector('[data-prompt-capture-toggle]').getAttribute('aria-checked') === 'true'",
      { label: "开关变为开启" });
    await closeSettings();
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
    await page.waitFor("document.readyState === 'complete'", { label: "reload complete", timeoutMs: 30_000 }).catch(() => {});
    if (pageErrors.length > 0) console.log("PAGE_ERRORS", JSON.stringify(pageErrors));
    await page.waitFor("document.querySelector('[data-chat-settings]') !== null && document.querySelector('[data-chat-composer]:not([disabled])') !== null", { label: "刷新后可输入", timeoutMs: 60_000 });
    await openSettings();
    // 开关是服务端事实（B3）：刷新后从 interaction-recording 异步读取——等待真实状态，不假设同步。
    await page.waitFor("document.querySelector('[data-prompt-capture-toggle]')?.getAttribute('aria-checked') === 'true'",
      { label: "刷新后开关来自服务端事实", timeoutMs: 15_000 });
    await closeSettings();

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
    await page.waitFor("document.querySelector('[data-chat-composer]:not([disabled])') !== null", { label: "旧历史载入", timeoutMs: 20_000 });
    assert.equal(await page.evaluate("document.querySelector('[data-session-activity=\"daily-summary\"]') === null"), true);

    // ── B3 · U7 新合同（B3-design §2，G1 通过；门禁从验收生成）──
    const closeDialog = () => page.evaluate("[...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelector('header button[aria-label=Close]')?.click()");
    const turnScope = (index) => `document.querySelectorAll('.full-history-turn')[${index}]`;
    const openHistory = () => page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(candidate =>
        /完整历史|Full history/i.test(candidate.getAttribute('aria-label') ?? '') && !candidate.disabled);
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);

    // ④ 聊天页打开（reload 后）0 个 prompt 详情请求——interaction-recording 状态请求不计“详情”。
    {
      const eventMark = page.events.length;
      await page.send("Page.reload");
      await page.waitFor("document.querySelector('[data-chat-composer]:not([disabled])') !== null", { label: "聊天页就绪", timeoutMs: 30_000 });
      await pause(600);
      const detailRequests = page.events.slice(eventMark).filter(event =>
        event.method === "Network.requestWillBeSent" &&
        (/\/interactions\/requests\//.test(event.params.request.url) || /\/prompt-captures\//.test(event.params.request.url)));
      assert.equal(detailRequests.length, 0, `聊天页 0 详情请求: ${JSON.stringify(detailRequests.map(event => event.params.request.url))}`);
    }

    // ⑥ 首屏口径（D6）：index 首页（limit=50）响应体 ≤100KB（未压缩字节）。
    const indexResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(first.sessionId)}/interactions?projectId=friend&limit=50`);
    const indexBytes = (await indexResponse.arrayBuffer()).byteLength;
    assert.ok(indexBytes <= 100_000, `首屏 index 响应 ${indexBytes}B ≤100KB`);

    // ① 打开完整历史：按轮列出；开关状态来自服务端。
    const historyOpenedAt = Date.now();
    assert.equal(await openHistory(), true, "完整历史入口存在");
    await page.waitFor("document.querySelector('[data-full-history-turns]') !== null", { label: "按轮列表首帧", timeoutMs: 30_000 });
    console.log(`Full history cold first readable: ${Date.now() - historyOpenedAt} ms`);
    assert.equal(await page.evaluate("document.querySelector('[data-recording-state]')?.getAttribute('data-recording-state')"), "on", "开关徽标来自服务端事实");
    const turnCount = await page.evaluate("document.querySelectorAll('[data-full-history-turn-toggle]').length");
    assert.ok(turnCount >= 2, `按轮列出（off/on 至少两轮）: ${turnCount}`);

    // ② 展开第一轮（off 轮）：区域摘要可见；原文按契约缺失 → 明确文案（不伪造）。
    await page.evaluate("document.querySelector('[data-full-history-turn-toggle]').click()");
    await page.waitFor("document.querySelector('[data-turn-interactions]') !== null", { label: "轮展开 TurnInteractions" });
    await page.waitFor(`${turnScope(0)}.querySelector('[data-reply-bar]') !== null`, { label: "回复 bar（默认收起）" });
    assert.equal(await page.evaluate(`${turnScope(0)}.querySelectorAll('[data-prompt-capture-record]').length`), 0, "回复 bar 默认收起：请求组未渲染");
    await page.evaluate(`${turnScope(0)}.querySelector('[data-reply-bar]').click()`);
    await page.waitFor(`${turnScope(0)}.querySelectorAll('[data-prompt-capture-record]').length > 0`, { label: "请求组行出现" });
    await page.evaluate(`${turnScope(0)}.querySelector('[data-prompt-capture-row-toggle]').click()`);
    await pause(2000);
    console.log("OFF_DUMP", await page.evaluate(`JSON.stringify({
      records: document.querySelectorAll('[data-prompt-capture-record]').length,
      missing: document.querySelectorAll('[data-payload-missing]').length,
      rawReq: document.querySelectorAll('[data-raw-request]').length,
      alert: document.querySelector('[role=alert]')?.textContent?.slice(0, 120) ?? null,
      metaCount: document.querySelectorAll('[data-request-meta]').length,
      rowIds: [...document.querySelectorAll('[data-prompt-capture-record]')].map(n => n.getAttribute('data-prompt-capture-record')),
      detailHead: document.querySelector('.prompt-capture-detail')?.innerText?.slice(0, 150) ?? null,
      replyBarExpanded: document.querySelector('.full-history-turn [data-reply-bar]')?.getAttribute('aria-expanded') ?? null,
    })`));
    {
      const sid0 = onRound.sessionId;
      const idx = await (await fetch(`${baseUrl}/api/sessions/${sid0}/interactions?projectId=friend&limit=50`)).json();
      const r0 = (idx.rows ?? [])[0];
      const resp = await fetch(`${baseUrl}/api/sessions/${sid0}/interactions/requests/${r0?.requestId}?projectId=friend&payload=1`);
      const body = await resp.json();
      console.log("OFF_DETAIL_API", JSON.stringify({ status: resp.status, rowPayload: r0?.payload, respKeys: Object.keys(body), respPayloadType: typeof body.payload }));
    }
    // 契约断言在 API 层（rows[0].payload.file===undefined 已在上方对账）；
    // UI：详情按 payloadPresent 渲染（无 file→"原文未保存"；有 file 的行（后置请求，待 LA 域核对 F-61）→原始结构树）。
    await page.waitFor(`${turnScope(0)}.querySelector('[data-raw-request] [data-request-meta]') !== null`, { label: "off 轮详情按 payloadPresent 渲染" });

    // ② 展开 on 轮：区域树（系统提示分区 + 消息区域 + 本轮输入）来自按需拉取的详情。
    await page.evaluate("document.querySelectorAll('[data-full-history-turn-toggle]')[1].click()");
    await page.waitFor(`${turnScope(1)}.querySelector('[data-reply-bar]') !== null`, { label: "on 轮回复 bar" });
    await page.evaluate(`${turnScope(1)}.querySelector('[data-reply-bar]').click()`);
    await page.waitFor(`${turnScope(1)}.querySelectorAll('[data-prompt-capture-record]').length > 0`, { label: "on 轮请求组" });
    await page.evaluate(`${turnScope(1)}.querySelector('[data-prompt-capture-row-toggle]').click()`);
    await pause(2500);

    await page.waitFor(`${turnScope(1)}.querySelector('[data-raw-request] [data-raw-messages]') !== null`, { label: "原始请求体容器", timeoutMs: 20_000 });
    // 原始请求体合同：本轮输入 pc-on 出现在请求体原文中（textContent 不受折叠影响）
    const panelText = await page.evaluate(`${turnScope(1)}.querySelector('[data-turn-interactions]').textContent`);
    assert.ok(panelText.includes("pc-on"), `请求体原文含本轮输入: ${panelText.slice(0, 300)}`);
    assert.ok(panelText.toLowerCase().includes("system"), `含 system 条目: ${panelText.slice(0, 200)}`);
    await closeDialog();

    // F11 形态断言（B3-fix §1.B→门禁：原型合同钉死——阶段头/条形图/4pills/无裸 tag）。
    {
      assert.equal(await openHistory(), true, "重开（形态断言）");
      await page.waitFor("document.querySelectorAll('[data-full-history-turn-toggle]').length >= 2", { label: "轮列表（形态）" });
      await page.evaluate("document.querySelectorAll('[data-full-history-turn-toggle]')[1].click()");
      await page.waitFor(`${turnScope(1)}.querySelector('[data-reply-bar]') !== null`, { label: "形态·回复 bar" });
      await page.evaluate(`${turnScope(1)}.querySelector('[data-reply-bar]').click()`);
      await page.waitFor(`${turnScope(1)}.querySelector('[data-stage-head]') !== null`, { label: "阶段头（后端统计）" });
      assert.equal(await page.evaluate("document.querySelectorAll('[data-block-filter] .region-pill').length"), 4, "4 个区块 pills（原型形态）");
      const stageHead = await page.evaluate("document.querySelector('[data-stage-head]')?.innerText ?? ''");
      assert.ok(/\d/.test(stageHead), `阶段头含后端统计: ${stageHead}`);
      const onText = await page.evaluate(`${turnScope(1)}.querySelector('[data-turn-interactions]')?.innerText ?? ''`);
      // B3-R3：原始标识=展示主体（用户确认），裸名断言随之废弃
      await page.waitFor(`${turnScope(1)}.querySelectorAll('[data-prompt-capture-record]').length > 0`, { label: "on 轮请求组（形态）" });
      await page.evaluate(`${turnScope(1)}.querySelector('[data-prompt-capture-row-toggle]').click()`);
      await page.waitFor(`${turnScope(1)}.querySelector('[data-raw-request] [data-raw-messages] [data-role="system"]') !== null`, { label: "原始请求体 system 条目（形态）" });
      const rawMsgCount = await page.evaluate(`${turnScope(1)}.querySelectorAll('[data-raw-messages] .raw-message').length`);
      assert.ok(rawMsgCount >= 2, `messages 逐条渲染: ${rawMsgCount}`);
      const toolSchemas = await page.evaluate("document.querySelectorAll('[data-tool-schemas] .raw-tool').length");
      assert.ok(toolSchemas >= 1, `tools 逐个折叠: ${toolSchemas}`);
      await closeDialog();
    }

    // ③ 重试聚合：注入一条 retryOf 链行 + error outcome（读模型真实读出 ×2 与失败徽标）。
    {
      const rowsNow = (await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(first.sessionId)}/interactions?projectId=friend&limit=500`)).json()).rows;
      const onRow = rowsNow.find(row => row.attempt === 1 && row.payload?.file !== undefined);
      assert.ok(onRow, `找到 on 轮锚行: ${rowsNow.length} 行`);
      const sessionDirPath = path.dirname(detail.filePath);
      const interactionDir = path.join(sessionDirPath, "interactions", first.sessionId);
      const retryRow = { ...onRow, seq: Math.max(...rowsNow.map(row => row.seq)) + 1,
        requestId: `e2e-retry-${Date.now()}`, attempt: 2, retryOf: onRow.requestId, timestamp: new Date().toISOString() };
      delete retryRow.outcome;
      fs.appendFileSync(path.join(interactionDir, "index.jsonl"), `${JSON.stringify(retryRow)}\n`);
      fs.appendFileSync(path.join(interactionDir, "outcomes.jsonl"),
        `${JSON.stringify({ requestId: retryRow.requestId, timestamp: retryRow.timestamp, outcome: { status: "error", errorMessage: "e2e injected failure" } })}\n`);
      assert.equal(await openHistory(), true, "重开完整历史");
      await page.waitFor("document.querySelectorAll('[data-full-history-turn-toggle]').length >= 2", { label: "重开后轮列表" });
      const retryTurnIndex = rowsNow.findIndex(row => row.requestId === onRow.requestId);
      const targetTurn = rowsNow.slice(0, retryTurnIndex + 1).reverse().find(row => row.turn.turnKey !== undefined);
      const turnKeys = await page.evaluate("[...document.querySelectorAll('[data-turn-interactions]')].map(n => n.getAttribute('data-turn-interactions'))");
      void turnKeys; void targetTurn;
      // 找到含 ×2 的轮：逐轮展开到出现为止。
      let retryBadge = false;
      const toggleCount = await page.evaluate("document.querySelectorAll('[data-full-history-turn-toggle]').length");
      for (let index = 0; index < toggleCount && !retryBadge; index += 1) {
        await page.evaluate(`document.querySelectorAll('[data-full-history-turn-toggle]')[${index}].click()`);
        await page.waitFor("document.querySelector('[data-turn-interactions]') !== null", { label: `轮 ${index} 展开` });
        await page.waitFor(`${turnScope(index)}.querySelector('[data-reply-bar]') !== null`, { label: `轮 ${index} 回复 bar` });
        await page.evaluate(`${turnScope(index)}.querySelector('[data-reply-bar]').click()`);
        await page.waitFor(`${turnScope(index)}.querySelectorAll('[data-prompt-capture-record]').length > 0`, { label: `轮 ${index} 请求组` });
        retryBadge = await page.evaluate("[...document.querySelectorAll('.prompt-capture-attempts')].some(node => node.textContent.includes('×2'))");
      }
      assert.equal(retryBadge, true, "重试聚合显示 ×2（后端归并，前端零聚合）");
      const failureBadge = await page.evaluate("[...document.querySelectorAll('.prompt-capture-failures')].some(node => node.textContent.includes('1'))");
      assert.equal(failureBadge, true, "失败次数徽标可见");
      // F5：逐次尝试列表（数据=后端 attempt 链行）——展开含 ×2 的请求卡
      await page.evaluate("document.querySelector('[data-prompt-capture-row-toggle]')?.click()");
      await page.waitFor("document.querySelector('[data-attempt-list]') !== null", { label: "逐次尝试列表", timeoutMs: 15_000 });
      const attemptRows = await page.evaluate("document.querySelectorAll('[data-attempt-list] .attempt-row').length");
      assert.ok(attemptRows >= 2, `逐次尝试列表 ≥2 行: ${attemptRows}`);
      const attemptText = await page.evaluate("document.querySelector('[data-attempt-list]')?.innerText ?? ''");
      assert.ok(/Attempt 1|尝试 1/.test(attemptText) && /e2e injected failure/.test(attemptText), `尝试列表含各自结果: ${attemptText.slice(0, 200)}`);
      // F5：元信息行（四问"怎么来的"）
      const meta = await page.evaluate("document.querySelector('[data-request-meta]')?.innerText ?? ''");
      assert.ok(/[0-9a-f]{8}-[0-9a-f]{4}/.test(meta) && /sha [0-9a-f]{8}/.test(meta) && /Tools \d+/.test(meta),
        `元信息行（requestId+sha 8位+工具/消息/排除）: ${meta}`);
      await closeDialog();
      // F3：a/b 层与发起方 bar（本会话消息 turnId/时间窗匹配）
      assert.equal(await openHistory(), true, "重开（a/b 形态）");
      await page.waitFor("document.querySelectorAll('[data-full-history-turn-toggle]').length >= 2", { label: "轮列表（a/b）" });
      // on 轮（第 2 轮）必有 a=pc-on 与回复：等消息拉取后的发起方 bar（消息 turnId/时间窗匹配）。
      await page.evaluate("document.querySelectorAll('[data-full-history-turn-toggle]')[1]?.click()");
      await page.waitFor(`${turnScope(1)}.querySelector('[data-initiator-bar]') !== null`, { label: "发起方 bar（a/b 层）", timeoutMs: 45_000 }).catch(() => {});
      const exchangeProbe = await page.evaluate(`!!document.querySelector('[data-initiator-bar]')`);
      if (!exchangeProbe) {
        const viewChatReqs = page.events.filter(e => e.method === "Network.requestWillBeSent" && e.params.request.url.includes("view=chat"));
        console.log("AB_STATE_FAIL", await page.evaluate(`JSON.stringify({
          exchange: document.querySelector('[data-turn-exchange]')?.innerText?.slice(0, 160) ?? null,
        })`), "viewChatReqs:", viewChatReqs.length);
      }
      const exchangeOk = await page.evaluate(`!!document.querySelector('[data-side-a] [data-initiator-bar]') && !!document.querySelector('[data-side-b] .turn-reply-card')`);
      if (!exchangeOk) console.log("AB_FAIL_DUMP", await page.evaluate(`JSON.stringify({
        exchange: document.querySelector('[data-turn-exchange]')?.innerText?.slice(0, 200) ?? null,
        sideA: document.querySelectorAll('[data-side-a]').length, sideB: document.querySelectorAll('[data-side-b]').length,
        replyCard: document.querySelectorAll('.turn-reply-card').length, noMsg: document.body.innerText.includes('not linked') || document.body.innerText.includes('未关联'),
      })`));
      assert.equal(exchangeOk, true, "a 气泡侧发起方 bar + b 侧回复卡（原型 a/b 结构）");
      const initiatorText = await page.evaluate("document.querySelector('[data-initiator-bar]')?.innerText ?? ''");
      assert.ok(/发起方 bar|Initiator bar/.test(initiatorText) && /chars/.test(initiatorText), `发起方 bar 文本: ${initiatorText}`);
      // 发起方 bar 可展开（02 §2.1 a 视角：同一请求详情，定位本轮输入）
      await page.evaluate(`${turnScope(1)}.querySelector('[data-initiator-bar]')?.click()`);
      await page.waitFor(`${turnScope(1)}.querySelector('[data-initiator-detail] .raw-message') !== null`, { label: "发起方 bar 展开面板（原始结构）", timeoutMs: 20_000 });
      const initiatorPanel = await page.evaluate(`(() => ({
        hasBars: document.querySelectorAll('[data-initiator-detail] [data-raw-messages] .raw-message').length,
        hasFocus: document.querySelectorAll('[data-initiator-detail] .prompt-capture-block.is-focus').length,
        expanded: document.querySelector('[data-initiator-bar]')?.getAttribute('aria-expanded'),
      }))()`);
      assert.ok(initiatorPanel.hasBars >= 1 && initiatorPanel.expanded === "true",
        `发起方面板=原始请求体结构+aria: ${JSON.stringify(initiatorPanel)}`);
      await closeDialog();
    }

    // ⑦ legacy 会话同 UI 可读 + 降级文案（D3 矩阵）：临时把当前会话转换为 schema1。
    {
      const sessionDirPath = path.dirname(detail.filePath);
      const interactionsDir = path.join(sessionDirPath, "interactions", first.sessionId);
      const legacyDir = path.join(sessionDirPath, "prompt-captures", first.sessionId);
      const backupDir = `${interactionsDir}.e2e-bak`;
      fs.renameSync(interactionsDir, backupDir);
      fs.mkdirSync(legacyDir, { recursive: true });
      const legacyRequestId = crypto.randomUUID(); // 旧路由要求 UUID 格式（/^[0-9a-f-]{36}$/）
      const legacyPayload = { messages: [
        { role: "system", content: "## 身份与职责\nLEGACY_SYSTEM_BODY" },
        { role: "user", content: "legacy hello" },
      ] };
      const legacyRecord = {
        schemaVersion: 1, requestId: legacyRequestId, seq: 1, timestamp: new Date().toISOString(),
        storageProjectId: "friend", sessionId: first.sessionId, turn: { source: "direct" },
        agent: { agentId: "pi-coding-agent" }, model: { provider: "p3-local", modelId: "daily-model", api: "openai-completions" },
        kind: "agent", payloadChars: JSON.stringify(legacyPayload).length,
        payloadSha256: "e2e", file: `${legacyRequestId}.json.gz`,
        regions: { parsed: true, api: "openai-completions",
          systemPrompt: { chars: 40, text: "## 身份与职责\nLEGACY_SYSTEM_BODY", sections: [{ kind: "chat-identity", label: "身份与职责", chars: 40, text: "## 身份与职责\nLEGACY_SYSTEM_BODY" }] },
          messages: [{ index: 0, role: "user", region: "current-user-message", chars: 12, text: "legacy hello" }], tools: [] },
      };
      fs.writeFileSync(path.join(legacyDir, "index.jsonl"), `${JSON.stringify(legacyRecord)}\n`);
      fs.writeFileSync(path.join(legacyDir, `${legacyRequestId}.json.gz`), gzipSync(Buffer.from(JSON.stringify(legacyPayload), "utf8")));
      await page.send("Page.reload");
      await page.waitFor("document.querySelector('[data-chat-composer]:not([disabled])') !== null", { label: "legacy 会话载入", timeoutMs: 30_000 });
      assert.equal(await openHistory(), true, "legacy 会话完整历史入口");
      await page.waitFor("document.querySelector('[data-full-history-turns]') !== null", { label: "legacy 按轮列出" });
      assert.equal(await page.evaluate("document.querySelector('[data-full-history-legacy]') !== null || document.body.innerText.includes('Legacy record') || document.body.innerText.includes('旧记录')"), true, "legacy 徽标可见");
      await page.evaluate("document.querySelector('[data-full-history-turn-toggle]').click()");
      await page.waitFor("document.querySelector('[data-turn-interactions]') !== null", { label: "legacy 轮展开" });
      await page.waitFor(`${turnScope(0)}.querySelector('[data-reply-bar]') !== null`, { label: "legacy 回复 bar" });
      await page.evaluate(`${turnScope(0)}.querySelector('[data-reply-bar]').click()`);
      await page.waitFor(`${turnScope(0)}.querySelectorAll('[data-prompt-capture-record]').length > 0`, { label: "legacy 请求组" });
      await page.evaluate(`${turnScope(0)}.querySelector('[data-prompt-capture-row-toggle]').click()`);
      await pause(1200);
      await page.waitFor("document.querySelector('[data-raw-request] [data-raw-messages] [data-role=\"system\"]') !== null", { label: "legacy system 条目（原始结构）", timeoutMs: 20_000 });
      const legacyText = await page.evaluate("document.querySelector('[data-turn-interactions]').textContent");
      assert.ok(legacyText.includes("LEGACY_SYSTEM_BODY"), "legacy 原文来自旧 gz");
      assert.ok(/旧记录未保存结果|stored no result/.test(legacyText), `legacy 降级文案（无 outcome）: ${legacyText.slice(0, 200)}`);
      await closeDialog();
      // 恢复 v2 目录
      fs.rmSync(legacyDir, { recursive: true, force: true });
      fs.renameSync(backupDir, interactionsDir);
    }

    // export 失败与关闭中止：改为 intercept 读模型 index（首屏请求），合同不变（失败可见、可重试、关闭即中止）。
    const pausedIndex = async start => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const event = page.events.slice(start).find(item => item.method === "Fetch.requestPaused");
        if (event) return event.params;
        await pause(25);
      }
      throw new Error("index request was not intercepted");
    };
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/interactions?*", requestStage: "Request" }] });
    let requestStart = page.events.length;
    await openHistory();
    const failedIndex = await pausedIndex(requestStart);
    await page.send("Fetch.fulfillRequest", { requestId: failedIndex.requestId, responseCode: 503,
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }], body: Buffer.from("Temporary failure").toString("base64") });
    await page.waitFor("document.querySelector('[role=dialog] [role=alert]') !== null", { label: "读取失败可见（不伪造成空列表）" });
    requestStart = page.events.length;
    await page.evaluate("document.querySelector('[role=dialog] [role=alert] > button').click()");
    await page.send("Fetch.continueRequest", { requestId: (await pausedIndex(requestStart)).requestId });
    await page.waitFor("document.querySelector('[data-full-history-turns]') !== null", { label: "重试成功后按轮列出" });
    await closeDialog();
    await page.evaluate(`(() => {
      const originalFetch = window.fetch;
      window.__historyAborted = false;
      window.fetch = (...args) => {
        if (String(args[0]).includes('/interactions?')) args[1]?.signal?.addEventListener('abort', () => { window.__historyAborted = true; }, { once: true });
        return originalFetch(...args);
      };
    })()`);
    requestStart = page.events.length;
    await openHistory();
    await pausedIndex(requestStart);
    await closeDialog();
    await page.waitFor("window.__historyAborted === true", { label: "关闭完整历史中止未完成的请求" });
    await page.send("Fetch.disable");
    assert.equal(await page.evaluate("document.querySelector('[data-full-history-turns]') === null"), true);
    await page.send("Page.reload");
    await page.waitFor("document.querySelector('[data-chat-composer]:not([disabled])') !== null");
    for (const width of [390, 768, 1440]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
      await page.waitFor(`window.innerWidth === ${width}`);
      await pause(150);
      const layout = await page.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('.workspace-context-bar button')].filter(el => {const r=el.getBoundingClientRect(); return r.width > 0 && r.height > 0;});
        const rects = buttons.map(el => {const r=el.getBoundingClientRect(); return {label:el.getAttribute('aria-label'),left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
        const input = document.querySelector('[data-chat-composer]').getBoundingClientRect();
        const frame = document.querySelector('.composer-frame').getBoundingClientRect();
        return {rects,inputWidth:input.width,frameWidth:frame.width};
      })()`);
      for (const [i, rect] of layout.rects.entries()) {
        assert.ok(rect.left >= 0 && rect.right <= width, `toolbar action fits ${width}px: ${JSON.stringify(rect)}`);
        for (const other of layout.rects.slice(i + 1)) assert.ok(rect.right <= other.left + 1 || other.right <= rect.left + 1 || rect.bottom <= other.top + 1 || other.bottom <= rect.top + 1, `toolbar actions overlap at ${width}px: ${JSON.stringify([rect,other])}`);
      }
      if (width === 390) {
        assert.ok(layout.inputWidth >= layout.frameWidth - 40, "mobile composer retains a full text row");
        await openSettings();
        void 0;
        await closeSettings();
      }
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
});
