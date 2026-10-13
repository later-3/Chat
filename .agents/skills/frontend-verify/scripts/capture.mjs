/**
 * UI 采集（frontend-verify skill 的执行脚本，L3 层）：
 * 双视口截图 + console 错误/警告 + 页面异常 + 失败请求 + ≥400 响应。
 * 复用仓库 scripts/cdp.mjs（零 Playwright/Puppeteer 依赖，与 browser 测试同源）。
 *
 * 用法：
 *   node .agents/skills/frontend-verify/scripts/capture.mjs <URL> \
 *     [--wait "<页面就绪表达式>"] [--delay <ms>] [--viewport large|small|both] [--out <目录>]
 *
 * 输出：stdout 一行 JSON；PNG 默认写入 .data/ui-capture/<时间戳>/。
 * 退出码：0 = 采集成功（是否有问题由 Agent 依据 JSON 判断）；2 = 参数错误；1 = 采集失败。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchBrowser } from "../../../../scripts/cdp.mjs";

const VIEWPORTS = {
  large: { width: 1440, height: 900 },
  small: { width: 756, height: 469 }, // 前端规范第八步：小视口先测
};

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const url = argv.find((a) => !a.startsWith("--"));
const waitExpression = flag("wait", "document.readyState === 'complete'");
const delayMs = Number(flag("delay", "1500"));
const viewportMode = flag("viewport", "both");
if (!url || Number.isNaN(delayMs) || !["large", "small", "both"].includes(viewportMode)) {
  console.error("用法：capture.mjs <URL> [--wait <表达式>] [--delay <ms>] [--viewport large|small|both] [--out <目录>]");
  process.exit(2);
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.resolve(flag("out", path.join(repoRoot, ".data", "ui-capture", stamp)));
fs.mkdirSync(outDir, { recursive: true });

let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage(url);
  await page.send("Network.enable");
  await page.waitFor(waitExpression, { timeoutMs: 30_000, label: waitExpression });
  if (waitExpression !== "document.readyState === 'complete'") {
    await page.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "readyState" });
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const shots = {};
  const activeViewports = viewportMode === "both" ? ["large", "small"] : [viewportMode];
  for (const name of activeViewports) {
    const vp = VIEWPORTS[name];
    await page.send("Emulation.setDeviceMetricsOverride", { ...vp, deviceScaleFactor: 1, mobile: false });
    await new Promise((resolve) => setTimeout(resolve, 700)); // 等样式重算（C82：动画/布局要固定时长兜底）
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    shots[name] = file;
  }
  await page.send("Emulation.clearDeviceMetricsOverride");

  // 事件收集（Runtime/Network 自 newPage 起累积在 page.events）
  const requestUrls = new Map();
  const consoleErrors = [];
  const consoleWarnings = [];
  const exceptions = [];
  const failedRequests = [];
  const badResponses = [];
  const textOf = (arg) => {
    if ("value" in arg && arg.value !== undefined) return String(arg.value);
    return arg.description ?? arg.type ?? "";
  };
  for (const ev of page.events) {
    const p = ev.params ?? {};
    if (ev.method === "Network.requestWillBeSent") {
      requestUrls.set(p.requestId, p.request?.url ?? "");
    } else if (ev.method === "Runtime.consoleAPICalled") {
      const entry = {
        text: (p.args ?? []).map(textOf).join(" ").slice(0, 500),
        source: p.stackTrace?.callFrames?.[0]?.url ?? "",
        line: p.stackTrace?.callFrames?.[0]?.lineNumber ?? null,
      };
      if (p.type === "error" || p.type === "assert") consoleErrors.push(entry);
      else if (p.type === "warning") consoleWarnings.push(entry);
    } else if (ev.method === "Runtime.exceptionThrown") {
      exceptions.push({
        text: (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "").slice(0, 800),
        source: p.exceptionDetails?.url ?? "",
        line: p.exceptionDetails?.lineNumber ?? null,
      });
    } else if (ev.method === "Network.loadingFailed") {
      if (p.canceled) continue;
      failedRequests.push({ url: requestUrls.get(p.requestId) ?? "", error: p.errorText ?? "", type: p.type ?? "" });
    } else if (ev.method === "Network.responseReceived") {
      const status = p.response?.status ?? 0;
      if (status >= 400) badResponses.push({ status, url: p.response?.url ?? "" });
    }
  }

  const meta = await page.evaluate(
    "JSON.stringify({ title: document.title, href: location.href, readyState: document.readyState," +
      " horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth," +
      " bodyChildren: document.body ? document.body.childElementCount : -1 })",
  );

  console.log(JSON.stringify({
    url,
    ...JSON.parse(meta),
    viewports: activeViewports,
    screenshots: shots,
    consoleErrors,
    consoleWarnings: consoleWarnings.length,
    exceptions,
    failedRequests,
    badResponses,
    outDir,
  }, null, 2));
} catch (error) {
  console.error(`采集失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
