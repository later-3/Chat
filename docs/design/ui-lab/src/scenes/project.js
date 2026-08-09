import { fixtures } from "../fixtures.js";

function statusChip(label, tone) {
  return `<span class="status-chip ${tone}">${label}</span>`;
}

function projectHeader(state) {
  const tabs = [
    ["overview", "概览"],
    ["work", "工作"],
    ["artifacts", "资料"],
  ];

  return `
    <div class="project-heading" data-annotation-id="project.heading">
      <div>
        <p class="page-kicker">Project Room · ${fixtures.project.phase}</p>
        <h1 class="page-title">${fixtures.project.shortName}</h1>
        <p class="page-lede">${fixtures.project.goal}</p>
      </div>
      <div class="project-meta">
        ${statusChip(fixtures.project.health, "success")}
        <span class="object-chip">${fixtures.project.updatedAt}</span>
      </div>
    </div>
    <nav class="room-tabs" aria-label="Project 区域" data-annotation-id="project.tabs">
      ${tabs
        .map(
          ([value, label]) => `
            <button class="tab-button ${state === value || (state === "work-detail" && value === "work") ? "active" : ""}"
              data-action="project-tab" data-state="${value}"
              ${state === value || (state === "work-detail" && value === "work") ? 'aria-current="page"' : ""}>
              ${label}
            </button>`,
        )
        .join("")}
    </nav>`;
}

function updateBlock() {
  return `
    <article class="update-block" data-annotation-id="project.latest-update">
      <header>
        <h3>${fixtures.update.title}</h3>
        <time>${fixtures.update.timestamp}</time>
      </header>
      <p>${fixtures.update.body}</p>
      <div class="update-byline">
        <span class="avatar a" aria-hidden="true">橘</span>
        <span>${fixtures.update.author} · ${fixtures.update.authorRole} · 有来源的人工更新</span>
      </div>
    </article>`;
}

function workRows() {
  return fixtures.works
    .map(
      (work) => `
        <li class="work-row" data-object-id="${work.id}">
          <div>
            <div class="work-title">${work.title}</div>
            <div class="work-meta">${work.meta} · ${work.owner}</div>
          </div>
          <div class="work-tail">
            ${statusChip(work.state, work.stateTone)}
            <button class="row-action" data-action="open-work" data-work-id="${work.id}">打开</button>
          </div>
        </li>`,
    )
    .join("");
}

function attentionBlock() {
  return `
    <section class="room-section" data-annotation-id="project.needs-attention">
      <div class="section-heading"><h2>需要我处理</h2><span>1 项</span></div>
      <div class="attention-item">
        <span class="handoff-chip">
          <span class="avatar-stack" aria-hidden="true"><span class="a">橘</span><span class="b">墨</span></span>
          ${fixtures.attention.handoff}
        </span>
        <strong>${fixtures.attention.title}</strong>
        <p>${fixtures.attention.explanation}</p>
        <div class="attention-actions">
          <button class="primary-action" data-action="open-decision-placeholder">查看决定</button>
          <button class="secondary-action" data-action="open-work" data-work-id="work_agent_activity">先看工作</button>
        </div>
      </div>
    </section>`;
}

function agentBlock() {
  return `
    <section class="room-section" data-annotation-id="project.agents">
      <div class="section-heading"><h2>参与 Agent</h2><span>3 位</span></div>
      <ul class="agent-list">
        ${fixtures.agents
          .map(
            (agent) => `
              <li class="agent-row">
                <div class="agent-identity">
                  <span class="avatar ${agent.className}" aria-hidden="true">${agent.mark}</span>
                  <div><strong>${agent.name}</strong><div class="agent-meta">${agent.role}</div></div>
                </div>
                <span class="count-badge">在场</span>
              </li>`,
          )
          .join("")}
      </ul>
    </section>`;
}

function overview() {
  return `
    <div class="room-sheet" data-annotation-id="project.room">
      <div class="room-grid">
        <div class="room-main">
          <section class="room-section">
            <div class="section-heading"><h2>最近一次可信更新</h2><span>不是自动摘要</span></div>
            ${updateBlock()}
          </section>
          <section class="room-section" data-annotation-id="project.current-work">
            <div class="section-heading">
              <h2>当前工作</h2>
              <button class="text-action" data-action="project-tab" data-state="work">查看全部</button>
            </div>
            <ul class="work-list">${workRows()}</ul>
          </section>
        </div>
        <aside class="room-aside">
          ${attentionBlock()}
          ${agentBlock()}
        </aside>
      </div>
    </div>`;
}

function workList() {
  return `
    <div class="room-sheet" data-annotation-id="project.work-list">
      <section class="room-section">
        <div class="section-heading"><div><h2>Project Work</h2><p>同一个 Work 在 Project 与 Today 中保持身份。</p></div><span>3 项</span></div>
        <ul class="work-list">${workRows()}</ul>
      </section>
    </div>`;
}

function artifacts() {
  return `
    <div class="room-sheet" data-annotation-id="project.artifacts">
      <section class="room-section">
        <div class="section-heading"><div><h2>项目资料</h2><p>Candidate 与 Formal 分开呈现。</p></div><span>2 项</span></div>
        <ul class="artifact-list">
          ${fixtures.artifacts
            .map(
              (artifact) => `
                <li class="artifact-row" data-object-id="${artifact.id}">
                  <div><strong>${artifact.title}</strong><div class="artifact-meta">${artifact.meta}</div></div>
                  ${statusChip(artifact.state, artifact.state === "正式" ? "success" : "warning")}
                </li>`,
            )
            .join("")}
        </ul>
      </section>
    </div>`;
}

function workDetail() {
  const work = fixtures.works[0];
  return `
    <article class="detail-sheet" data-annotation-id="project.work-detail" data-object-id="${work.id}">
      <header class="detail-head">
        <button class="text-action" data-action="project-tab" data-state="work">返回 Project Work</button>
        <p class="page-kicker">Work · ${fixtures.project.shortName}</p>
        <h2>${work.title}</h2>
        <p>定义哪些 Agent 变化需要用户介入，哪些只进入可追溯的项目叙事；不让 Feed 自己拥有事实。</p>
      </header>
      <section class="detail-section">
        <div class="detail-grid">
          <div class="detail-fact"><span>真实状态</span><strong>${work.state}</strong></div>
          <div class="detail-fact"><span>负责人</span><strong>${work.owner} · 项目推进</strong></div>
          <div class="detail-fact"><span>版本</span><strong>revision 3 · candidate</strong></div>
        </div>
      </section>
      <section class="detail-section">
        <div class="section-heading"><h2>当前判断</h2><span>有来源</span></div>
        <p>采用 Microsoft Agent Feed 的监督分流，但拒绝 Completed 大桶；采用 Linear Update 的署名叙事，但不使用互动热度排序。</p>
      </section>
      <section class="detail-section">
        <div class="section-heading"><h2>下一步</h2><span>UL2，不在本轮执行</span></div>
        <p>等 Project Room 与 Today 的结构通过后，再进入 Peek / Decision 与 Agent Activity 的真实交互验证。</p>
      </section>
    </article>`;
}

export function renderProject(state) {
  const body =
    state === "work"
      ? workList()
      : state === "work-detail"
        ? workDetail()
        : state === "artifacts"
          ? artifacts()
          : overview();

  return `<main class="page project-page">${projectHeader(state)}${body}</main>`;
}
