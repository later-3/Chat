import { fixtures } from "../fixtures.js";

function eventRows() {
  return fixtures.events
    .map(
      (event) => `
        <article class="time-event ${event.kind}" data-object-id="${event.id}">
          <time class="time-label">${event.time}</time>
          <div class="time-track" aria-hidden="true"></div>
          <div class="event-body">
            <strong>${event.title}</strong>
            <p>${event.time}–${event.end} · ${event.meta}</p>
          </div>
        </article>`,
    )
    .join("");
}

function todayRow(item, location) {
  const moveLabel = location === "day" ? "移到今晚" : "移回白天";
  return `
    <li class="today-row" data-object-id="${item.objectId}" data-annotation-id="today.item.${item.id}">
      <span class="type-mark ${item.markClass}" aria-hidden="true">${item.mark}</span>
      <div>
        <div class="today-title">${item.title}</div>
        <div class="today-meta">${item.type} · ${item.source}</div>
      </div>
      <div class="today-actions">
        <button class="row-action" data-action="today-open" data-object-id="${item.objectId}">${item.action}</button>
        ${item.movable ? `<button class="row-action" data-action="toggle-evening" data-item-id="${item.id}" data-location="${location}">${moveLabel}</button>` : ""}
      </div>
    </li>`;
}

export function renderToday(state) {
  const moved = state === "evening-moved";
  const movedItem = fixtures.todayItems[0];
  const dayItems = moved ? fixtures.todayItems.slice(1) : fixtures.todayItems;
  const eveningItems = moved ? [movedItem, ...fixtures.eveningItems] : fixtures.eveningItems;

  return `
    <main class="page today-page">
      <div class="day-heading" data-annotation-id="today.heading">
        <div>
          <p class="page-kicker">Today · 2026 年 8 月 8 日 · 周六</p>
          <h1 class="page-title">今天留一点空白。</h1>
          <p class="page-lede">先看无法压缩的时间，再决定要承诺、判断或看护什么。Project 仍是它们的长期归属。</p>
        </div>
        <div class="day-meter" data-annotation-id="today.capacity">
          <div class="day-meter-label"><span>今日注意力</span><span>${moved ? "2 / 5" : "3 / 5"}</span></div>
          <div class="day-meter-track" aria-label="今日注意力使用 ${moved ? "40%" : "58%"}"><span style="width:${moved ? "40%" : "58%"}"></span></div>
        </div>
      </div>

      <section class="day-flow" aria-labelledby="calendar-title" data-annotation-id="today.calendar">
        <div class="section-heading"><h2 id="calendar-title">时间约束</h2><span>来自个人日历，只读</span></div>
        ${eventRows()}
      </section>

      <section class="today-section" aria-labelledby="day-items-title" data-annotation-id="today.daytime">
        <div class="section-heading"><div><h2 id="day-items-title">白天</h2><p>不同对象保留不同动作，不全部变成勾选框。</p></div><span>${dayItems.length} 项</span></div>
        <ul class="today-list">${dayItems.map((item) => todayRow(item, "day")).join("")}</ul>
      </section>

      <section class="today-section evening" aria-labelledby="evening-title" data-annotation-id="today.evening">
        <div class="section-heading"><div><h2 id="evening-title">今晚</h2><p>仍属于今天，但不与白天主序列争抢注意力。</p></div><span>${eveningItems.length} 项</span></div>
        <ul class="today-list">${eveningItems.map((item) => todayRow(item, "evening")).join("")}</ul>
      </section>

      ${
        moved
          ? `<div class="toast" role="status" aria-live="polite" data-annotation-id="today.undo-toast"><span>已把“${movedItem.title}”移到今晚</span><button class="undo-action" data-action="undo-evening">撤销</button></div>`
          : ""
      }
    </main>`;
}
