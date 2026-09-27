import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture } from "../test/long-agents/daily-fixture.mjs";
import { launchBrowser } from "./cdp.mjs";
import { ensureAgentHomeProject } from "../src/projects/registry.ts";
import { readLongAgentRegistry, writeLongAgentRegistry, updateLongAgentState } from "../src/long-agents/storage.ts";
import { ensureProjectLongAgent } from "../src/long-agents/project-agent.ts";
import { MemoryRepository } from "../src/memory/repository.ts";
import { openChatSession } from "../src/chat-session.ts";
import { publishLongAgentPost } from "../src/long-agents/social.ts";

/**
 * The session-memory switch, through the REAL browser and the REAL accepted request.
 *
 * It proves what the unit tests cannot: the switch a user flips actually reaches the send, and the
 * memory node really does / does not run because of it. It also proves a failed memory round is visible
 * to the user after a refresh.
 */
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");
const WRITER_MARK = "你只负责维护";
const WORK_TEXT = "SWITCH_WORK_OK";

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

const isWriter = (body) => body.messages.some((message) => message.role === "system"
  && (typeof message.content === "string" ? message.content : JSON.stringify(message.content)).includes(WRITER_MARK));

test("the session-memory switch reaches the real send and really gates the memory node", { concurrency: false }, async (t) => {
  const cleanups = [];
  const f = await fixture({ after: (register) => cleanups.push(register) });
  // A second contact exercises an actual keyed chat switch, not a hidden/revealed same Session.
  await ensureAgentHomeProject("other", "Other", f.home);
  const registry = await readLongAgentRegistry(f.home);
  const template = registry.agents[0];
  const historicalDate = new Date(Date.now() - 2 * 86_400_000);
  const historical = await ensureProjectLongAgent({ chatHome: f.home, projectId: "friend", agent: template, now: historicalDate });
  const historySession = await openChatSession({ chatHome: f.home, projectId: "friend", sessionId: historical.day.sessionId });
  historySession.manager.appendMessage({ role: "user", content: "CALENDAR_HISTORY_CONTENT", timestamp: historicalDate.getTime() });
  historySession.manager.flush();
  const secondHistory = await openChatSession({ chatHome: f.home, projectId: "friend" });
  secondHistory.manager.appendSessionInfo("Separate activity");
  secondHistory.manager.appendMessage({ role: "user", content: "CALENDAR_SECOND_ACTIVITY", timestamp: historicalDate.getTime() });
  secondHistory.manager.flush();
  const emptyHistory = await ensureProjectLongAgent({ chatHome: f.home, projectId: "friend", agent: template,
    now: new Date(Date.now() - 86_400_000) });
  // Two durable historical work records share a task title but have distinct Sessions/dates.
  // No executions are launched while constructing this historical navigation fixture.
  const calendarJobs = [];
  for (const [index, day] of [historical.day, emptyHistory.day].entries()) {
    const job = await openChatSession({ chatHome: f.home, projectId: "friend" });
    job.manager.appendSessionInfo("task-repeated-calendar-job");
    job.manager.appendMessage({ role: "user", content: `CALENDAR_JOB_${index}`, timestamp: Date.parse(`${day.date}T00:00:00Z`) });
    job.manager.flush();
    calendarJobs.push({ id: `work-${String(index + 1).repeat(32)}`, longAgentId: "friend", sessionId: job.manager.getSessionId(),
      originSessionId: day.sessionId, originEntryId: null, contextProjectId: null, requestId: `calendar-job-${index}`,
      payloadHash: "a".repeat(64), title: "task-repeated-calendar-job", createdAt: `${day.date}T00:00:00Z` });
  }
  await updateLongAgentState(f.home, state => ({ state: { ...state, works: [...state.works, ...calendarJobs] }, result: undefined }));
  await publishLongAgentPost({chatHome:f.home,longAgentId:'friend',text:'CALENDAR_SOCIAL_HISTORY_REMAINS'});
  const personal = new MemoryRepository(path.join(f.home, "memory/personal/catalog.db"));
  personal.create({ text: "PERSONAL_MEMORY_REMAINS", kind: "fact", scope: "personal" }); personal.close();
  await writeLongAgentRegistry({ ...registry, agents: [...registry.agents.map(agent => ({...agent, definition:{...agent.definition,tools:{...agent.definition.tools,addresses:["system:tool/friend_work"]}}})), {
    ...template, id: "other", name: "Other", defaultProjectId: "other", nanoclawAgentGroupId: "other-group",
    definition: { ...template.definition, id: "other", name: "Other" },
  }] }, f.home);
  let writerFails = false;
  let forceCompaction = false;
  const writerCalls = [];
  const modelHandler = (body) => {
    if (body.messages.some(message => message.role === "system"
      && JSON.stringify(message.content).includes("You are a context summarization assistant"))) {
      return { content: "BROWSER_NATIVE_COMPACTION: earlier work preserved in native history." };
    }
    if (isWriter(body)) {
      writerCalls.push(body);
      if (writerFails) return { error: "switch-test memory provider failed" };
      if (body.messages.at(-1)?.role === "tool") return { content: "本轮无需写入" };
      return { tool_calls: [{ index: 0, id: "switch-smem", type: "function", function: { name: "session_memory",
        arguments: JSON.stringify({ operation: "write", purpose: "finding", author: "agent", content: "SWITCH_MEMORY_ENTRY", expectedRevision: 0 }) } }] };
    }
    const user = body.messages.filter((message) => message.role === "user").at(-1);
    const text = typeof user?.content === "string" ? user.content
      : (user?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (text.includes('switch-arrange-background') && body.messages.at(-1)?.role !== 'tool') {
      assert.ok(body.tools.some(tool => tool.function.name === 'friend_work'), 'shared assembly exposes the real background task tool');
      return {tool_calls:[{index:0,id:'browser-background-create',type:'function',function:{name:'friend_work',arguments:JSON.stringify({operation:'start',title:'BROWSER_CHAT_TASK',text:'BROWSER_DELEGATED_WORK'})}}]};
    }
    const response = { content: `${WORK_TEXT} ${text.match(/switch-[a-z-]+/)?.[0] ?? text}` };
    if (forceCompaction) {
      forceCompaction = false;
      response.usage = { prompt_tokens: 127000, completion_tokens: 10, total_tokens: 127010 };
    }
    return response;
  };
  f.setHandler(modelHandler);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const buildDir = fs.mkdtempSync(path.join(projectRoot, ".data/switch-browser-"));
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
  const page = await browser.newPage(`${baseUrl}/`);
  await page.send("Network.enable");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visibleChat = "document.querySelector('[data-workspace-chat]')?.hidden === false";
  const ready = async () => {
    await page.waitFor(`${visibleChat} && document.querySelector('[data-session-memory-open]') !== null && document.querySelector('[data-chat-composer]:not([disabled])') !== null`,
      { label: "当前会话可见且可输入", timeoutMs: 60_000 });
  };
  const screenshot = async (name) => {
    const evidenceDir = process.env.CHAT_UI_EVIDENCE_DIR
      ?? (name === "native-compaction-feedback" ? path.join(projectRoot, ".data/verification/pi-capabilities") : undefined);
    if (!evidenceDir) return;
    fs.mkdirSync(evidenceDir, { recursive: true });
    // Theme colors transition for 120–200ms; retain the settled UI, not an intermediate frame.
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 300))");
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(evidenceDir, `${name}.png`), Buffer.from(data, "base64"));
  };
  const memorySetting = async (enabled) => {
    await page.evaluate("document.querySelector('[data-session-memory-open]').click()");
    await page.waitFor("document.querySelector('[data-session-memory-toggle]') !== null");
    if (enabled !== undefined) {
      await page.evaluate(`(() => { const toggle = document.querySelector('[data-session-memory-toggle]'); if (toggle.checked !== ${enabled}) toggle.click(); })()`);
      await page.waitFor(`document.querySelector('[data-session-memory-toggle]').checked === ${enabled}`);
    }
    const value = await page.evaluate("document.querySelector('[data-session-memory-toggle]').checked");
    await page.evaluate("document.querySelector('[data-session-memory-toggle]').closest('[role=dialog]').querySelector('header button').click()");
    await page.waitFor("document.querySelector('[data-session-memory-toggle]') === null");
    return value;
  };
  const setMemory = async enabled => { assert.equal(await memorySetting(enabled), enabled); };
  const requestEvent = (from, text) => page.events.slice(from).find((event) => {
    if (event.method !== "Network.requestWillBeSent" || event.params.request.method !== "POST") return false;
    if (!/\/api\/long-agents\/[^/]+\/(turns|messages)$/.test(event.params.request.url)) return false;
    return JSON.parse(event.params.request.postData ?? "{}").text === text;
  });
  const send = async (text, memoryEnabled, expectedStatus = "completed") => {
    await ready();
    const before = page.events.length;
    const writersBefore = writerCalls.length;
    await page.evaluate("document.querySelector('[data-chat-composer]').focus(); document.querySelector('[data-chat-composer]').select()");
    await page.send("Input.insertText", { text });
    assert.equal(await page.evaluate("document.querySelector('[data-chat-composer]').value"), text);
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13 });
    }
    const deadline = Date.now() + 60_000;
    let request;
    while (!(request = requestEvent(before, text))) {
      if (Date.now() > deadline) throw new Error(`没有接受发送 ${text}`);
      await pause(50);
    }
    const body = JSON.parse(request.params.request.postData);
    assert.equal(body.sessionMemory, memoryEnabled ? undefined : "off", `${text} 的真实请求开关`);
    while (!page.events.some((event) => event.method === "Network.loadingFinished" && event.params.requestId === request.params.requestId)) {
      if (Date.now() > deadline) throw new Error(`接受请求没有完成 ${text}`);
      await pause(50);
    }
    const response = await page.send("Network.getResponseBody", { requestId: request.params.requestId });
    const accepted = JSON.parse(response.body);
    assert.equal(typeof accepted.id, "string", JSON.stringify(accepted));
    let execution;
    for (;;) {
      const snapshot = await (await fetch(`${baseUrl}/api/long-agents/friend/turns/${encodeURIComponent(accepted.id)}`)).json();
      execution = snapshot.execution;
      if (["completed", "failed", "cancelled"].includes(execution?.status)) break;
      if (Date.now() > deadline) throw new Error(`轮次没有终结 ${text}`);
      await pause(50);
    }
    assert.equal(execution.status, expectedStatus, text);
    await page.waitFor("document.querySelector('[data-chat-stop]') === null", { label: `${text} UI 已终结` });
    if (memoryEnabled) assert.equal(writerCalls.length > writersBefore, true, `${text} writer 必须运行`);
    else assert.equal(writerCalls.length, writersBefore, `${text} writer 不得运行`);

    // Completion must re-read durable history even for a fast model inside the opening cache lifetime.
    // A missing read cannot be masked by opening a fresh page or waiting for the periodic poll.
    const finalReads = page.events.slice(before).filter((event) => event.method === "Network.requestWillBeSent"
      && event.params.request.method === "GET"
      && new URL(event.params.request.url).pathname === `/api/sessions/${accepted.sessionId}`);
    assert.equal(finalReads.length > 0, true, `${text} 完成后必须重新读取历史`);
    await page.waitFor(`${visibleChat} && document.querySelector('[data-workspace-chat]').innerText.includes(${JSON.stringify(`${WORK_TEXT} ${text}`)})`,
      { label: `${text} 答案在原页面保留` });
    return accepted;
  };

  await ready();
  // All sends share the SAME page and Session; only the explicit refresh reloads it.
  assert.equal(await memorySetting(), true);
  const first = await send("switch-on", true);
  await setMemory(false);
  const off = await send("switch-off", false);
  assert.equal(off.sessionId, first.sessionId);

  await page.send("Page.reload");
  await ready();
  assert.equal(await memorySetting(), false, "刷新保留关闭状态");
  const afterRefresh = await send("switch-off-after-refresh", false);
  assert.equal(afterRefresh.sessionId, first.sessionId);
  await setMemory(true);
  const enabled = await send("switch-on-again", true);
  assert.equal(enabled.sessionId, first.sessionId);

  // Reusing an already-open Session must still reveal its chat after leaving the chat workspace.
  await page.evaluate("document.querySelector('#workspace-topics-tab').click()");
  await page.waitFor("document.querySelector('[data-workspace-chat]')?.hidden === true");
  await page.evaluate("document.querySelector('[data-long-agent-open=\"friend\"]').click()");
  await ready();
  assert.equal(await page.evaluate(`document.querySelector('[data-workspace-chat]').innerText.includes(${JSON.stringify(`${WORK_TEXT} switch-on-again`)})`), true);

  // Warm contact switching must not blank the chat or dim the entire contact list. Observe every
  // DOM commit and every painted frame through the authoritative reload, not just its final state.
  for (const id of ["other", "friend", "other"]) {
    await page.evaluate(`document.querySelector('[data-long-agent-open="${id}"]').click()`);
    await page.waitFor(`document.querySelector('[data-long-agent-open="${id}"]').getAttribute('aria-current') === 'page'`);
    await ready();
  }
  await page.evaluate(`(() => {
    const surface = document.querySelector('[data-workspace-chat]');
    window.__navigationContinuity = { blank: 0, dimmed: 0, frames: 0, active: true };
    const sample = () => {
      const trace = window.__navigationContinuity;
      if (!surface.querySelector('[data-chat-composer]')) trace.blank++;
      if ([...document.querySelectorAll('[data-long-agent-open]')].some(row => Number(getComputedStyle(row).opacity) < 1)) trace.dimmed++;
    };
    window.__continuityObserver = new MutationObserver(sample);
    window.__continuityObserver.observe(surface.parentElement, {subtree:true, childList:true, attributes:true});
    const frame = () => { if (!window.__navigationContinuity.active) return; sample(); window.__navigationContinuity.frames++; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    document.querySelector('[data-long-agent-open="friend"]').click();
  })()`);
  await page.waitFor(`document.querySelector('[data-rendered-session="${first.sessionId}"] [data-chat-composer]') !== null`);
  await page.waitFor("window.__navigationContinuity.frames >= 10");
  const continuity = await page.evaluate(`(() => {
    window.__navigationContinuity.active = false; window.__continuityObserver.disconnect();
    return window.__navigationContinuity;
  })()`);
  assert.equal(continuity.blank, 0, "切回已访问联系人时消息和输入区域不能被加载页替换");
  assert.equal(continuity.dimmed, 0, "点击联系人不能使整列闪灰");
  assert.equal(await page.evaluate(`document.querySelector('[data-workspace-chat]').innerText.includes(${JSON.stringify(`${WORK_TEXT} switch-on-again`)})`), true);

  writerFails = true;
  const failed = await send("switch-fail", true, "failed");
  assert.equal(failed.sessionId, first.sessionId);
  const payload = await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(failed.sessionId)}?projectId=friend`)).json();
  assert.equal(payload.context.messages.some((message) => message.role === "custom" && message.customType === "chat.session_memory_notice"), true);
  await page.send("Page.reload");
  await ready();
  await page.waitFor("document.querySelector('[data-workspace-chat]').innerText.includes('会话记忆本轮未写入')", { label: "刷新后失败通知可见" });
  assert.equal(await page.evaluate(`document.querySelector('[data-workspace-chat]').innerText.includes(${JSON.stringify(`${WORK_TEXT} switch-fail`)})`), true);

  // The visible completion feedback comes from real Pi events, not fabricated component props.
  const settingsPath = path.join(f.home, "agent/settings.json");
  const originalSettings = fs.readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(originalSettings);
  settings.compaction.enabled = true;
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  await setMemory(false);
  forceCompaction = true;
  await send("switch-compact", false);
  await page.waitFor("document.querySelector('[data-compaction-status=completed]') !== null", { label: "原生压缩结果可见" });
  const compactionFeedback = await page.evaluate("document.querySelector('[data-compaction-status=completed]').textContent");
  assert.match(compactionFeedback, /Context compacted\./);
  assert.match(compactionFeedback, /about \d+ tokens/);
  assert.match(compactionFeedback, /Original history is preserved/);
  assert.doesNotMatch(await page.evaluate("document.querySelector('[data-run-status]').innerText"), /Completed/,
    "the existing turn summary owns the completed label; compaction feedback does not duplicate it");
  await screenshot("native-compaction-feedback");
  fs.writeFileSync(settingsPath, originalSettings);

  // Native controls must work from the actual composer, not only from API calls.
  await send("switch-before-manual", false);
  const controlsUrl = `${baseUrl}/api/sessions/${first.sessionId}/maintenance?projectId=friend`;
  const beforeNativeControls = await (await fetch(controlsUrl)).json();
  await page.waitFor("document.querySelector('[data-session-compact=idle]') !== null");
  await page.evaluate("document.querySelector('[data-session-compact=idle]').click()");
  let manualState;
  for (let i=0;i<300;i++) {
    manualState=await (await fetch(controlsUrl)).json();
    if (manualState.operation?.kind === 'compact' && manualState.operation.status !== 'running') break;
    await pause(50);
  }
  assert.equal(manualState.operation.status,'completed',JSON.stringify(manualState));
  assert.ok(manualState.stats.tokens.total > beforeNativeControls.stats.tokens.total);
  assert.equal(manualState.stats.contextUsage.tokens,null);
  await page.waitFor("document.querySelector('[data-chat-stop]') === null && document.body.innerText.includes('Compacted:')");
  await page.send('Page.reload'); await ready();
  await page.waitFor("document.body.innerText.includes('Compacted:') && document.querySelector('[data-session-stats-open]') !== null");
  await page.evaluate("document.querySelector('[data-session-stats-open]').click()");
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(first.sessionId)})`);
  await screenshot('native-session-statistics');
  await page.evaluate("document.querySelector('[data-session-stats-open]').click()");
  await send('switch-edit-history',false);
  await page.waitFor("document.querySelector('[data-session-continue]') !== null");
  await page.evaluate("[...document.querySelectorAll('[data-session-continue]')].at(-1).click()");
  await page.waitFor("document.querySelector('[data-chat-composer]')?.value === 'switch-edit-history'");
  const historyState=await (await fetch(controlsUrl)).json();
  assert.equal(historyState.operation.kind,'continue');
  assert.equal(historyState.operation.status,'completed');
  const callsBeforeHistoryRefresh=f.requests.length;
  await page.send('Page.reload'); await ready();
  assert.equal(f.requests.length,callsBeforeHistoryRefresh,'history continuation and refresh must not run a model');
  assert.equal(await page.evaluate("document.querySelector('[data-chat-composer]').value"),'switch-edit-history');
  await send('switch-after-history',false);
  let releaseManualSummary, manualHttpStarted = false;
  const heldManualSummary = new Promise(resolve => { releaseManualSummary = resolve; });
  f.setHandler(async () => { manualHttpStarted = true; await heldManualSummary; return {content:'CANCELLED_MANUAL_PARTIAL'}; });
  await page.waitFor("document.querySelector('[data-session-compact=idle]') !== null");
  await page.evaluate("document.querySelector('[data-session-compact=idle]').click()");
  await page.waitFor("document.querySelector('[data-session-compact=running]') !== null");
  for (let i=0; !manualHttpStarted && i<200; i++) await pause(25);
  assert.equal(manualHttpStarted,true,'wait for the first actual summary request before testing reload');
  const cancelCalls=f.requests.length;
  await page.send('Page.reload'); await ready();
  await page.waitFor("document.querySelector('[data-session-compact=running]') !== null");
  assert.equal(f.requests.length,cancelCalls,'refresh must observe, not duplicate compaction');
  await page.evaluate("document.querySelector('[data-session-compact=running]').click()");
  await page.waitFor("document.body.innerText.includes('Compaction cancelled. Your original history is preserved.')");
  assert.equal((await (await fetch(controlsUrl)).json()).operation.status,'cancelled');
  releaseManualSummary(); f.setHandler(modelHandler);

  for (const [width,height] of [[390,844],[768,1024],[1440,900],[720,450],[390,420]]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`innerWidth === ${width}`);
    const bounds = await page.evaluate(`(() => {
      const selectors = ['[data-chat-composer]', '[data-chat-toolbar]', '[data-session-memory-open]'];
      return selectors.map(selector => {const r=document.querySelector(selector).getBoundingClientRect();
        return {selector,top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight};});
    })()`);
    for (const r of bounds) assert.ok(r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= r.vh + 1 && r.left >= 0 && r.right <= r.vw + 1,
      `composer control stays entirely on-screen: ${JSON.stringify(r)}`);
    await screenshot(`composer-${width}x${height}`);
  }
  await page.send("Emulation.setDeviceMetricsOverride", {width:1440,height:900,deviceScaleFactor:1,mobile:false});
  // Native history remains conversational. An explicit empty-date click creates/opens without a model.
  await page.evaluate(`document.querySelector('[data-friend-calendar-open="friend"]').click()`);
  await page.waitFor(`document.querySelector('[data-friend-calendar="friend"][aria-busy="false"] [data-calendar-heat-date="${historical.day.date}"][data-active]') !== null`);
  const cellSize = await page.evaluate(`(() => { const r = document.querySelector('[data-calendar-heat-date="${historical.day.date}"]').getBoundingClientRect(); return {width:r.width,height:r.height}; })()`);
  assert.equal(cellSize.width, cellSize.height, "shared form button minimum height must not stretch heatmap squares");
  for (const width of [390, 768, 1440]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`window.innerWidth === ${width}`);
    const layout = await page.evaluate(`(() => { const el = document.querySelector('[data-friend-calendar]'); const r = el.closest('[role=dialog]').getBoundingClientRect(); return { width: r.width, left: r.left, right: r.right, viewport: innerWidth }; })()`);
    assert.ok(layout.width > 0 && layout.left >= 0 && layout.right <= layout.viewport, `calendar remains visible when the sidebar folds: ${JSON.stringify(layout)}`);
  }
  const calendarBefore = await (await fetch(`${baseUrl}/api/long-agents/friend/daily`)).json();
  assert.equal(await page.evaluate(`document.querySelector('[data-calendar-heat-date="${new Date(Date.now()+2*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})}"]')?.hasAttribute('data-active') === true`),false,'an empty date is not activity');
  assert.equal(await page.evaluate(`document.querySelector('[data-calendar-heat-date="${emptyHistory.day.date}"]').disabled`),false,'empty dates can be opened');
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-calendar-date]:disabled').length`), 0);
  await page.evaluate(`document.querySelector('[data-calendar-month="${Number(historical.day.date.slice(5,7))}"]').click()`);
  await page.evaluate(`document.querySelector('[data-calendar-date="${historical.day.date}"]').click()`);
  await page.waitFor("document.querySelector('[data-friend-calendar]') === null");
  await page.waitFor(`document.querySelector('[data-rendered-session="${historical.day.sessionId}"]')?.innerText.includes('CALENDAR_HISTORY_CONTENT')`);
  await ready();
  writerFails = false;
  await setMemory(false);
  const continued = await send('switch-history-continue',false);
  assert.equal(continued.sessionId,historical.day.sessionId,'continue the selected history, never reroute to today');
  assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes('CALENDAR_HISTORY_CONTENT')
    && JSON.stringify(request.messages).includes('switch-history-continue')),'the model really received prior history');
  const calendarAfter = await (await fetch(`${baseUrl}/api/long-agents/friend/daily`)).json();
  assert.deepEqual(calendarAfter.days.map(d => d.sessionId), calendarBefore.days.map(d => d.sessionId));
  await page.send("Page.reload");
  await page.waitFor(`document.querySelector('[data-rendered-session="${historical.day.sessionId}"]')?.innerText.includes('CALENDAR_HISTORY_CONTENT')`);
  await page.waitFor(`document.querySelector('[data-friend-day="${historical.day.date}"] [data-day-work="${calendarJobs[0].id}"]') !== null`);
  assert.equal(await page.evaluate(`document.querySelector('[data-day-work="${calendarJobs[1].id}"]') === null`), true, 'the other day’s same-title work is not listed');
  assert.equal(await page.evaluate(`new URL(location.href).searchParams.get('friendDate')`), historical.day.date, 'refresh preserves the day filter');
  await page.evaluate(`document.querySelector('[data-day-work="${calendarJobs[0].id}"] button').click()`);
  await page.waitFor(`document.querySelector('[data-rendered-session="${calendarJobs[0].sessionId}"]')?.innerText.includes('CALENDAR_JOB_0')`);
  assert.equal(await page.evaluate(`new URL(location.href).searchParams.get('friendDate')`), historical.day.date, 'historical work without a live execution remains readable on the same day');
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-rendered-session="${historical.day.sessionId}"]')?.innerText.includes('CALENDAR_HISTORY_CONTENT')`);
  await page.waitFor(`document.querySelector('[data-friend-day="${historical.day.date}"] [data-day-work="${calendarJobs[0].id}"]') !== null`);
  assert.equal(await page.evaluate("document.querySelector('[data-friend-day] form') === null"), true, 'background tasks are arranged through chat, not a second form');
  await page.evaluate("document.querySelector('[data-arrange-background]').click()");
  await page.waitFor("document.activeElement?.matches('[data-chat-composer]')", {label:'arrange task focuses the daily composer'});
  await screenshot('day-workspace-light');
  await page.evaluate("document.documentElement.classList.add('dark')");
  await screenshot('day-workspace-dark');
  await page.evaluate("document.documentElement.classList.remove('dark')");
  await page.waitFor(`document.querySelector('[data-day-session="${secondHistory.manager.getSessionId()}"]') !== null`);
  await page.evaluate(`document.querySelector('[data-day-session="${secondHistory.manager.getSessionId()}"]').click()`);
  await page.waitFor(`document.querySelector('[data-rendered-session="${secondHistory.manager.getSessionId()}"]')?.innerText.includes('CALENDAR_SECOND_ACTIVITY')`);
  assert.equal(await page.evaluate(`new URL(location.href).searchParams.get('friendDate')`), historical.day.date, 'opening another Session stays within the selected day');

  // Empty allocated days reuse their Session, and a new empty date creates exactly one through /start.
  const freshDate = new Date(Date.now()+2*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  const openEmptyDate = async date => {
    await page.evaluate("document.querySelector('#workspace-coworkers-tab').click()");
    await page.waitFor("document.querySelector('[data-friend-calendar-open=\"friend\"]') !== null");
    await page.evaluate(`document.querySelector('[data-friend-calendar-open="friend"]').click()`);
    await page.waitFor(`document.querySelector('[data-friend-calendar="friend"][aria-busy="false"]') !== null`);
    const targetYear = Number(date.slice(0,4));
    const currentYear = Number(await page.evaluate(`document.querySelector('[data-calendar-year]').textContent`));
    if (currentYear !== targetYear) {
      await page.evaluate(`[...document.querySelectorAll('[data-friend-calendar] button')].find(b => /下一年|Next year/.test(b.getAttribute('aria-label') ?? '')).click()`);
      await page.waitFor(`document.querySelector('[data-calendar-year]').textContent === '${targetYear}' && document.querySelector('[data-friend-calendar][aria-busy="false"]') !== null`);
    }
    await page.evaluate(`document.querySelector('[data-calendar-heat-date="${date}"]').click()`);
    await page.waitFor("document.querySelector('[data-friend-calendar]') === null");
    await ready();
  };
  await openEmptyDate(emptyHistory.day.date);
  assert.equal(await page.evaluate(`document.querySelector('[data-rendered-session]').getAttribute('data-rendered-session')`),emptyHistory.day.sessionId);
  await page.waitFor(`document.querySelector('[data-friend-day="${emptyHistory.day.date}"] [data-day-work="${calendarJobs[1].id}"]') !== null`);
  assert.equal(await page.evaluate(`document.querySelector('[data-day-work="${calendarJobs[0].id}"]') === null`), true);
  await page.send('Page.reload'); await ready();
  await page.waitFor(`document.querySelector('[data-friend-day="${emptyHistory.day.date}"] [data-day-work="${calendarJobs[1].id}"]') !== null`);
  const callsBeforeCreate = f.requests.length;
  await openEmptyDate(freshDate);
  const fresh = (await (await fetch(`${baseUrl}/api/long-agents/friend/daily`)).json()).days.find(day=>day.date===freshDate);
  assert.ok(fresh);
  assert.equal(await page.evaluate(`document.querySelector('[data-rendered-session]').getAttribute('data-rendered-session')`),fresh.sessionId);
  assert.equal(f.requests.length,callsBeforeCreate,'creation is not an execution or schedule');
  await openEmptyDate(freshDate);
  assert.equal((await (await fetch(`${baseUrl}/api/long-agents/friend/daily`)).json()).days.filter(day=>day.date===freshDate).length,1);
  await setMemory(true);
  const arranged = await send('switch-arrange-background', true);
  assert.equal(arranged.sessionId, fresh.sessionId);
  const createdWorks = (await (await fetch(`${baseUrl}/api/long-agents/friend/work`)).json()).works;
  const createdWork = createdWorks.find(item => item.work.title === 'BROWSER_CHAT_TASK');
  assert.ok(createdWork);
  assert.equal(createdWorks.filter(item => item.work.title === 'BROWSER_CHAT_TASK').length,1);
  assert.notEqual(createdWork.work.sessionId,fresh.sessionId);
  assert.equal(createdWork.work.originSessionId,fresh.sessionId);
  const childDeadline = Date.now() + 30000;
  for (;;) {
    const child = (await (await fetch(`${baseUrl}/api/long-agents/friend/work`)).json()).works.find(item => item.work.id === createdWork.work.id);
    if (child.execution?.status === 'completed') break;
    assert.ok(Date.now() < childDeadline, JSON.stringify(child));
    await pause(100);
  }
  await setMemory(false);
  assert.equal((await send('switch-calendar-new',false)).sessionId,fresh.sessionId);
  await page.send('Page.reload'); await ready();
  await page.waitFor(`document.querySelector('[data-rendered-session="${fresh.sessionId}"]')?.innerText.includes('switch-calendar-new')`);

  await page.evaluate(`document.querySelector('[data-long-agent-open="friend"]').click()`);
  await page.waitFor(`document.querySelector('[data-rendered-session="${first.sessionId}"]') !== null`);
  assert.equal(await page.evaluate(`new URL(location.href).searchParams.has('friendDate')`),false,'the Friend card is the one return-to-today action');
  await page.waitFor("document.querySelector('[data-friend-day]')?.innerText.includes('BROWSER_CHAT_TASK')", {label:'chat-created task appears in day sidebar',timeoutMs:30000});
  await page.evaluate("document.querySelector('#workspace-moments-tab').click()");
  await page.waitFor("document.body.innerText.includes('CALENDAR_SOCIAL_HISTORY_REMAINS')");
  await page.evaluate("document.querySelector('#workspace-settings-tab').click()");
  await page.waitFor("document.querySelector('.workspace-settings-nav') !== null");
  await page.evaluate("document.querySelector('[data-settings-section=personal]').click()");
  await page.evaluate("[...document.querySelectorAll('.workspace-settings-group button')].find(b => /memory|记忆/i.test(b.textContent)).click()");
  await page.waitFor("document.querySelector('[aria-label=\"Memory ownership\"], [aria-label=\"记忆归属\"]') !== null");
  await page.waitFor("document.body.innerText.includes('PERSONAL_MEMORY_REMAINS')");
  // Nested destructive/unsaved confirmations share focus ownership and never drop a cancelled draft.
  await page.evaluate("[...document.querySelectorAll('button')].find(b => /^(Add memory|添加记忆)$/.test(b.textContent.trim())).click()");
  await page.waitFor("document.querySelector('#memory-text') !== null");
  await page.evaluate("document.querySelector('#memory-text').focus()");
  await page.send("Input.insertText", {text:'UNSAVED_CONFIRMATION_DRAFT'});
  await page.send("Input.dispatchKeyEvent", {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await page.waitFor("document.querySelector('[role=alertdialog]') !== null", {label:'shared unsaved confirmation'});
  assert.equal(await page.evaluate("document.activeElement?.textContent"), 'Cancel');
  for (let n=0;n<4;n++) await page.send("Input.dispatchKeyEvent", {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await page.evaluate("document.querySelector('[role=alertdialog]').contains(document.activeElement)"),true,'confirmation traps keyboard focus');
  await screenshot('shared-confirmation');
  await page.send("Input.dispatchKeyEvent", {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await page.waitFor("document.querySelector('[role=alertdialog]') === null");
  assert.equal(await page.evaluate("document.querySelector('#memory-text').value"),'UNSAVED_CONFIRMATION_DRAFT');
  await page.send("Input.dispatchKeyEvent", {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await page.waitFor("document.querySelector('[role=alertdialog]') !== null");
  await page.evaluate("document.querySelector('[role=alertdialog] [data-ui-button=primary]').click()");
  await page.waitFor("document.querySelector('#memory-text') === null",{label:'explicit discard closes only editor'});
  assert.equal(await page.evaluate("document.querySelector('[aria-label=\"Memory ownership\"]') !== null"), true);
  const tree = await (await fetch(`${baseUrl}/api/memories/tree`)).json();
  assert.equal(tree.projects.some(p => p.projectId === 'friend' || p.projectId === 'other'), false);
  // Selecting the Agent scope has one gateway failure, no duplicate Project Memory request/HTTP 500.
  const marker = page.events.length;
  await page.evaluate("[...document.querySelectorAll('[aria-label=\"Memory ownership\"] button, [aria-label=\"记忆归属\"] button')].find(b => /^Friend/.test(b.textContent)).click()");
  await page.waitFor("document.querySelector('[data-agent-memory-error] .interface-feedback-toggle') !== null");
  await page.evaluate("document.querySelector('[data-agent-memory-error] .interface-feedback-toggle').click()");
  await page.waitFor("document.body.innerText.includes('读取Agent Memory时NanoClaw暂时不可用')");
  assert.equal(await page.evaluate("document.body.innerText.includes('this does not mean it was deleted') || document.body.innerText.includes('这不表示记忆已删除')"), true);
  const memoryRequests = page.events.slice(marker).filter(e => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/memories'));
  assert.equal(memoryRequests.length, 0, "Agent Memory does not request Personal or Project Memory");

  // A direct settings link at the medium breakpoint must not inherit the hidden chat list's backdrop.
  await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url: `${baseUrl}/?view=settings&settings=appearance` });
  await page.waitFor("document.querySelector('[data-settings-section=personal]') !== null");
  const target = await page.evaluate(`(() => {
    const button = document.querySelector('[data-settings-section=personal]');
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    return { x, y, hit: button.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert.equal(target.hit, true, "settings navigation is not covered by a hidden chat sidebar");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: target.x, y: target.y });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: target.x, y: target.y });
  await page.waitFor("new URL(location.href).searchParams.get('settings') === 'personal'");

  // The browser may be Chinese, but a fresh installation is explicitly English.
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(navigator, 'languages', {get:()=>['zh-CN']}); Object.defineProperty(navigator, 'language', {get:()=> 'zh-CN'});" });
  await page.evaluate("localStorage.removeItem('pi-locale'); document.body.dataset.previousLanguagePage = 'yes'");
  await page.send("Page.navigate", { url: `${baseUrl}/?view=settings&settings=appearance` });
  await page.waitFor("!document.body.dataset.previousLanguagePage && document.querySelector('[role=group][aria-label=Language]') !== null");
  assert.equal(await page.evaluate("document.documentElement.lang"), "en");
  assert.equal(await page.evaluate("navigator.language"), "zh-CN");
  assert.equal(await page.evaluate("/[\\p{Script=Han}]/u.test(document.querySelector('.workspace-settings').innerText)"), false);
  await page.evaluate("[...document.querySelectorAll('[role=group][aria-label=Language] button')].find(b => b.textContent === 'Simplified Chinese').click()");
  await page.waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('[role=group][aria-label=语言]') !== null");
  assert.equal(await page.evaluate("localStorage.getItem('pi-locale')"), "zh-CN");
  await page.evaluate("document.body.dataset.previousLanguagePage = 'yes'");
  await page.send("Page.reload");
  await page.waitFor("!document.body.dataset.previousLanguagePage && document.querySelector('[role=group][aria-label=语言]') !== null");
  assert.equal(await page.evaluate("document.documentElement.lang"), "zh-CN");
  await page.evaluate("document.querySelector('[data-settings-section=personal]').click()");
  await page.evaluate("[...document.querySelectorAll('.workspace-settings-group button')].find(b => b.querySelector('strong')?.textContent === '模型').click()");
  await page.waitFor("document.querySelector('[role=dialog][aria-label=模型]') !== null");
  assert.equal(await page.evaluate("document.querySelector('[role=dialog][aria-label=模型] button[aria-label=关闭]') !== null"), true);
  await page.evaluate("document.querySelector('[role=dialog][aria-label=模型] button[aria-label=关闭]').click()");
  await page.evaluate("document.querySelector('[data-settings-section=appearance]').click()");
  await page.evaluate("[...document.querySelectorAll('[role=group][aria-label=语言] button')].find(b => b.textContent === '英语').click()");
  await page.waitFor("document.documentElement.lang === 'en' && document.querySelector('[role=group][aria-label=Language]') !== null");
  assert.equal(await page.evaluate("localStorage.getItem('pi-locale')"), "en");
  await screenshot('language-english');
  await page.send("Page.navigate", { url: `${baseUrl}/offline.html` });
  await page.waitFor("document.querySelector('#offline-reconnect')?.textContent === 'Reconnect'");
  assert.equal(await page.evaluate("document.documentElement.lang"), "en");
  await page.evaluate("localStorage.setItem('pi-locale', 'zh-CN')");
  await page.send("Page.reload");
  await page.waitFor("document.querySelector('#offline-reconnect')?.textContent === '重新连接'");

});
