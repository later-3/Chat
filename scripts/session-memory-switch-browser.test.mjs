import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture } from "../test/long-agents/daily-fixture.mjs";
import { launchBrowser } from "./cdp.mjs";

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
  let writerFails = false;
  const writerCalls = [];
  f.setHandler((body) => {
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
    return { content: `${WORK_TEXT} ${text.match(/switch-[a-z-]+/)?.[0] ?? text}` };
  });

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
    await page.waitFor(`${visibleChat} && document.querySelector('[data-session-memory-toggle]') !== null && document.querySelector('[data-chat-composer]:not([disabled])') !== null`,
      { label: "当前会话可见且可输入", timeoutMs: 60_000 });
  };
  const setMemory = async (enabled) => {
    await page.evaluate(`(() => { const toggle = document.querySelector('[data-session-memory-toggle]'); if (toggle.checked !== ${enabled}) toggle.click(); })()`);
    await page.waitFor(`document.querySelector('[data-session-memory-toggle]').checked === ${enabled}`);
  };
  const requestEvent = (from, text) => page.events.slice(from).find((event) => {
    if (event.method !== "Network.requestWillBeSent" || event.params.request.method !== "POST") return false;
    if (!/\/api\/long-agents\/[^/]+\/(turns|messages)$/.test(event.params.request.url)) return false;
    return JSON.parse(event.params.request.postData ?? "{}").text === text;
  });
  const send = async (text, memoryEnabled, expectedStatus = "completed") => {
    await ready();
    const before = page.events.length;
    const writersBefore = writerCalls.length;
    await page.evaluate("document.querySelector('[data-chat-composer]').focus()");
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    }
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
  assert.equal(await page.evaluate("document.querySelector('[data-session-memory-toggle]').checked"), true);
  const first = await send("switch-on", true);
  await setMemory(false);
  const off = await send("switch-off", false);
  assert.equal(off.sessionId, first.sessionId);

  await page.send("Page.reload");
  await ready();
  assert.equal(await page.evaluate("document.querySelector('[data-session-memory-toggle]').checked"), false, "刷新保留关闭状态");
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

  writerFails = true;
  const failed = await send("switch-fail", true, "failed");
  assert.equal(failed.sessionId, first.sessionId);
  const payload = await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(failed.sessionId)}?projectId=friend`)).json();
  assert.equal(payload.context.messages.some((message) => message.role === "custom" && message.customType === "chat.session_memory_notice"), true);
  await page.send("Page.reload");
  await ready();
  await page.waitFor("document.querySelector('[data-workspace-chat]').innerText.includes('会话记忆本轮未写入')", { label: "刷新后失败通知可见" });
  assert.equal(await page.evaluate(`document.querySelector('[data-workspace-chat]').innerText.includes(${JSON.stringify(`${WORK_TEXT} switch-fail`)})`), true);
});
