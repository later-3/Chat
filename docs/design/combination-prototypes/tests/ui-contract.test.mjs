import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const appSource = await readFile(new URL("src/App.jsx", root), "utf8");
const styles = await readFile(new URL("src/styles.css", root), "utf8");

test("three attention modes and their core object language are visible", () => {
  for (const term of [
    "Project Room",
    "Today Rhythm",
    "Evidence Workbench",
    "Stage",
    "Milestone",
    "Iteration",
    "Scope / Action",
    "Resource / Evidence",
    "Participants",
    "outcome_unknown",
  ]) {
    assert.match(appSource, new RegExp(term.replace("/", "\\/")));
  }
});

test("UI uses Phosphor icons and does not draw inline SVG or emoji assets", () => {
  assert.match(appSource, /@phosphor-icons\/react/);
  assert.doesNotMatch(appSource, /<svg|data:image|[\u{1F300}-\u{1FAFF}]/u);
});

test("semantic tokens, 44px targets, and reduced motion are explicit", () => {
  assert.match(styles, /--tap-size:\s*44px/);
  assert.match(styles, /var\(--tap-size\)/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /--agent-accent:/);
  assert.match(styles, /--status-danger:/);
});

test("visual language contains no gradients or heavy shadow effects", () => {
  assert.doesNotMatch(styles, /gradient\s*\(/i);
  assert.doesNotMatch(styles, /box-shadow\s*:/i);
  assert.doesNotMatch(styles, /filter:\s*drop-shadow/i);
});

test("responsive contract includes exact mobile preview and no blank core callbacks", () => {
  assert.match(styles, /391px/);
  assert.match(styles, /844px/);
  assert.match(styles, /overflow-x:\s*hidden/);
  assert.doesNotMatch(appSource, /on(?:Click|Change)=\{\(\) => \{\}\}/);
});
