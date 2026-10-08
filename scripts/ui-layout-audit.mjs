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
 *  5. 首屏覆盖：页面第一屏能否看到主要区域；
 *  6. 遮挡与顺序（案例 C68）：底栏/动作条是否落在滚动容器内部（会随内容滚动并盖住正文），
 *     以及标记为固定栏的元素是否与滚动区里的区域矩形相交。
 *  7. 同屏重复：可见的标题/说明文本是否在同一屏出现两次（信息重复）。
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
    const bars = Array.from(document.querySelectorAll('[data-la-actions], [data-ui-sticky-bar], footer'));
    const regions = Array.from(document.querySelectorAll('[data-la-home-region], [data-ui-dialog] section'));
    return JSON.stringify({
      viewport: { w: innerWidth, h: innerHeight },
      scrollContainers: scrollers,
      scrollContainerCount: scrollers.length,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clippedRegions: clipped.filter((item) => item.hiddenByAncestor || (!item.scrollableAncestor && item.scrollHeight > item.clientHeight + 4)),
      // 6. 遮挡：底栏/动作条必须在滚动容器之外，否则会随内容滚动并覆盖正文
      bottomBars: bars.map((bar) => {
        const rect = bar.getBoundingClientRect();
        let ancestor = bar.parentElement, insideScroll = false;
        while (ancestor) { if (/(auto|scroll)/.test(getComputedStyle(ancestor).overflowY)) { insideScroll = true; break; } ancestor = ancestor.parentElement; }
        const overlapped = insideScroll && regions.some((region) => { const r = region.getBoundingClientRect();
          return !(rect.bottom <= r.top || rect.top >= r.bottom || rect.right <= r.left || rect.left >= r.right); });
        return { element: short(bar), position: getComputedStyle(bar).position, insideScrollContainer: insideScroll, overlappedRegion: overlapped };
      }),
      // 7. 同屏重复的可见文本
      duplicatedVisibleText: (() => {
        const counts = {};
        Array.from(document.querySelectorAll('h1, h2, h3, h4, legend, p, strong')).forEach((el) => {
          const text = (el.textContent || '').trim();
          if (text.length < 8 || text.length > 120) return;
          if (el.getBoundingClientRect().width <= 1) return;   // 视觉隐藏（sr-only 通常 1px 宽）不算可见重复
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.clip !== 'auto' || cs.clipPath !== 'none') return;
          counts[text] = (counts[text] || 0) + 1;
        });
        return Object.entries(counts).filter(([, n]) => n > 1);
      })(),
    }, null, 1);
  })()`);
  console.log(report);
} finally {
  await browser.close();
}
