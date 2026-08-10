import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../src/theme-overrides.css", import.meta.url), "utf8");
const themeIds = ["warm-room", "quiet-day", "graphite-ops", "common-thread"];

test("theme overrides load after the untouched Linear stylesheet", () => {
  assert.ok(mainSource.indexOf('import "./styles.css"') < mainSource.indexOf('import "./theme-overrides.css"'));
  assert.equal(mainSource.match(/createRoot\(/g)?.length, 1);
});

test("all four unified themes are explicit while source has no override selector", () => {
  for (const id of themeIds) assert.match(themeSource, new RegExp(`data-theme=["']${id}["']`));
  assert.doesNotMatch(themeSource, /data-theme=["']source["']/);
  for (const color of ["#245a46", "#c96a49", "#123a6d", "#126fd3", "#e5a51a", "#17191c", "#5b5fc7", "#168aad", "#1f2b2c", "#3d6f60", "#c58a3a"]) {
    assert.match(themeSource, new RegExp(color, "i"));
  }
});

test("theme layer maps navigation, surfaces, controls, focus, radius, and shadow", () => {
  for (const token of ["--theme-canvas", "--theme-nav", "--theme-ink", "--theme-border", "--theme-primary", "--theme-radius", "--theme-shadow"]) {
    assert.match(themeSource, new RegExp(token));
  }
  assert.match(themeSource, /:focus-visible/);
  assert.match(themeSource, /\.sidebar/);
  assert.match(themeSource, /\.primary-action/);
  assert.match(themeSource, /\.peek-card/);
});
