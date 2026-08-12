import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  finishReconciliation,
  getActionSet,
  initialFeedItems,
  selectFeedItems,
  transitionFeedItem,
} from "../src/agentFeedModel.js";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const modelSource = await readFile(new URL("../src/agentFeedModel.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");

test("typed supervision keeps outcome_unknown on reconciliation only", () => {
  const source = initialFeedItems.find((item) => item.type === "outcome_unknown");
  assert.deepEqual(getActionSet(source), ["reconcile"]);
  assert.equal(getActionSet(source).includes("retry"), false);

  const started = transitionFeedItem(initialFeedItems, source.id, "reconcile");
  assert.equal("snapshot" in started, false);
  assert.equal(started.items.find((item) => item.id === source.id).status, "reconciling");

  const finished = finishReconciliation(started.items, source.id);
  assert.equal(finished.find((item) => item.id === source.id).status, "completed");
});

test("feed remains a risk-first projection", () => {
  const needs = selectFeedItems(initialFeedItems, { tab: "needs" });
  assert.equal(needs[0].priority, "critical");
  assert.ok(needs.every((item) => item.status !== "completed"));
});

test("formal actions expose no generic Undo or local authoritative record", () => {
  assert.doesNotMatch(appSource, /\bUndo\b/);
  assert.doesNotMatch(modelSource, /restoreFeedItem|snapshot:\s*item/);
  assert.doesNotMatch(appSource, /function RelatedRecord/);
  assert.match(appSource, /type:\s*"chat:navigate"/);
  assert.match(appSource, /scene:\s*relatedSceneFor\(item\)/);
});

test("Insights is removed instead of retaining a second count source", () => {
  assert.doesNotMatch(appSource, /InsightPanel|recharts/);
  assert.doesNotMatch(modelSource, /insightsByPeriod/);
});

test("completed structured candidates render a read-only outcome", () => {
  assert.match(appSource, /className="candidate-readonly"/);
  assert.match(appSource, /This candidate is now a read-only task outcome\./);
});

test("mobile reuse closes overflow and interaction-size blockers", () => {
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(styles, /max-width:\s*100vw/);
  assert.match(styles, /button:not\(:disabled\)[^{]*[\s\S]{0,140}min-width:\s*44px;[\s\S]{0,80}min-height:\s*44px/);
});

test("motion and multi-page metadata keep host contracts", () => {
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /animation:\s*rotate[^;]*infinite/);
  assert.match(mainSource, /dataset\.reference = "agent-feed"/);
  assert.match(mainSource, /query\.get\("theme"\)/);
  assert.match(mainSource, /query\.get\("embedded"\) === "1"/);
});

test("portrait assets use the host-level namespaced path", () => {
  for (const name of ["agent-orbit", "agent-lantern", "agent-shield", "agent-compass"]) {
    assert.match(modelSource, new RegExp(`/assets/agent-feed/${name}\\.png`));
  }
});
