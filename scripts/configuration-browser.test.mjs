import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { launchBrowser } from "./cdp.mjs";
import { configurationFixture } from "./configuration-browser-fixture.mjs";

test("configuration surfaces persist capabilities, refresh inspection and fit desktop/mobile", { timeout: 120_000 }, async t => {
  const f = await configurationFixture(t);
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage(`${f.base}/?view=settings&settings=personal`);
  const ready = (expression, options) => page.waitFor(`Boolean(${expression})`, options);
  const click = async (text, scope = "document") => {
    const query = `Array.from(${scope}.querySelectorAll('button,summary')).find(e => e.getClientRects().length && e.textContent.trim().startsWith(${JSON.stringify(text)}))`;
    await ready(query, { label: `visible action ${text}` });
    await page.evaluate(`${query}.click()`);
  };
  const fill = async (label, value) => {
    const query = `Array.from(document.querySelectorAll('input,textarea')).find(e => e.getClientRects().length && (e.closest('label')?.textContent.includes(${JSON.stringify(label)}) || document.getElementById(e.getAttribute('aria-labelledby'))?.textContent === ${JSON.stringify(label)}))`;
    await ready(query, { label });
    await page.evaluate(`${query}.focus(); ${query}.select()`);
    await page.send("Input.insertText", { text: value });
  };
  const waitEvent = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const event = page.events.find(predicate);
      if (event) return event.params;
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const screenshot = async name => {
    if (!process.env.CHAT_UI_EVIDENCE_DIR) return;
    await ready("document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity)");
    fs.mkdirSync(process.env.CHAT_UI_EVIDENCE_DIR, { recursive: true });
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.CHAT_UI_EVIDENCE_DIR, name + ".png"), Buffer.from(data, "base64"));
  };
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await page.send("Network.enable");
  // 七预设外观（2026-10-01 升级）：每个预设自带明暗模式与配色，点选即应用、彼此独立。
  await click("Appearance");
  const presetModes = { paper: "light", glacier: "light", peach: "light", instagram: "light", graphite: "dark", obsidian: "dark", dracula: "dark" };
  for (const [preset, mode] of Object.entries(presetModes)) {
    await page.evaluate(`document.getElementById('appearance-preset-${preset}').click()`);
    assert.deepEqual(
      await page.evaluate("({preset:document.documentElement.dataset.preset,dark:document.documentElement.classList.contains('dark'),checked:document.getElementById('appearance-preset-' + document.documentElement.dataset.preset)?.getAttribute('aria-checked')})"),
      { preset, dark: mode === "dark", checked: "true" });
  }
  // radiogroup 键盘可达：方向键同时移动选中与焦点。
  await page.evaluate("document.getElementById('appearance-preset-paper').focus()");
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await ready("document.documentElement.dataset.preset === 'glacier'");
  assert.equal(await page.evaluate("document.activeElement?.id"), "appearance-preset-glacier");
  // 效果开关与预设正交：透明度只在玻璃预设（glacier/obsidian）可用。
  const opaqueSwitch = "[...document.querySelectorAll('.appearance-effects input[role=switch]')].at(-1)";
  await page.evaluate("document.getElementById('appearance-preset-dracula').click()");
  await ready("document.documentElement.dataset.preset === 'dracula'");
  assert.equal(await page.evaluate(`${opaqueSwitch}.disabled`), true, "非玻璃预设的透明度开关应禁用");
  await page.evaluate("document.getElementById('appearance-preset-obsidian').click()");
  await ready("document.documentElement.dataset.preset === 'obsidian'");
  assert.equal(await page.evaluate(`${opaqueSwitch}.disabled`), false, "玻璃预设可切换透明度");
  await screenshot("appearance-preset-obsidian");
  // 刷新后恢复上次选择（v2 持久化）。
  await page.send("Page.navigate", { url: `${f.base}/?view=settings&settings=appearance` });
  await ready("document.getElementById('appearance-preset-obsidian')?.getAttribute('aria-checked') === 'true'");
  assert.equal(await page.evaluate("document.documentElement.dataset.preset"), "obsidian");
  assert.equal(await page.evaluate("document.documentElement.classList.contains('dark')"), true);
  // 回到浅色预设，避免影响后续媒体与截图断言。
  await page.evaluate("document.getElementById('appearance-preset-paper').click()");
  await ready("!document.documentElement.classList.contains('dark')");
  await click("Personal resources");
  await click("Models");
  await ready("document.querySelector('[role=dialog]')?.textContent.includes('Manual provider and model configuration')");
  assert.equal(await page.evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find(e=>e.textContent.trim()==='Import models…').disabled"), true);
  const longName = "A deliberately long model name for capability and responsive configuration regression";
  await click(longName);
  await ready("document.querySelector('[role=dialog] input[type=checkbox]')");
  assert.equal(await page.evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find(e=>e.textContent.trim()==='Test').disabled"), true);
  // Long names must stay within navigation, not overlap the form.
  assert.equal(await page.evaluate(`(() => {
    const nav = document.querySelector('[aria-label="Providers & models"]');
    const buttons = [...nav.querySelectorAll('button')];
    return buttons.every(button => button.getBoundingClientRect().right <= nav.getBoundingClientRect().right + 1);
  })()`), true);
  await page.evaluate("Array.from(document.querySelectorAll('label')).find(e => e.textContent.includes('Image input')).querySelector('input').click()");
  await click("Advanced settings", "document.querySelector('[role=dialog]')");
  await fill("Default sampling parameters (JSON)", "{");
  assert.equal(await page.evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find(e => e.textContent.trim() === 'Save').disabled"), true);
  await fill("Default sampling parameters (JSON)", '{"temperature":0.2,"top_p":0.8}');
  await fill("Model API URL override", "http://127.0.0.1:12345/v1");
  await click("Save", "document.querySelector('[role=dialog]')");
  await ready("Array.from(document.querySelectorAll('[role=dialog] button')).some(e => e.textContent.trim() === 'Saved')");
  const saved = JSON.parse(fs.readFileSync(f.modelPath, "utf8")).providers["p3-local"].models[0];
  assert.deepEqual(saved.input, ["text", "image"]);
  assert.deepEqual(saved.samplingParams, { temperature: 0.2, top_p: 0.8 });
  assert.equal(saved.baseUrl, "http://127.0.0.1:12345/v1");
  assert.equal(page.events.some(event => event.method === "Network.requestWillBeSent"
    && /\/api\/(auth\/|models-config\/(test|catalog|discover))/.test(event.params.request.url)), false);
  await screenshot("models-desktop");
  // 新外观是显式预设：系统偏好不再覆盖用户已选的外观（v1 迁移期除外）。
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await ready("document.documentElement.dataset.preset === 'paper' && !document.documentElement.classList.contains('dark')");
  await screenshot("models-dark");
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  for (const width of [768, 390]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true);
    await screenshot(`models-${width}`);
  }
  await page.evaluate("document.querySelector('[role=dialog] header button[aria-label=Close]').click()");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url: `${f.base}/?projectId=a&cwd=${encodeURIComponent(f.projects[0].cwd)}` });
  await ready("document.querySelector('button[aria-label=" + JSON.stringify("Configure workflow agents") + "]')");
  await page.evaluate("document.querySelector('button[aria-label=" + JSON.stringify("Configure workflow agents") + "]').click()");
  await ready("Array.from(document.querySelectorAll('[role=dialog] dl')).some(e=>e.textContent.includes('Supported'))");
  assert.equal(await page.evaluate("document.querySelector('[role=dialog]').classList.contains('surface-dialog')"), true);
  await screenshot("workflow-desktop");
  await click("Tools & resources");
  await ready("document.querySelector('[role=dialog] input[type=checkbox]')");
  // 三个 tab（模型与生成 / 指令与输出 / 工具与资源）的方向键循环，选中与焦点同步。
  await page.evaluate("document.querySelector('[role=dialog] [role=tab][aria-selected=true]').focus()");
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await ready("document.querySelector('[role=dialog] [role=tab][aria-selected=true]')?.textContent.includes('Model & generation')");
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  await ready("document.querySelector('[role=dialog] [role=tab][aria-selected=true]')?.textContent.includes('Tools & resources')");
  // 配置范围选择器与“查看有效配置”检查面板。
  await ready("document.querySelector('[role=dialog] select[aria-label=\"Configuration scope\"]') !== null");
  await page.evaluate("document.querySelector('[role=dialog] button[aria-label=\"View effective configuration\"]').click()");
  await ready("document.querySelector(\"[role=dialog] [aria-label='Effective configuration · inspection']\") !== null");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true);
  await screenshot("workflow-mobile");
  await page.send("Page.navigate", { url: f.friendUrl });
  await page.send("Network.enable");
  await ready("document.querySelector('.turn-written-resources button[title=\"index.md\"]')");
  const memoryRequestStart = page.events.length;
  await page.evaluate("document.querySelector('.turn-written-resources button[title=\"index.md\"]').click()");
  await ready("document.querySelector('[role=dialog]')?.textContent.includes('Private memory')");
  assert.equal(page.events.slice(memoryRequestStart).some(event => event.method === "Network.requestWillBeSent" && event.params.request.url.includes('/api/long-agents/friend/agent-memory?operation=read')), true, "memory receipt opens the owner-bound resource");
  assert.equal(page.events.slice(memoryRequestStart).some(event => event.method === "Network.requestWillBeSent" && /\/api\/files/.test(event.params.request.url)), false, "Agent memory never falls through to project files");
  await page.evaluate("document.querySelector('[role=dialog] header button[aria-label=Close]').click()");
  await ready("document.querySelector('button[aria-label=\"Open Friend settings\"]')");
  await page.evaluate("document.querySelector('button[aria-label=\"Open Friend settings\"]').click()");
  await ready("document.querySelector('[role=dialog] form')");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  assert.equal(await page.evaluate("document.querySelector('[role=dialog] input[type=radio]') === null"), true);
  assert.equal(await page.evaluate("Array.from(document.querySelectorAll('[role=dialog] details:not([open])')).every(e => e.getBoundingClientRect().height <= 60)"), true, "collapsed sections remain compact");
  await click("Effective assembly");
  await ready("document.querySelector('[role=dialog]')?.textContent.includes('agent_memory_write')");
  await fill("Chat display alias", "Nested editor draft");
  await click("Configure workflow");
  await ready("document.querySelectorAll('[role=dialog]').length === 2");
  await ready("Array.from(document.querySelectorAll('[role=dialog]')).at(-1)?.textContent.includes('Model parameters')");
  await click("Model parameters", "Array.from(document.querySelectorAll('[role=dialog]')).at(-1)");
  await ready("document.querySelectorAll('[role=dialog]').length === 3");
  await ready("Array.from(document.querySelectorAll('[role=dialog]')).at(-1)?.textContent.includes('Shared by every agent')");
  await page.evaluate("Array.from(Array.from(document.querySelectorAll('[role=dialog]')).at(-1).querySelectorAll('label')).find(e => e.textContent.includes('Image input')).querySelector('input').click()");
  await click("Save", "Array.from(document.querySelectorAll('[role=dialog]')).at(-1)");
  await ready("Array.from(document.querySelectorAll('[role=dialog]')).at(-1)?.textContent.includes('Saved')");
  await page.evaluate("Array.from(document.querySelectorAll('[role=dialog]')).at(-1).querySelector('header button[aria-label=Close]').click()");
  await ready("document.querySelectorAll('[role=dialog]').length === 2");
  await ready("Array.from(document.querySelectorAll('[role=dialog]')).at(-1)?.textContent.includes('Not supported')");
  await click("Tools & resources", "Array.from(document.querySelectorAll('[role=dialog]')).at(-1)");
  await page.evaluate("Array.from(Array.from(document.querySelectorAll('[role=dialog]')).at(-1).querySelectorAll('label')).find(e => e.querySelector('span > strong')?.textContent === 'agent_memory_write').querySelector('input').click()");
  await ready("Array.from(Array.from(document.querySelectorAll('[role=dialog]')).at(-1).querySelectorAll('label')).find(e => e.querySelector('span > strong')?.textContent === 'agent_memory_write')?.querySelector('input')?.checked === false");
  await page.evaluate("Array.from(document.querySelectorAll('[role=dialog]')).at(-1).querySelector('header button[aria-label=Close]').click()");
  await ready("document.querySelectorAll('[role=dialog]').length === 1");
  assert.equal(await page.evaluate("Array.from(document.querySelectorAll('[role=dialog] input')).some(e => e.value === 'Nested editor draft')"), true);
  await ready("(() => { const text = Array.from(document.querySelectorAll('[role=dialog] details')).find(e=>e.querySelector('summary')?.textContent==='Effective assembly')?.textContent; return text?.includes('agent_memory_read') && !text.includes('agent_memory_write'); })()");
  const savedAgent = await (await fetch(`${f.base}/api/long-agents/friend/config`)).json();
  assert.equal(savedAgent.agent.definition.tools.addresses.includes("system:tool/agent_memory_write"), false);
  await click("Save", "document.querySelector('[role=dialog] form')");
  await ready("document.querySelector('[role=dialog]')?.textContent.includes('Long Agent configuration saved.')");
  await fill("Chat display alias", "Unsaved preview");
  await click("Refresh", "document.querySelector('[role=dialog] header')");
  await ready("document.querySelector('[role=alertdialog]')");
  await click("Cancel", "document.querySelector('[role=alertdialog]')");
  assert.equal(await page.evaluate("Array.from(document.querySelectorAll('input')).some(e=>e.value==='Unsaved preview')"), true);
  await click("Discard changes", "document.querySelector('[role=dialog] form')");
  await click("Effective assembly");
  await page.evaluate("document.querySelector('[role=dialog] main').scrollTop = 0");
  await screenshot("friend-desktop");
  await page.evaluate("document.querySelector('[role=dialog] main').scrollTop = document.querySelector('[role=dialog] main').scrollHeight");
  await screenshot("friend-model-desktop");
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  // 显式预设优先于系统偏好（v1 迁移期除外）：系统切暗色不改变已选外观。
  await ready("document.documentElement.dataset.preset === 'paper' && !document.documentElement.classList.contains('dark')");
  await screenshot("friend-model-dark");
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.evaluate("document.querySelector('[role=dialog] main').scrollTop = 0");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true);
  assert.ok(await page.evaluate("document.querySelector('[role=dialog] header h1').getBoundingClientRect().width >= window.innerWidth - 110"), "mobile title retains readable width beside header actions");
  assert.ok(await page.evaluate("document.querySelector('[role=dialog] header').getBoundingClientRect().height < 180"), "header actions do not squeeze the mobile title into a tall column");
  await screenshot("friend-mobile");
  await click("Agent Memory");
  await ready("document.querySelector('[role=dialog]')?.textContent.includes('index.md')");
  await screenshot("friend-memory-mobile");

});
