import { fixtures } from "./fixtures.js";
import { navigate, normalizeRoute, readRoute } from "./router.js";
import { renderProject } from "./scenes/project.js";
import { renderToday } from "./scenes/today.js";

const app = document.querySelector("#app");

function sceneState(scene) {
  return scene === "project" ? "overview" : "default";
}

function globalRail(route) {
  return `
    <aside class="global-rail" aria-label="全局导航">
      <div class="wordmark" aria-label="Chat">Chat</div>
      <button class="rail-link" data-action="scene" data-scene="today" ${route.scene === "today" ? 'aria-current="page"' : ""}>今日</button>
      <button class="rail-link" data-action="scene" data-scene="project" ${route.scene === "project" ? 'aria-current="page"' : ""}>项目</button>
      <button class="rail-link" data-action="not-in-ul1">会话</button>
      <button class="rail-link" data-action="not-in-ul1">动态</button>
      <div class="rail-spacer"></div>
      <div class="lab-mark">UI Lab<br />仅示例数据</div>
    </aside>`;
}

function projectContext() {
  return `
    <aside class="context-rail" aria-label="Project 导航">
      <header class="context-head"><strong>项目<span>长期地点</span></strong></header>
      <div class="context-scroll">
        <div class="context-label">正在推进</div>
        <button class="context-row active" data-action="project-tab" data-state="overview">
          <span>${fixtures.project.shortName}<small>${fixtures.project.phase} · ${fixtures.project.health}</small></span>
          <span class="count-badge">1</span>
        </button>
        <button class="context-row" data-action="not-in-ul1"><span>AuditTraceAI<small>Context · 2 个阻塞</small></span></button>
        <div class="context-label">最近</div>
        <button class="context-row" data-action="not-in-ul1"><span>个人知识系统<small>昨天更新</small></span></button>
        <button class="context-row" data-action="not-in-ul1"><span>内容实验室<small>3 天前更新</small></span></button>
      </div>
      <footer class="context-foot"><strong>Project 不是筛选条件</strong>它拥有稳定目标、工作语境与可返回路径。</footer>
    </aside>`;
}

function todayContext() {
  return `
    <aside class="context-rail" aria-label="Today 导航">
      <header class="context-head"><strong>今天<span>个人注意力投影</span></strong></header>
      <div class="context-scroll">
        <div class="context-label">8 月</div>
        <button class="context-row active" data-action="scene" data-scene="today"><span>周六 · 8 日<small>2 个日历约束 · 3 项承诺</small></span><span class="count-badge">今</span></button>
        <button class="context-row" data-action="not-in-ul1"><span>周日 · 9 日<small>1 个日历约束</small></span></button>
        <button class="context-row" data-action="not-in-ul1"><span>周一 · 10 日<small>4 个日历约束</small></span></button>
        <div class="context-label">注意力范围</div>
        <button class="context-row" data-action="not-in-ul1"><span>本周稍后<small>4 项，不要求精确时间</small></span></button>
        <button class="context-row" data-action="not-in-ul1"><span>等待条件<small>2 项，不进入 Today</small></span></button>
      </div>
      <footer class="context-foot"><strong>Today 不拥有 Work</strong>移到今天或今晚，只改变你的注意力日期。</footer>
    </aside>`;
}

function appBar(route) {
  const themeLabels = {
    thread: "Thread Light",
    paper: "Paper",
    graphite: "Graphite Dark",
  };
  const sceneTitle = route.scene === "project" ? fixtures.project.shortName : "今天 · 8 月 8 日";

  return `
    <header class="appbar">
      <div class="breadcrumb"><span>UI Lab</span> / <strong>${sceneTitle}</strong></div>
      <div class="appbar-actions">
        <span class="fixture-chip">Fixture · 非真实服务</span>
        <label class="sr-only" for="theme-select">主题</label>
        <select class="theme-select" id="theme-select" data-action="theme" aria-label="切换主题">
          ${Object.entries(themeLabels)
            .map(
              ([value, label]) =>
                `<option value="${value}" ${route.theme === value ? "selected" : ""}>${label}</option>`,
            )
            .join("")}
        </select>
      </div>
    </header>`;
}

function mobileNav(route) {
  return `
    <nav class="mobile-nav" aria-label="移动端主导航">
      <button class="rail-link" data-action="scene" data-scene="today" ${route.scene === "today" ? 'aria-current="page"' : ""}>今日</button>
      <button class="rail-link" data-action="project-tab" data-state="overview" ${route.scene === "project" ? 'aria-current="page"' : ""}>项目</button>
      <button class="rail-link" data-action="not-in-ul1">会话</button>
    </nav>`;
}

function render() {
  const route = readRoute();
  document.documentElement.dataset.theme = route.theme;
  localStorage.setItem("chat-ui-lab-theme", route.theme);
  document.title = `Chat UI Lab · ${route.scene === "project" ? "Project" : "Today"}`;

  const scene = route.scene === "project" ? renderProject(route.state) : renderToday(route.state);
  app.innerHTML = `
    <div class="lab-shell" data-scene="${route.scene}" data-state="${route.state}" data-annotation-id="lab.shell">
      ${globalRail(route)}
      ${route.scene === "project" ? projectContext() : todayContext()}
      <section class="workspace">
        ${appBar(route)}
        <div class="workspace-scroll" id="workspace-scroll">${scene}</div>
      </section>
      ${mobileNav(route)}
    </div>`;

  const pageTitle = app.querySelector("h1");
  pageTitle?.setAttribute("tabindex", "-1");
}

function announce(message) {
  let region = document.querySelector("#lab-announcer");
  if (!region) {
    region = document.createElement("div");
    region.id = "lab-announcer";
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  region.textContent = message;
}

app.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const route = readRoute();
  const action = control.dataset.action;

  if (action === "scene") {
    const scene = control.dataset.scene;
    navigate({ scene, state: sceneState(scene) });
    return;
  }

  if (action === "project-tab") {
    navigate({ scene: "project", state: control.dataset.state });
    return;
  }

  if (action === "open-work") {
    navigate({ scene: "project", state: "work-detail" });
    return;
  }

  if (action === "toggle-evening") {
    const nextState = control.dataset.location === "day" ? "evening-moved" : "default";
    navigate({ scene: "today", state: nextState });
    return;
  }

  if (action === "undo-evening") {
    navigate({ scene: "today", state: "default" });
    announce("已撤销，事项回到白天");
    return;
  }

  if (action === "open-decision-placeholder") {
    announce("Decision 交互属于 UL2，本轮只确认入口和层级");
    control.textContent = "UL2 再验证";
    return;
  }

  if (action === "today-open") {
    announce("对象详情属于 UL2；当前保留同一对象身份与来源");
    control.textContent = "UL2 再展开";
    return;
  }

  if (action === "not-in-ul1") {
    announce("该区域不在 UL1 范围内");
    return;
  }

  if (action === "theme") {
    navigate({ theme: control.value, scene: route.scene, state: route.state }, { replace: true });
  }
});

app.addEventListener("change", (event) => {
  const control = event.target.closest('[data-action="theme"]');
  if (!control) return;
  const route = readRoute();
  navigate({ theme: control.value, scene: route.scene, state: route.state }, { replace: true });
});

window.addEventListener("popstate", render);
window.addEventListener("ui-lab-route", render);

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (
    event.target instanceof HTMLElement &&
    event.target.matches("input, select, textarea, [contenteditable]")
  )
    return;
  if (event.key.toLowerCase() === "t") navigate({ scene: "today", state: "default" });
  if (event.key.toLowerCase() === "p") navigate({ scene: "project", state: "overview" });
});

normalizeRoute();
render();
