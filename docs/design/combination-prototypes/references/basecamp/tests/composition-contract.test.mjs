import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("embedded bootstrap preserves reference context and accepts parent routes", async () => {
  const source = await read("../src/main.jsx");
  assert.match(source, /dataset\.reference = "basecamp"/);
  assert.match(source, /dataset\.theme = query\.get\("theme"\) \|\| "source"/);
  assert.match(source, /event\.data\?\.type !== "chat:route"/);
  assert.match(source, /history\.pushState/);
  assert.match(source, /new PopStateEvent\("popstate"/);
  for (const key of ["composition", "embedded", "theme"]) assert.equal(source.includes(`"${key}"`), true);
});

test("the frozen Basecamp surface accepts the four composition themes without touching source mode", async () => {
  const [main, themes] = await Promise.all([
    read("../src/main.jsx"),
    read("../src/theme-overrides.css"),
  ]);
  assert.match(main, /import "\.\/styles\.css";\s*import "\.\/theme-overrides\.css";/);
  for (const theme of ["warm-room", "quiet-day", "graphite-ops", "common-thread"]) {
    assert.equal(themes.includes(`[data-theme="${theme}"]`), true, `missing ${theme}`);
  }
  assert.equal(themes.includes('[data-theme="source"]'), false);
  for (const invariant of ["layout", "content", "icons", "assets", "behavior"]) {
    assert.equal(themes.includes(invariant), true, `missing frozen-surface invariant: ${invariant}`);
  }
});

test("Linear-owned compositions delegate every Basecamp work route", async () => {
  const source = await read("../src/App.jsx");
  assert.match(source, /\["room-linear", "work-linear"\]/);
  assert.match(source, /route\.view === "todo"/);
  assert.match(source, /route\.toolId === "todos"/);
  assert.match(source, /route\.aggregateId === "my-tasks"/);
  assert.match(source, /return "work"/);
  assert.match(source, /postHostScene\(hostScene, completeRoute\)/);
  assert.match(source, /item\.category !== "Updates"/);
  assert.match(source, /\["Announcements", "Decisions"\]/);
});

test("combination routes use one Today and Calendar owner", async () => {
  const source = await read("../src/App.jsx");
  assert.match(source, /\["calendar", "my-events"\]/);
  assert.match(source, /route\.toolId === "schedule"/);
  assert.match(source, /route\.aggregateId === "do-today"/);
  assert.match(source, /return "calendar"/);
  assert.match(source, /return "today"/);
  assert.match(source, /\{ type: "chat:route", scene, url:/);
});

test("Basecamp assets are namespaced for the combination host", async () => {
  const [app, model] = await Promise.all([read("../src/App.jsx"), read("../src/basecampModel.js")]);
  assert.equal(app.includes('src="/assets/'), false);
  assert.equal(model.includes('"/assets/'), false);
  assert.match(app, /\/reference-assets\/basecamp\/marks\//);
  assert.match(model, /\/reference-assets\/basecamp\/avatars\//);
  assert.match(model, /\/reference-assets\/basecamp\/basecamp-tools\//);
});
