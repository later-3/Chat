/**
 * Chat 移动端适配（≤768px 视口）。
 *
 * 是什么：注入到 DSH index.html 的移动端样式与行为脚本——Composer 底行防重叠、
 * 侧边栏全屏抽屉+遮罩点按关闭、安全区与视口合同。
 *
 * 为什么：DSH rc.6 的布局是桌面优先（侧边栏在文档流内挤压主区、Composer 底行
 * 固定宽度溢出重叠）。冻结合同禁止修改上游源码；tapIndex 与静态路由是上游
 * 公开接缝，样式通过「固定版本的类名 + 语义 aria 钩子」叠加，升级上游时由
 * dsh-mobile-real E2E 作为合同测试兜底。
 *
 * 怎样失败：选择器全部只命中存在即生效、不存在则静默降级的规则；行为脚本
 * 只在 ≤768px 且找到侧边栏切换按钮时工作，任何一步失败都不会阻断主界面。
 */

export const MOBILE_CSS = `
/* Chat 移动端适配（≤768px）。只叠加布局，不改变任何功能语义。
 * 桌面布局不受影响；Access mode 权限选择器在手机上隐藏（桌面可用）。
 * DSH 在运行时向 head 追加 CSS-in-JS 内联 sheet（位于本 sheet 之后），
 * 同优先级后写胜出，因此这里的覆盖规则必须使用 !important 才能稳定生效。 */
@media (max-width: 768px) {
  /* Composer 底行：允许收缩，禁止重叠。 */
  [class*="uV2eYG_row"] {
    min-width: 0 !important;
    gap: 4px !important;
  }
  [class*="uV2eYG_tools"] {
    min-width: 0 !important;
  }
  /* Access mode 权限选择器：手机上隐藏（安全边界仍在后端，桌面可调）。 */
  [class*="uV2eYG_modes"] {
    display: none !important;
  }
  [class*="uV2eYG_trailing"] {
    flex: 0 1 auto !important;
    min-width: 0 !important;
    gap: 4px !important;
  }
  /* 模型选择器：文本截断。 */
  [class*="_7KE1Ra_root"] {
    min-width: 0 !important;
    max-width: 104px !important;
  }
  [class*="_7KE1Ra_trigger"] {
    min-width: 0 !important;
    max-width: 104px !important;
  }
  [class*="_7KE1Ra_triggerLabel"] {
    min-width: 0 !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
  /* Chat 自有工作流选择器：允许收缩并截断。 */
  .lifeos-workflow {
    flex: 0 1 auto !important;
    min-width: 0 !important;
  }
  .lifeos-workflow-toggle {
    min-width: 0 !important;
    max-width: 112px !important;
  }
  /* 侧边栏：桌面是文档流列（收起 56px / 展开 280px 挤压主区）。
     移动端展开态改为全屏抽屉浮层；遮罩由 mobile.js 注入。
     选择器收紧到 hHd-Xa 侧边栏组件自身的 root/collapsed 类，
     避免误匹配侧边栏内其他组件。 */
  [class*="sidebarCol"]:has([data-slot="sidebar"] > [class*="hHd-Xa_root"]:not([class*="hHd-Xa_collapsed"])) {
    position: fixed !important;
    inset: 0 auto 0 0 !important;
    width: min(84vw, 320px) !important;
    height: 100dvh !important;
    z-index: 60 !important;
    background: var(--dsw-alias-bg-primary, #ffffff) !important;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18) !important;
  }
  .chat-mobile-scrim {
    position: fixed !important;
    inset: 0 !important;
    z-index: 59 !important;
    background: rgba(0, 0, 0, 0.32) !important;
    border: 0 !important;
    padding: 0 !important;
    cursor: default !important;
  }
  /* Composer 与底部 UI 让开 iPhone Home 指示条。 */
  [class*="composerStack"] {
    padding-bottom: env(safe-area-inset-bottom, 0px) !important;
  }
  /* 触控目标：rail 图标至少 40px。 */
  [class*="sidebarCol"] button {
    min-height: 40px !important;
  }
}
`;

/**
 * 移动端行为脚本。职责只有一个：侧边栏展开时注入遮罩，点遮罩关闭抽屉。
 * 通过 aria-label 状态轮询/观察检测开合，不依赖 DSH 内部事件。
 */
export const MOBILE_SCRIPT = `
(() => {
  const media = window.matchMedia("(max-width: 768px)");
  let scrim = null;

  const findToggle = () =>
    document.querySelector('button[aria-label="Collapse sidebar"], button[aria-label="Open sidebar"]');
  const isOpen = () => document.querySelector('button[aria-label="Collapse sidebar"]') !== null;

  const sync = () => {
    if (!media.matches || !isOpen()) {
      if (scrim) {
        scrim.remove();
        scrim = null;
      }
      return;
    }
    if (scrim === null) {
      scrim = document.createElement("button");
      scrim.type = "button";
      scrim.className = "chat-mobile-scrim";
      scrim.setAttribute("aria-label", "关闭侧边栏");
      scrim.addEventListener("click", () => {
        const toggle = document.querySelector('button[aria-label="Collapse sidebar"]');
        if (toggle) toggle.click();
      });
      document.body.appendChild(scrim);
    }
  };

  const observer = new MutationObserver(sync);
  const start = () => {
    if (!document.body) return;
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "class"],
    });
    sync();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  media.addEventListener("change", sync);
})();
`.trimStart();

/** 注入标签：移动端样式与行为脚本（注册脚本由 PWA tap 负责）。 */
export const MOBILE_INDEX_TAGS = [
  '<link rel="stylesheet" href="/pwa/mobile.css" />',
  '<script defer src="/pwa/mobile.js"></script>',
].join("\n    ");

/**
 * 视口合同：viewport-fit=cover 让布局延伸到刘海区（配合 safe-area-inset），
 * interactive-widget=resizes-content 让软键盘弹出时缩小可视区域而不是推走 Composer。
 */
export const MOBILE_VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content";
