/**
 * 从 SVG 源资产生成 PWA PNG 图标。
 * 使用本仓库已有的 Playwright Chromium 渲染，不引入图片处理依赖。
 * 用法：pnpm --filter @chat/web exec node scripts/generate-icons.mjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const targets = [
  { source: "icon.svg", output: "icon-192.png", size: 192 },
  { source: "icon.svg", output: "icon-512.png", size: 512 },
  { source: "icon-maskable.svg", output: "icon-maskable-512.png", size: 512 },
  { source: "icon.svg", output: "apple-touch-icon.png", size: 180 },
  { source: "icon.svg", output: "favicon-32.png", size: 32 },
];

async function renderPng(browser, svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
  await page.setContent(`<style>* { margin: 0; padding: 0; }</style>${sized}`);
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return buffer;
}

const browser = await chromium.launch();
try {
  await mkdir(iconsDir, { recursive: true });
  for (const target of targets) {
    const svg = await readFile(join(iconsDir, target.source), "utf8");
    const png = await renderPng(browser, svg, target.size);
    await writeFile(join(iconsDir, target.output), png);
    console.log(`generated ${target.output} (${target.size}x${target.size})`);
  }
} finally {
  await browser.close();
}
