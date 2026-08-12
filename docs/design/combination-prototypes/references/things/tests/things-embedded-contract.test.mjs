import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Things preserves its action chain and declares a native phone layout", async () => {
  const [app, views, styles, main, themes] = await Promise.all([
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/ThingsViews.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/theme-overrides.css", import.meta.url), "utf8"),
  ]);

  for (const token of ["completeTask", "scheduleTask", "setTaskDeadline", "Undo"]) {
    assert.ok(app.includes(token), `missing Things action interaction: ${token}`);
  }
  for (const token of ["TodayView", "This Evening", "WhenPopover", "DeadlinePopover", "TaskDetail"]) {
    assert.ok(views.includes(token), `missing Things view: ${token}`);
  }
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.things-window\.compact-window/);
  assert.match(styles, /button,[\s\S]*input,[\s\S]*select \{[\s\S]*min-height: 44px/);
  assert.ok(main.includes('dataset.reference = "things"'));
  assert.ok(main.includes('dataset.theme = params.get("theme")'));
  assert.ok(main.includes('dataset.embedded = params.get("embedded") === "1"'));
  for (const eventId of ["event-focus", "event-client", "event-lunch", "event-critique", "event-call"]) {
    assert.ok(views.includes(`"${eventId}"`), `missing HEY Event projection: ${eventId}`);
  }
  assert.ok(views.includes('type: "chat:navigate"'));
  assert.ok(views.includes('scene: "calendar"'));
  assert.ok(views.includes("eventId: event.id"));
  assert.ok(main.includes('event.data?.type !== "chat:route"'));
  assert.ok(main.includes('new PopStateEvent("popstate"'));
  assert.ok(main.includes('new HashChangeEvent("hashchange"'));
  assert.match(main, /import "\.\/styles\.css";\s*import "\.\/theme-overrides\.css";/);
  for (const theme of ["warm-room", "quiet-day", "graphite-ops", "common-thread"]) {
    assert.ok(themes.includes(`[data-theme="${theme}"]`), `missing Things theme: ${theme}`);
  }
  assert.equal(themes.includes('[data-theme="source"]'), false);
});
