import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser } from "./cdp.mjs";
import { fixture } from "../test/long-agents/daily-fixture.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");
const pause = (ms) => new Promise(r => setTimeout(r, ms));

test("回复 bar：收起态字段/展开全宽+TurnInteractions/sticky/收起回文档流/旧组件常规轮移除", { concurrency: false }, async (t) => {
  const cleanups = [];
  const f = await fixture({ after: cb => cleanups.push(cb) });
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const port = await new Promise(resolve => {
    const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const p = socket.address().port; socket.close(() => resolve(p)); });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-turn-summary-bar-"));
  const server = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot, env: { ...process.env, CHAT_HOME: f.home, CHAT_NITRO_BUILD_DIR: buildDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", c => { output += String(c); });
  server.stderr.on("data", c => { output += String(c); });
  t.after(() => { server.kill("SIGTERM"); try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch {} });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`dev server did not start:\n${output.slice(-600)}`);
    await pause(300);
  }

  const browser = await launchBrowser();
  t.after(() => browser.close?.());
  const page = await browser.newPage(`${baseUrl}/?projectId=friend`);
  await page.waitFor("document.readyState === 'complete'");
  await page.waitFor("document.querySelector('[data-chat-composer]') !== null", { timeoutMs: 60_000 });

  // 发送一轮（完成后产生 bar）
  await page.evaluate("document.querySelector('[data-chat-composer]').focus(); document.querySelector('[data-chat-composer]').select()");
  await page.send("Input.insertText", { text: "bar-contract-check" });
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13 });
  const turnDeadline = Date.now() + 90_000;
  for (;;) {
    const done = await page.evaluate(`(() => {
      const bars = [...document.querySelectorAll('[data-summary-bar-toggle]')];
      return bars.length > 0 && bars.every(b => (b.getAttribute('data-reply-state') ?? '') !== 'running');
    })()`).catch(() => false);
    if (done === true) break;
    assert.ok(Date.now() < turnDeadline, `轮未终结或 bar 未出现`);
    await pause(300);
  }

  // ① 收起态字段（回复 bar 名/状态/prompt/工具数/耗时/模型）
  const collapsed = await page.evaluate(`(() => {
    const bar = document.querySelector('[data-summary-bar-toggle]');
    return { text: bar?.innerText ?? '', expanded: bar?.getAttribute('aria-expanded'), count: document.querySelectorAll('[data-summary-bar-toggle]').length };
  })()`);
  console.log("BAR_COLLAPSED", JSON.stringify(collapsed).slice(0, 300));
  assert.equal(collapsed.expanded, "false", "默认收起");
  assert.ok(/轮 \d|Turn \d/i.test(collapsed.text) && !collapsed.text.includes("Reply bar") && /Tools \d+/.test(collapsed.text), `轮号+属性无自标: ${collapsed.text}`);
  // ② 旧 TurnSummary 在常规轮不渲染
  assert.equal(await page.evaluate("document.querySelector('.turn-summary-card, [data-turn-summary-legacy]') !== null"), false, "旧 TurnSummary 常规轮不渲染");

  // ③ 点击展开：全宽面板 + TurnInteractions 原始请求体
  await page.evaluate("document.querySelector('[data-summary-bar-toggle]').click()");
  await page.waitFor("document.querySelector('[data-turn-process] .turn-process-item') !== null", { label: "过程回放条目", timeoutMs: 30_000 });
  const expanded = await page.evaluate(`(() => {
    const bar = document.querySelector('[data-summary-bar]');
    const panel = document.querySelector('[data-turn-process]');
    const barW = bar.getBoundingClientRect().width, panelW = panel.getBoundingClientRect().width;
    const container = bar.closest('[data-chat-scroll]') ?? panel.parentElement?.parentElement;
    const toggle = document.querySelector('[data-summary-bar-toggle]');
    return { expanded: toggle?.getAttribute('aria-expanded') ?? null, barW, panelW, fullish: panelW >= barW };
  })()`);
  console.log("BAR_EXPANDED", JSON.stringify(expanded));
  assert.equal(expanded.expanded, "true");
  assert.equal(expanded.fullish, true, "展开面板占满全宽（≥bar 宽）");

  // ④ sticky：展开态下滚动容器滚到远处，bar 仍在视口顶部附近
  const sticky = await page.evaluate(`(() => {
    const scroller = [...document.querySelectorAll('div')].find(d => d.contains(document.querySelector('[data-summary-bar]')) && getComputedStyle(d).overflowY === 'auto' && d.scrollHeight > d.clientHeight + 50);
    if (!scroller) return { found: false };
    const bar = document.querySelector('[data-summary-bar]');
    const before = bar.getBoundingClientRect().top;
    scroller.scrollTop = scroller.scrollHeight;
    const after = bar.getBoundingClientRect().top;
    return { found: true, before: Math.round(before), after: Math.round(after), stickyKept: Math.abs(after) < 200, scrolled: scroller.scrollTop > 0 };
  })()`);
  console.log("STICKY", JSON.stringify(sticky));
  assert.ok(sticky.found && sticky.scrolled && sticky.stickyKept, `sticky 验收: ${JSON.stringify(sticky)}`);

  // ⑤ 收起回文档流（先滚回顶部——虚拟渲染窗口外组件会卸载）
  await page.evaluate(`(() => {
    const scroller = [...document.querySelectorAll('div')].find(d => d.contains(document.querySelector('[data-summary-bar]')) && getComputedStyle(d).overflowY === 'auto');
    if (scroller) scroller.scrollTop = 0;
  })()`);
  await pause(400);
  await page.evaluate("document.querySelector('[data-summary-bar-toggle]').click()");
  await page.waitFor("document.querySelector('[data-turn-process]') === null", { label: "收起后过程面板移除" });
  console.log("COLLAPSE_DEBUG", await page.evaluate(`JSON.stringify({
    bars: document.querySelectorAll('[data-summary-bar]').length,
    toggles: document.querySelectorAll('[data-summary-bar-toggle]').length,
    expanded: document.querySelector('[data-summary-bar]')?.getAttribute('data-expanded') ?? null,
    inWindow: [...document.querySelectorAll('[data-summary-bar-toggle]')].map(b => b.getBoundingClientRect().top).slice(0, 3),
  })`));
  assert.equal(await page.evaluate("document.querySelector('[data-summary-bar]')?.getAttribute('data-expanded')"), "false");

  // ⑥ 390：无横向滚动
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await pause(400);
  assert.equal(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true, "390 无横向滚动");
});
