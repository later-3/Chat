import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const appSource = await readFile(new URL("src/App.jsx", root), "utf8");
const styles = await readFile(new URL("src/styles.css", root), "utf8");

test("host renders all six frozen sources instead of redrawing their product surfaces", async () => {
  assert.match(appSource, /Object\.values\(sourceCatalog\)\.map/);
  assert.match(appSource, /<iframe/);
  assert.match(appSource, /referenceUrl/);
  for (const sourceId of ["basecamp", "linear", "things", "hey", "agent-feed", "heptabase"]) {
    assert.match(await readFile(new URL("src/model.js", root), "utf8"), new RegExp(`\\b${sourceId.replace("-", "\\-")}\\b`));
    await access(new URL(`references/${sourceId}/index.html`, root));
  }
});

test("the only new interface is thin navigation and composition glue", () => {
  for (const term of ["CompositionChooser", "SceneNavigation", "ActiveContext", "ReferenceFrames"]) {
    assert.match(appSource, new RegExp(term));
  }
  assert.doesNotMatch(appSource, /function (ProjectCard|TaskRow|CalendarGrid|AgentTask|Whiteboard)/);
});

test("shell keeps accessible targets, responsive containment, and reduced motion", () => {
  assert.match(styles, /--tap-size:\s*44px/);
  assert.match(styles, /min-height:\s*var\(--tap-size\)/);
  assert.match(styles, /@media \(max-width:\s*720px\)/);
  assert.match(styles, /overflow-x:\s*auto/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("host uses the existing Phosphor icon library without inline drawings or emoji", () => {
  assert.match(appSource, /@phosphor-icons\/react/);
  assert.doesNotMatch(appSource, /<svg|data:image|[\u{1F300}-\u{1FAFF}]/u);
  assert.doesNotMatch(appSource, /on(?:Click|Change)=\{\(\) => \{\}\}/);
});
