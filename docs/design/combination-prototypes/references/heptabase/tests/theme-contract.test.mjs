import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../src/theme-overrides.css", import.meta.url), "utf8");
const themeIds = ["warm-room", "quiet-day", "graphite-ops", "common-thread"];

test("stable Heptabase iframe applies host theme routes in place", () => {
  assert.match(mainSource, /event\.data\?\.type !== "chat:route"/);
  assert.match(mainSource, /history\.pushState/);
  assert.match(mainSource, /dataset\.theme = query\.get\("theme"\) \|\| "source"/);
  assert.equal(mainSource.match(/createRoot\(/g)?.length, 1);
});

test("theme CSS loads after source and source mode remains untouched", () => {
  assert.ok(mainSource.indexOf('import "./styles.css"') < mainSource.indexOf('import "./theme-overrides.css"'));
  for (const id of themeIds) assert.match(themeSource, new RegExp(`data-theme=["']${id}["']`));
  assert.doesNotMatch(themeSource, /data-theme=["']source["']/);
});

test("Whiteboard themes remap visual tokens without changing layout selectors", () => {
  for (const color of ["#245a46", "#c96a49", "#123a6d", "#126fd3", "#e5a51a", "#17191c", "#5b5fc7", "#168aad", "#1f2b2c", "#3d6f60", "#c58a3a"]) {
    assert.match(themeSource, new RegExp(color, "i"));
  }
  for (const token of ["--bg-app", "--bg-panel", "--text-primary", "--separator", "--focus", "--radius-control", "--shadow-popover"]) {
    assert.match(themeSource, new RegExp(token));
  }
  assert.match(themeSource, /\.canvas-shell/);
  assert.match(themeSource, /\.left-sidebar/);
  assert.match(themeSource, /\.right-panel/);
});
