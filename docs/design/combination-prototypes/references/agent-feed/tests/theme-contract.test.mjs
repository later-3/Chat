import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../src/theme-overrides.css", import.meta.url), "utf8");
const themeIds = ["warm-room", "quiet-day", "graphite-ops", "common-thread"];

test("stable Agent Feed iframe accepts live theme routes without remounting", () => {
  assert.match(mainSource, /event\.data\?\.type !== "chat:route"/);
  assert.match(mainSource, /history\.pushState/);
  assert.match(mainSource, /applyReferenceContext\(\)/);
  assert.match(mainSource, /dataset\.theme = query\.get\("theme"\) \|\| "source"/);
  for (const key of ["composition", "embedded", "theme"]) assert.match(mainSource, new RegExp(`"${key}"`));
  assert.equal(mainSource.match(/createRoot\(/g)?.length, 1);
});

test("theme CSS loads after source and leaves source mode unmatched", () => {
  assert.ok(mainSource.indexOf('import "./styles.css"') < mainSource.indexOf('import "./theme-overrides.css"'));
  for (const id of themeIds) assert.match(themeSource, new RegExp(`data-theme=["']${id}["']`));
  assert.doesNotMatch(themeSource, /data-theme=["']source["']/);
});

test("Agent Feed themes cover prescribed tokens and semantic surfaces", () => {
  for (const color of ["#245a46", "#c96a49", "#123a6d", "#126fd3", "#e5a51a", "#17191c", "#5b5fc7", "#168aad", "#1f2b2c", "#3d6f60", "#c58a3a"]) {
    assert.match(themeSource, new RegExp(color, "i"));
  }
  for (const selector of [".global-bar", ".sitemap", ".feed-item", ".detail-pane", ".primary-button", ":focus-visible"]) {
    assert.ok(themeSource.includes(selector));
  }
});
