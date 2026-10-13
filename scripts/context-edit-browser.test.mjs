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
 * B5 编辑层，走真实浏览器、真实轮次、真实请求体：
 * 勾掉区块/工具 → 下一轮模型确实没收到（payload 原文断言）；恢复 → 真的发回去。
 * UI：完整历史详情里的勾选框 → 已排除折叠区 → 恢复。
 */
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");
const WORK_TEXT = "CONTEXT_EDIT_WORK_OK";

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

test("B5 编辑层：勾掉的区块/工具真的没发给模型，恢复后真的发回去", { concurrency: false, timeout: 300_000 }, async (t) => {
  const cleanups = [];
  const f = await fixture({ after: (register) => cleanups.push(register) });
  f.setHandler((body) => {
    const user = body.messages.filter((message) => message.role === "user").at(-1);
    const text = typeof user?.content === "string" ? user.content
      : (user?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return { content: `${WORK_TEXT} ${text}` };
  });

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-context-edit-browser-"));
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
  process.on("exit", () => { if (process.env.B5_DEBUG === "1") console.log("SERVER_TAIL", output.slice(-4000)); });
  let browser;
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
  const page = await browser.newPage(`${baseUrl}/`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const readyDeadline = Date.now() + 60_000;
  for (;;) {
    const ok = await page.evaluate("document.querySelector('[data-chat-settings]') !== null && document.querySelector('[data-chat-composer]:not([disabled])') !== null").catch(() => false);
    if (ok === true) break;
    if (Date.now() > readyDeadline) throw new Error("当前会话没有进入可输入状态");
    await pause(250);
  }

  const send = async (text) => {
    await page.evaluate("document.querySelector('[data-chat-composer]').focus(); document.querySelector('[data-chat-composer]').select()");
    await page.send("Input.insertText", { text });
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
    const bodyDeadline = Date.now() + 30_000;
    while (!page.events.some((event) => event.method === "Network.loadingFinished" && event.params.requestId === request.params.requestId)) {
      assert.ok(Date.now() < bodyDeadline, `接受请求没有完成 ${text}`);
      await pause(50);
    }
    const accepted = JSON.parse((await page.send("Network.getResponseBody", { requestId: request.params.requestId })).body);
    const turnDeadline = Date.now() + 60_000;
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

  const api = {
    recording: async (sessionId, enabled, expectedRevision) => (await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/interaction-recording?projectId=friend`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, expectedRevision }) },
    )).json(),
    readEdit: async (sessionId) => (await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/context-edit?projectId=friend`,
    )).json(),
    writeEdit: async (sessionId, excluded, expectedRevision) => {
      const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/context-edit?projectId=friend`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded, modified: {}, added: {}, expectedRevision }),
      });
      return { status: response.status, body: await response.json() };
    },
    /** 该轮最后一次请求：区域行 + 可选原文。 */
    lastRequest: async (sessionId) => {
      const index = await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/interactions?projectId=friend&limit=500`)).json();
      const rows = [...(index.rows ?? [])].filter((row) => row.sessionId === sessionId).sort((a, b) => a.seq - b.seq);
      const row = rows.at(-1);
      assert.ok(row, `找到 ${sessionId} 的请求行`);
      const detail = await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/interactions/requests/${encodeURIComponent(row.requestId)}?projectId=friend&payload=1`)).json();
      return { row, detail };
    },
  };

  // ① 基线轮 + 打开完整记录（后面要核对真实 payload 原文）。
  const base = await send("b5-base");
  const sessionId = base.sessionId;
  const recording = await api.recording(sessionId, true, 0);
  assert.equal(recording.enabled, true, JSON.stringify(recording));

  // ② 写入编辑层：排除身份区块与 read 工具（下一轮生效）。
  const written = await api.writeEdit(sessionId, ["tag:chat_identity", "tools:read"], 0);
  assert.equal(written.status, 200, JSON.stringify(written));
  assert.equal(written.body.revision, 1);
  assert.deepEqual(written.body.excluded, ["tag:chat_identity", "tools:read"]);

  // ③ 排除后的轮：核对真实发给模型的内容。
  const excludedRound = await send("b5-excluded");
  const excluded = await api.lastRequest(excludedRound.sessionId);
  const excludedRegionIds = (excluded.row.regions ?? []).map((region) => region.id);
  assert.equal(excludedRegionIds.some((id) => id.includes("identity")), false,
    `区域行不应再有身份区块：${JSON.stringify(excludedRegionIds)}`);
  console.log("EXCLUDED_REGIONS", JSON.stringify(excludedRegionIds));
  assert.equal(excluded.detail.payloadPresent, true, "记录开关已开 → 原文应存在");
  const excludedPayload = excluded.detail.payload;
  assert.ok(excludedPayload, "原文存在");
  const systemText = (excludedPayload.messages ?? []).filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n");
  assert.equal(systemText.includes("<chat_identity"), false, "真实请求体不含被排除的身份区块");
  assert.equal(systemText.includes("<chat_long_term_memory"), true, "未被排除的区块仍在（只删勾掉的）");
  const toolNames = (excludedPayload.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
  assert.equal(toolNames.includes("read"), false, `被排除的工具不在：${JSON.stringify(toolNames.slice(0, 8))}`);
  assert.ok(toolNames.length > 0, "其余工具仍在");

  // ④ 恢复 → 下一轮真的发回去。
  const restored = await api.writeEdit(sessionId, [], 1);
  assert.equal(restored.status, 200, JSON.stringify(restored));
  assert.equal(restored.body.revision, 2);
  const restoredRound = await send("b5-restored");
  const back = await api.lastRequest(restoredRound.sessionId);
  const backRegionIds = (back.row.regions ?? []).map((region) => region.id);
  assert.equal(backRegionIds.some((id) => id.includes("identity")), true,
    `恢复后区域行应再有身份区块：${JSON.stringify(backRegionIds)}`);
  const backSystem = (back.detail.payload.messages ?? []).filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n");
  assert.equal(backSystem.includes("<chat_identity"), true, "恢复后真实请求体含身份区块");
  console.log("RESTORED_REGIONS", JSON.stringify(backRegionIds));

  // ⑤ UI（**发送前入口**，用户定界）：composer 旁「即将发送的内容」→ 勾选 / 已排除区 / 恢复。
  //    完整历史保持只读（回看不是编辑的地方）。
  await page.evaluate("document.querySelector('[data-context-preview-open]').click()");
  await page.waitFor("document.querySelector('[data-context-preview]') !== null", { label: "发送前编辑面板", timeoutMs: 30_000 });
  await pause(8000);
  console.log("PREVIEW_PANEL_DUMP", await page.evaluate(`JSON.stringify({
    error: document.querySelector('[data-context-preview-error]')?.textContent ?? null,
    empty: document.querySelector('[data-context-preview-empty]')?.textContent ?? null,
    text: (document.querySelector('[data-context-preview]')?.innerText ?? '').slice(0, 300),
    toggles: document.querySelectorAll('[data-context-preview] [data-context-edit-toggle]').length,
  })`));
  await page.waitFor("document.querySelector('[data-context-preview] [data-context-edit-toggle]') !== null", { label: "块勾选框", timeoutMs: 60_000 });
  const previewSummary = await page.evaluate("document.querySelector('[data-context-edit-summary]')?.textContent ?? ''");
  assert.ok(/\d/.test(previewSummary), `发送统计应显示数字：${previewSummary}`);
  console.log("PREVIEW_SUMMARY", previewSummary.trim());
  const previewToggles = await page.evaluate("[...document.querySelectorAll('[data-context-preview] [data-context-edit-toggle]')].map(n => n.getAttribute('data-context-edit-toggle'))");
  console.log("PREVIEW_TOGGLES", JSON.stringify(previewToggles.slice(0, 10)));
  assert.ok(previewToggles.includes("tag:chat_identity"), `面板应有身份区块勾选框：${JSON.stringify(previewToggles.slice(0, 10))}`);
  assert.ok(previewToggles.some((id) => id.startsWith("tools:")), `面板应有工具勾选框：${JSON.stringify(previewToggles.slice(0, 10))}`);

  // 勾掉身份区块 → 已排除折叠区出现 + 后端真的写入。
  await page.evaluate("document.querySelector('[data-context-preview] [data-context-edit-toggle=\"tag:chat_identity\"]').click()");
  await page.waitFor("document.querySelector('[data-context-preview] [data-context-excluded]') !== null", { label: "已排除折叠区出现", timeoutMs: 20_000 });
  await pause(600);
  const afterUiExclude = await api.readEdit(sessionId);
  assert.equal(afterUiExclude.excluded.includes("tag:chat_identity"), true, `UI 勾选写入后端：${JSON.stringify(afterUiExclude)}`);
  const excludedRegionText = await page.evaluate("document.querySelector('[data-context-preview] [data-context-excluded]')?.textContent ?? ''");
  assert.ok(/已排除|Excluded/i.test(excludedRegionText), `已排除区文案：${excludedRegionText}`);

  // 在已排除区里恢复 → 折叠区消失 + 后端清空。
  await page.evaluate("document.querySelector('[data-context-preview] [data-context-excluded] [data-context-edit-toggle=\"tag:chat_identity\"]').click()");
  await page.waitFor("document.querySelector('[data-context-preview] [data-context-excluded]') === null", { label: "恢复后已排除区消失", timeoutMs: 20_000 });
  await pause(600);
  const afterUiRestore = await api.readEdit(sessionId);
  assert.equal(afterUiRestore.excluded.includes("tag:chat_identity"), false, `UI 恢复写入后端：${JSON.stringify(afterUiRestore)}`);

  // ⑤b 子条目（用户 2026-10-13）：面板里若存在块内条目，勾掉一个 → 后端写入 `tag:<tag>#<条目>`
  //     （fixture 的区块内容很短、可能没有 `## ` 小节——存在才验证，切分规则本身由后端单测锁定）。
  const subEntryIds = await page.evaluate("[...document.querySelectorAll('[data-context-preview] [data-sub-entry]')].map(n => n.getAttribute('data-sub-entry'))");
  console.log("SUB_ENTRIES", JSON.stringify(subEntryIds.slice(0, 6)));
  if (subEntryIds.length > 0) {
    const subToggle = await page.evaluate("[...document.querySelectorAll('[data-context-preview] [data-context-edit-toggle]')].map(n => n.getAttribute('data-context-edit-toggle')).find(id => id.includes('#'))");
    assert.ok(subToggle?.includes("#"), `子条目勾选框应有 tag#sub 形态：${subToggle}`);
    await page.evaluate(`document.querySelector('[data-context-preview] [data-context-edit-toggle="${subToggle}"]').click()`);
    await pause(600);
    const afterSub = await api.readEdit(sessionId);
    assert.equal(afterSub.excluded.includes(subToggle), true, `子条目勾选写入后端：${JSON.stringify(afterSub.excluded)}`);
    await page.evaluate(`document.querySelector('[data-context-preview] [data-context-excluded] [data-context-edit-toggle="${subToggle}"]').click()`);
    await pause(600);
    const restoredSub = await api.readEdit(sessionId);
    assert.equal(restoredSub.excluded.includes(subToggle), false, `子条目恢复：${JSON.stringify(restoredSub.excluded)}`);
  }

  // ⑥ 边界（用户 2026-10-13）：完整历史是事后回看 → 只读，不出现编辑勾选框。
  await page.evaluate("[...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelector('header button[aria-label=Close]')?.click()");
  const closeDialog = () => page.evaluate("[...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelector('header button[aria-label=Close]')?.click()");
  const openHistory = () => page.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(candidate =>
      /完整历史|Full history/i.test(candidate.getAttribute('aria-label') ?? '') && !candidate.disabled);
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  const turnScope = (index) => `document.querySelectorAll('.full-history-turn')[${index}]`;
  assert.equal(await openHistory(), true, "完整历史入口存在");
  await page.waitFor("document.querySelectorAll('[data-full-history-turn-toggle]').length > 0", { label: "按轮列表", timeoutMs: 30_000 });
  const turnCount = await page.evaluate("document.querySelectorAll('[data-full-history-turn-toggle]').length");
  await page.evaluate(`document.querySelectorAll('[data-full-history-turn-toggle]')[${turnCount - 1}].click()`);
  await page.waitFor(`${turnScope(turnCount - 1)}.querySelector('[data-reply-bar]') !== null`, { label: "回复 bar" });
  await page.evaluate(`${turnScope(turnCount - 1)}.querySelector('[data-reply-bar]').click()`);
  await page.waitFor(`${turnScope(turnCount - 1)}.querySelectorAll('[data-prompt-capture-record]').length > 0`, { label: "请求组出现" });
  await page.evaluate(`${turnScope(turnCount - 1)}.querySelector('[data-prompt-capture-row-toggle]').click()`);
  await page.waitFor("document.querySelector('[data-raw-request]') !== null", { label: "原始请求体树", timeoutMs: 30_000 });
  const historyToggles = await page.evaluate("document.querySelectorAll('[role=dialog] [data-context-edit-toggle]').length");
  assert.equal(historyToggles, 0, `完整历史只读：不应出现编辑勾选框（实际 ${historyToggles}）`);
  await closeDialog();

  // ⑦ 跨轮持久：刷新页面后编辑层仍是服务端事实（恢复后的状态 = 空）。
  await page.send("Page.reload");
  await pause(1500);
  const afterReload = await api.readEdit(sessionId);
  assert.deepEqual(afterReload.excluded, [], `刷新后编辑层保持服务端事实：${JSON.stringify(afterReload)}`);
});
