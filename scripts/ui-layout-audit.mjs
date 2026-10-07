/**
 * UI 布局体检：用可量化指标发现“元素都在、但交互很糟”的问题（案例 C58）。
 *
 * 用法：node scripts/ui-layout-audit.mjs "<页面 URL>" ["<点击打开悬浮窗的选择器>"]
 *
 * 检查项：
 *  1. 滚动容器数量与层级（嵌套/局部滚动是反例）；
 *  2. 关键区域是否被裁切（clientHeight 明显小于内容高度，且祖先 overflow:hidden）；
 *  3. 横向溢出；
 *  4. 小视口（默认 756×469）下是否仍可用——大屏看不出问题，小屏立刻暴露；
 *  5. 首屏覆盖：页面第一屏能否看到主要区域。
 */
import { launchBrowser } from "./cdp.mjs";

const url = process.argv[2];
const openSelector = process.argv[3];
if (!url) {
  console.error("用法：node scripts/ui-layout-audit.mjs <URL> [打开悬浮窗的选择器]");
  process.exit(2);
}

const browser = await launchBrowser();
try {
  const page = await browser.newPage(url);
  await page.waitFor("document.querySelectorAll('button').length > 0", { timeoutMs: 30_000 });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 756, height: 469, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (openSelector !== undefined) {
    await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(openSelector)}); if (el) el.click(); })()`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const report = await page.evaluate(`(() => {
    const short = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').filter((c) => c && !c.startsWith('_')).slice(0, 2).join('.') : '');
    const scrollers = Array.from(document.querySelectorAll('*')).filter((el) => {
      const overflowY = getComputedStyle(el).overflowY;
      return /(auto|scroll)/.test(overflowY) && el.scrollHeight > el.clientHeight + 4;
    }).map((el) => ({ element: short(el), visible: el.clientHeight, content: el.scrollHeight }));
    // 被裁切的关键区域：内容高于可视，且最近的可滚动祖先不存在
    const clipped = Array.from(document.querySelectorAll('[data-la-home], [data-la-home-region], [role=tabpanel]')).map((el) => {
      let ancestor = el.parentElement, scrollableAncestor = false, hidden = false;
      while (ancestor) {
        const s = getComputedStyle(ancestor);
        if (/(auto|scroll)/.test(s.overflowY)) scrollableAncestor = true;
        if (s.overflowY === 'hidden' && ancestor.scrollHeight > ancestor.clientHeight + 4) hidden = true;
        ancestor = ancestor.parentElement;
      }
      return { element: short(el), clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollableAncestor, hiddenByAncestor: hidden };
    });
    return JSON.stringify({
      viewport: { w: innerWidth, h: innerHeight },
      scrollContainers: scrollers,
      scrollContainerCount: scrollers.length,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clippedRegions: clipped.filter((item) => item.hiddenByAncestor || (!item.scrollableAncestor && item.scrollHeight > item.clientHeight + 4)),
    }, null, 1);
  })()`);
  console.log(report);
} finally {
  await browser.close();
}
